import { CARD_A, CARD_B, card } from "@twofiat/client/fixtures";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createAccount } from "../src/accounts.ts";
import { createAdjustment } from "../src/adjustments.ts";
import { isGuard } from "../src/api/guards.ts";
import { createApp } from "../src/app.ts";
import { createSession, createUser, SESSION_COOKIE } from "../src/auth.ts";
import { createCategory, createRule } from "../src/categories.ts";
import { openDb } from "../src/db/db.ts";
import {
  activities,
  adjustments,
  cards,
  evaluations,
  feeSchedules,
  findings,
  grants,
} from "../src/db/schema.ts";
import { reevaluate } from "../src/reevaluate.ts";
import { Secrets } from "../src/secrets.ts";
import { SyncRunner } from "../src/sync.ts";
import { fake2fiat } from "./fake-2fiat.ts";
import { scenario } from "./scenario.ts";

const TOKEN = "token1abc123";
const NEW_TOKEN = "token1def456";
const ROLES = ["owner", "manager", "member", "cardManager", "cardMember"] as const;
type Role = (typeof ROLES)[number];

/** An app with an account of two cards, and a user for each kind of grant: those on a card are on card A's. */
async function world() {
  const db = openDb(":memory:");
  const secrets = new Secrets(Buffer.alloc(32, 7).toString("base64"));
  const rows = scenario();
  const twofiat = fake2fiat({
    cards: [card({ id: CARD_A, balance: 12.5 }), card({ id: CARD_B, balance: 100 })],
    transactions: [rows.authA, rows.feeA, rows.postA, rows.authB, rows.postB],
    orders: [rows.issue],
  });
  twofiat.state.validTokens = [TOKEN, NEW_TOKEN];
  const now = new Date("2026-10-20T12:00:00.000Z");
  const session = { fetch: twofiat.fetch, sleep: async () => {} };
  const runner = new SyncRunner({ db, secrets, session, now: () => now });
  const app = createApp({ db, secrets, runner, session, now: () => now });

  const userIds = Object.fromEntries(
    [...ROLES, "outsider"].map((name) => [name, createUser(db, name, "x")]),
  ) as Record<Role | "outsider", number>;
  const accountId = createAccount(db, secrets, { userId: userIds.owner, label: "main", token: TOKEN });
  await runner.sync(accountId, "manual");

  const byTwofiatId = (twofiatId: string) =>
    db
      .select()
      .from(cards)
      .where(and(eq(cards.accountId, accountId), eq(cards.twofiatId, twofiatId)))
      .get() as typeof cards.$inferSelect;
  const a = byTwofiatId(CARD_A);
  const b = byTwofiatId(CARD_B);

  db.insert(grants)
    .values([
      { accountId, userId: userIds.manager, role: "manager" },
      { accountId, userId: userIds.member, role: "member" },
      { accountId, logicalCardId: a.logicalCardId, userId: userIds.cardManager, role: "manager" },
      { accountId, logicalCardId: a.logicalCardId, userId: userIds.cardMember, role: "member" },
    ])
    .run();

  // Something of everything on both cards.
  const adjustment = (cardId: number) =>
    createAdjustment(db, accountId, cardId, {
      cents: 500,
      occurredAt: "2026-10-15T00:00:00.000Z",
      note: "by hand",
    }).id;
  const adjustmentA = adjustment(a.id);
  const adjustmentB = adjustment(b.id);
  reevaluate(db, accountId, now);
  const onCard = {
    activity: (cardId: number) => {
      const row = db
        .select({ id: activities.id })
        .from(activities)
        .where(and(eq(activities.cardId, cardId), eq(activities.kind, "purchase")))
        .get();
      if (!row) throw new Error("no purchase");
      return row.id;
    },
    finding: (cardId: number) => {
      const evaluation = db.select({ id: evaluations.id }).from(evaluations).get();
      if (!evaluation) throw new Error("no evaluation");
      return db
        .insert(findings)
        .values({
          cardId,
          kind: "balance-gap",
          fingerprint: "seeded",
          cents: 100,
          message: "a gap",
          activityIds: [],
          firstSeenEvaluationId: evaluation.id,
          lastSeenEvaluationId: evaluation.id,
        })
        .returning()
        .get().id;
    },
  };
  const category = createCategory(db, accountId, "Groceries").id;
  const rule = createRule(db, accountId, { categoryId: category, match: "contains", pattern: "shop" }).id;
  const schedule = db
    .insert(feeSchedules)
    .values({
      accountId,
      product: a.product,
      kind: "topup",
      rateBps: 650,
      note: "as charged",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    })
    .returning()
    .get().id;

  const cookies = Object.fromEntries(
    Object.entries(userIds).map(([name, id]) => [
      name,
      `${SESSION_COOKIE}=${createSession(db, id, now).token}`,
    ]),
  );
  const request = (user: Role | "outsider", method: string, path: string, body?: unknown) =>
    app.request(`/api/accounts/${accountId}${path}`, {
      method,
      headers: {
        origin: "http://localhost",
        cookie: cookies[user] ?? "",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    db,
    app,
    accountId,
    request,
    a,
    b,
    category,
    rule,
    schedule,
    adjustmentA,
    adjustmentB,
    activityA: onCard.activity(a.id),
    activityB: onCard.activity(b.id),
    findingA: onCard.finding(a.id),
    findingB: onCard.finding(b.id),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** A concrete request to a route, on card A or on card B. */
interface Target {
  path: string;
  body?: unknown;
}

interface RouteCase {
  /** The route as the router has it, under `/api/accounts/:accountId`. */
  route: string;
  note?: string;
  allowed: readonly Role[];
  on: (w: World, card: "a" | "b") => Target;
  /** Names a card in its path or body: the card roles' card is A, so on B they get what's expected of a stranger. */
  perCard?: boolean;
  /** What a card role gets on a card it can't see: 404 by default, or a 400 where a body names a missing activity. */
  unseenStatus?: number;
  /** An allowed request's status, when it isn't a 2xx because the world has nothing for it to do. */
  allowedStatus?: number;
}

const ANY: readonly Role[] = ROLES;
const ACCOUNT_ROLES: readonly Role[] = ["owner", "manager", "member"];
const WORKERS: readonly Role[] = ["owner", "manager", "cardManager"];
const MANAGERS: readonly Role[] = ["owner", "manager"];
const OWNER: readonly Role[] = ["owner"];

const lc = (w: World, on: "a" | "b") => w[on].logicalCardId;
const adjustmentBody = { cents: 100, occurredAt: "2026-10-16T00:00:00.000Z", note: "more" };

const CASES: RouteCase[] = [
  // The account
  { route: "GET /", allowed: ANY, on: () => ({ path: "" }) },
  { route: "PATCH /", allowed: OWNER, on: () => ({ path: "", body: { label: "new" } }) },
  {
    route: "POST /replacement",
    allowed: OWNER,
    on: () => ({ path: "/replacement", body: { token: NEW_TOKEN } }),
  },
  { route: "POST /syncs", allowed: WORKERS, on: () => ({ path: "/syncs" }) },
  { route: "GET /syncs", allowed: ANY, on: () => ({ path: "/syncs" }) },
  { route: "GET /syncs/:syncId", allowed: ANY, on: () => ({ path: "/syncs/1" }) },

  // Cards
  { route: "GET /cards", allowed: ANY, on: () => ({ path: "/cards" }) },
  { route: "GET /cards/:cardId", perCard: true, allowed: ANY, on: (w, c) => ({ path: `/cards/${w[c].id}` }) },
  {
    route: "PATCH /cards/:cardId",
    allowed: OWNER,
    on: (w) => ({ path: `/cards/${w.a.id}`, body: { logicalCardId: null } }),
  },
  {
    route: "PUT /cards/:cardId/opening-balance",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({ path: `/cards/${w[c].id}/opening-balance`, body: { cents: 100 } }),
  },
  {
    route: "DELETE /cards/:cardId/opening-balance",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({ path: `/cards/${w[c].id}/opening-balance` }),
  },
  { route: "GET /logical-cards", allowed: ANY, on: () => ({ path: "/logical-cards" }) },
  {
    route: "PATCH /logical-cards/:logicalCardId",
    note: "renaming",
    perCard: true,
    allowed: OWNER,
    on: (w, c) => ({ path: `/logical-cards/${lc(w, c)}`, body: { name: "new" } }),
  },
  {
    route: "PATCH /logical-cards/:logicalCardId",
    note: "setting the current card",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({ path: `/logical-cards/${lc(w, c)}`, body: { currentCardId: w[c].id } }),
  },
  {
    route: "GET /logical-cards/:logicalCardId/balance-history",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/logical-cards/${lc(w, c)}/balance-history` }),
  },
  {
    route: "GET /logical-cards/:logicalCardId/cash-flow",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/logical-cards/${lc(w, c)}/cash-flow` }),
  },
  {
    route: "GET /logical-cards/:logicalCardId/fees",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/logical-cards/${lc(w, c)}/fees` }),
  },
  { route: "GET /snapshots", allowed: ANY, on: () => ({ path: "/snapshots" }) },

  // Activities
  { route: "GET /activities", allowed: ANY, on: () => ({ path: "/activities" }) },
  {
    route: "GET /activities/:activityId",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/activities/${c === "a" ? w.activityA : w.activityB}` }),
  },
  {
    route: "GET /activities/:activityId/same-merchant",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/activities/${c === "a" ? w.activityA : w.activityB}/same-merchant` }),
  },
  {
    route: "PATCH /activities/:activityId/annotation",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({
      path: `/activities/${c === "a" ? w.activityA : w.activityB}/annotation`,
      body: { categoryId: w.category, note: "hello" },
    }),
  },
  {
    route: "POST /activities/categorize",
    perCard: true,
    unseenStatus: 400,
    allowed: WORKERS,
    on: (w, c) => ({
      path: "/activities/categorize",
      body: { activityIds: [c === "a" ? w.activityA : w.activityB], categoryId: w.category },
    }),
  },

  // Categories and rules
  { route: "GET /categories", allowed: ANY, on: () => ({ path: "/categories" }) },
  {
    route: "POST /categories",
    allowed: MANAGERS,
    on: () => ({ path: "/categories", body: { name: "New" } }),
  },
  {
    route: "PATCH /categories/:categoryId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/categories/${w.category}`, body: { name: "Food" } }),
  },
  {
    route: "DELETE /categories/:categoryId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/categories/${w.category}` }),
  },
  { route: "GET /categories/rules", allowed: ACCOUNT_ROLES, on: () => ({ path: "/categories/rules" }) },
  {
    route: "POST /categories/rules",
    allowed: MANAGERS,
    on: (w) => ({
      path: "/categories/rules",
      body: { categoryId: w.category, match: "contains", pattern: "cafe" },
    }),
  },
  {
    route: "GET /categories/rules/preview",
    allowed: ACCOUNT_ROLES,
    on: () => ({ path: "/categories/rules/preview?match=contains&pattern=cafe" }),
  },
  {
    route: "PUT /categories/rules/order",
    allowed: MANAGERS,
    on: (w) => ({ path: "/categories/rules/order", body: { ids: [w.rule] } }),
  },
  {
    route: "GET /categories/rules/:ruleId/matches",
    allowed: ACCOUNT_ROLES,
    on: (w) => ({ path: `/categories/rules/${w.rule}/matches` }),
  },
  {
    route: "POST /categories/rules/:ruleId/apply",
    allowed: MANAGERS,
    on: (w) => ({ path: `/categories/rules/${w.rule}/apply` }),
  },
  {
    route: "PATCH /categories/rules/:ruleId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/categories/rules/${w.rule}`, body: { pattern: "cafe" } }),
  },
  {
    route: "DELETE /categories/rules/:ruleId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/categories/rules/${w.rule}` }),
  },

  // Findings
  { route: "GET /findings", allowed: ANY, on: () => ({ path: "/findings" }) },
  {
    route: "GET /findings/:findingId",
    perCard: true,
    allowed: ANY,
    on: (w, c) => ({ path: `/findings/${c === "a" ? w.findingA : w.findingB}` }),
  },
  {
    route: "PATCH /findings/:findingId",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({
      path: `/findings/${c === "a" ? w.findingA : w.findingB}`,
      body: { explanation: "because" },
    }),
  },

  // Adjustments
  { route: "GET /adjustments", allowed: ANY, on: () => ({ path: "/adjustments" }) },
  {
    route: "POST /adjustments",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({ path: "/adjustments", body: { ...adjustmentBody, cardId: w[c].id } }),
  },
  {
    route: "PATCH /adjustments/:adjustmentId",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({
      path: `/adjustments/${c === "a" ? w.adjustmentA : w.adjustmentB}`,
      body: { note: "changed" },
    }),
  },
  {
    route: "DELETE /adjustments/:adjustmentId",
    perCard: true,
    allowed: WORKERS,
    on: (w, c) => ({ path: `/adjustments/${c === "a" ? w.adjustmentA : w.adjustmentB}` }),
  },

  // Fee schedules
  { route: "GET /fee-schedules", allowed: ANY, on: () => ({ path: "/fee-schedules" }) },
  {
    route: "GET /fee-schedules/suggestion",
    allowed: MANAGERS,
    allowedStatus: 409, // Card A's fee row is a transaction fee, so there's nothing to suggest for top-ups.
    on: (w) => ({ path: `/fee-schedules/suggestion?cardId=${w.a.id}&kind=topup` }),
  },
  {
    route: "POST /fee-schedules",
    allowed: MANAGERS,
    on: (w) => ({
      path: "/fee-schedules",
      body: {
        product: w.a.product,
        kind: "topup",
        rateBps: 600,
        effectiveFrom: "2026-02-01T00:00:00.000Z",
        note: "new",
      },
    }),
  },
  {
    route: "PATCH /fee-schedules/:scheduleId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/fee-schedules/${w.schedule}`, body: { rateBps: 600 } }),
  },
  {
    route: "DELETE /fee-schedules/:scheduleId",
    allowed: MANAGERS,
    on: (w) => ({ path: `/fee-schedules/${w.schedule}` }),
  },
];

const label = (c: RouteCase) => (c.note ? `${c.route} (${c.note})` : c.route);
const methodOf = (c: RouteCase) => c.route.split(" ")[0] as string;

describe("every account route", () => {
  /** The account routes as the router has them: each method and path, with its handlers. */
  async function accountRoutes() {
    const { app } = await world();
    const prefix = "/api/accounts/:accountId";
    const routes = new Map<string, unknown[]>();
    for (const { method, path, handler } of app.routes) {
      if (method === "ALL" || (path !== prefix && !path.startsWith(`${prefix}/`))) continue;
      const key = `${method} ${path.slice(prefix.length) || "/"}`;
      routes.set(key, [...(routes.get(key) ?? []), handler]);
    }
    return routes;
  }

  test("starts with an access guard", async () => {
    const unguarded = [...(await accountRoutes())].filter(([, handlers]) => !isGuard(handlers[0]));
    expect(unguarded.map(([route]) => route)).toEqual([]);
  });

  test("is in this test's table", async () => {
    const listed = [...new Set(CASES.map((c) => c.route))].toSorted();
    expect(listed).toEqual([...(await accountRoutes()).keys()].toSorted());
  });
});

describe.each(ROLES)("as %s", (role) => {
  test.each(CASES.map((c) => [label(c), c] as const))("%s", async (_, routeCase) => {
    const w = await world();
    const { path, body } = routeCase.on(w, "a");
    const res = await w.request(role, methodOf(routeCase), path, body);
    if (routeCase.allowed.includes(role)) {
      if (routeCase.allowedStatus !== undefined) expect(res.status).toBe(routeCase.allowedStatus);
      else expect(res.status, await res.clone().text()).toBeLessThan(300);
    } else {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
  });
});

describe.each(["cardManager", "cardMember"] as const)("as %s, on a card without a grant", (role) => {
  test.each(CASES.filter((c) => c.perCard).map((c) => [label(c), c] as const))(
    "%s is as if it weren't there",
    async (_, routeCase) => {
      const w = await world();
      const { path, body } = routeCase.on(w, "b");
      const res = await w.request(role, methodOf(routeCase), path, body);
      // A card member can't annotate or adjust anywhere, which is a 403 before the card is looked at.
      const beforeLookingAtCard =
        role === "cardMember" &&
        ["POST /activities/categorize", "POST /adjustments"].includes(routeCase.route);
      expect(res.status).toBe(beforeLookingAtCard ? 403 : (routeCase.unseenStatus ?? 404));
    },
  );
});

describe("as someone with no role on the account", () => {
  test.each(CASES.map((c) => [label(c), c] as const))("%s is not found", async (_, routeCase) => {
    const w = await world();
    const { path, body } = routeCase.on(w, "a");
    const res = await w.request("outsider", methodOf(routeCase), path, body);
    expect(res.status).toBe(404);
  });
});

describe("refused requests change nothing", () => {
  test("a card owner can't reach another card's adjustment or category rules", async () => {
    const w = await world();
    await w.request("cardManager", "DELETE", `/adjustments/${w.adjustmentB}`);
    await w.request("cardManager", "DELETE", `/categories/${w.category}`);
    const left = w.db.select().from(adjustments).where(eq(adjustments.id, w.adjustmentB)).get();
    expect(left).toBeDefined();
    expect((await w.request("owner", "GET", `/categories/rules/${w.rule}/matches`)).status).toBe(200);
  });

  test("categorising several activities is refused whole if one is on another card", async () => {
    const w = await world();
    const res = await w.request("cardManager", "POST", "/activities/categorize", {
      activityIds: [w.activityA, w.activityB],
      categoryId: w.category,
    });
    expect(res.status).toBe(400);
    const detail = await w.request("owner", "GET", `/activities/${w.activityA}`);
    expect(await detail.json()).toMatchObject({ categoryId: null });
  });

  test("renaming and setting the current card at once needs both rights", async () => {
    const w = await world();
    const res = await w.request("cardManager", "PATCH", `/logical-cards/${w.a.logicalCardId}`, {
      name: "new",
      currentCardId: w.a.id,
    });
    expect(res.status).toBe(403);
  });
});

describe("roles add up on real requests", () => {
  test("an account member who manages one card can change that card, and only see the other", async () => {
    const w = await world();
    w.db
      .insert(grants)
      .values({
        accountId: w.accountId,
        logicalCardId: w.a.logicalCardId,
        userId: createdMember(w),
        role: "manager",
      })
      .run();
    const on = (activityId: number) =>
      w.request("member", "PATCH", `/activities/${activityId}/annotation`, { note: "hello" });
    expect((await on(w.activityA)).status).toBe(200);
    expect((await on(w.activityB)).status).toBe(403);
  });

  test("removing a grant applies to the very next request, in the same session", async () => {
    const w = await world();
    expect((await w.request("member", "GET", "")).status).toBe(200);
    w.db
      .delete(grants)
      .where(eq(grants.userId, createdMember(w)))
      .run();
    expect((await w.request("member", "GET", "")).status).toBe(404);
  });
});

function createdMember(w: World): number {
  const grant = w.db
    .select()
    .from(grants)
    .where(and(eq(grants.accountId, w.accountId), isNull(grants.logicalCardId), eq(grants.role, "member")))
    .get();
  if (!grant) throw new Error("no member");
  return grant.userId;
}
