import { authorization, CARD_A, CARD_B, card, topupRow, withdraw } from "@twofiat/client/fixtures";
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
  logicalCards,
} from "../src/db/schema.ts";
import { createInvite } from "../src/invites.ts";
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
    transactions: [
      rows.authA,
      rows.feeA,
      rows.postA,
      rows.authB,
      rows.postB,
      // The same merchant as card A's purchase, and a transfer from A to B.
      authorization({
        card: CARD_B,
        at: "2026-10-13T08:00:00.000Z",
        amount: "-7.00",
        description: "SHOP SPRINGFIELD USA",
      }),
      withdraw({ card: CARD_A, at: "2026-10-18T09:00:00.000Z", amount: "1.00" }),
      topupRow({ card: CARD_B, at: "2026-10-18T09:00:01.000Z", amount: "+1.00" }),
    ],
    orders: [rows.issue],
  });
  twofiat.state.validTokens = [TOKEN, NEW_TOKEN];
  const now = new Date("2026-10-20T12:00:00.000Z");
  const session = { fetch: twofiat.fetch, sleep: async () => {} };
  const runner = new SyncRunner({ db, secrets, session, now: () => now });
  const app = createApp({ db, secrets, runner, session, now: () => now });

  const userIds = Object.fromEntries(
    [...ROLES, "outsider", "coOwner"].map((name) => [name, createUser(db, name, "x")]),
  ) as Record<Role | "outsider" | "coOwner", number>;
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
      { accountId, userId: userIds.coOwner, role: "owner" },
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
  const request = (user: Role | "outsider" | "coOwner", method: string, path: string, body?: unknown) =>
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
    cookies,
    secrets,
    userIds,
    grantOf: (user: Role | "coOwner", logicalCardId: number | null = null) => {
      const scope =
        logicalCardId === null ? isNull(grants.logicalCardId) : eq(grants.logicalCardId, logicalCardId);
      const grant = db
        .select()
        .from(grants)
        .where(and(eq(grants.accountId, accountId), eq(grants.userId, userIds[user]), scope))
        .get();
      if (!grant) throw new Error(`no grant for ${user}`);
      return grant.id;
    },
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

  // Grants
  { route: "GET /grants", allowed: OWNER, on: () => ({ path: "/grants" }) },
  {
    route: "POST /grants",
    allowed: OWNER,
    on: () => ({ path: "/grants", body: { username: "outsider", logicalCardId: null, role: "member" } }),
  },
  { route: "DELETE /grants/mine", allowed: ANY, on: () => ({ path: "/grants/mine" }) },
  {
    route: "PATCH /grants/:grantId",
    allowed: OWNER,
    on: (w) => ({ path: `/grants/${w.grantOf("member")}`, body: { role: "manager" } }),
  },
  {
    route: "DELETE /grants/:grantId",
    allowed: OWNER,
    on: (w) => ({ path: `/grants/${w.grantOf("member")}` }),
  },
  {
    route: "POST /invites",
    allowed: OWNER,
    on: () => ({ path: "/invites", body: { username: "invited", logicalCardId: null, role: "member" } }),
  },
  {
    route: "POST /invites/:userId",
    allowed: OWNER,
    on: (w) => {
      const { grantId } = createInvite(
        w.db,
        w.accountId,
        { username: "pending", logicalCardId: null, role: "member" },
        new Date("2026-10-20T12:00:00.000Z"),
      );
      const grant = w.db.select().from(grants).where(eq(grants.id, grantId)).get();
      return { path: `/invites/${grant?.userId}` };
    },
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

describe("what a user with a grant on one card gets from account-wide routes", () => {
  const json = async <T>(res: Response) => {
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  type WithCard = { cardId: number };

  describe.each(["cardManager", "cardMember"] as const)("as %s", (role) => {
    test("cards and logical cards are only theirs", async () => {
      const w = await world();
      const list = await json<{ id: number }[]>(await w.request(role, "GET", "/cards"));
      expect(list.map((c) => c.id)).toEqual([w.a.id]);
      const logical = await json<{ id: number; cardIds: number[] }[]>(
        await w.request(role, "GET", "/logical-cards"),
      );
      expect(logical).toMatchObject([{ id: w.a.logicalCardId, cardIds: [w.a.id] }]);
    });

    test.each(["/activities?limit=100", "/adjustments", "/snapshots"])(
      "%s only holds their card's rows",
      async (path) => {
        const w = await world();
        const body = await json<WithCard[] | { items: WithCard[] }>(await w.request(role, "GET", path));
        const rows = Array.isArray(body) ? body : body.items;
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.cardId))).toEqual(new Set([w.a.id]));
      },
    );

    test("findings are only their card's, whichever status they ask for", async () => {
      const w = await world();
      const rows = await json<{ id: number }[]>(await w.request(role, "GET", "/findings?status=all"));
      expect(rows.map((f) => f.id)).toContain(w.findingA);
      expect(rows.map((f) => f.id)).not.toContain(w.findingB);
    });

    test.each([
      (w: World) => `/activities?cardId=${w.b.id}`,
      (w: World) => `/activities?logicalCardId=${w.b.logicalCardId}`,
      (w: World) => `/activities?findingId=${w.findingB}`,
    ])("asking for the other card's activities finds nothing (%#)", async (path) => {
      const w = await world();
      const body = await json<{ items: unknown[] }>(await w.request(role, "GET", path(w)));
      expect(body.items).toEqual([]);
    });

    test.each([
      (w: World) => `/adjustments?cardId=${w.b.id}`,
      (w: World) => `/adjustments?logicalCardId=${w.b.logicalCardId}`,
      (w: World) => `/snapshots?cardId=${w.b.id}`,
      (w: World) => `/snapshots?logicalCardId=${w.b.logicalCardId}`,
      (w: World) => `/findings?status=all&cardId=${w.b.id}`,
      (w: World) => `/findings?status=all&logicalCardId=${w.b.logicalCardId}`,
    ])("asking for the other card's rows finds nothing (%#)", async (path) => {
      const w = await world();
      expect(await json<unknown[]>(await w.request(role, "GET", path(w)))).toEqual([]);
    });

    test("searching doesn't reach the other card", async () => {
      const w = await world();
      const body = await json<{ items: unknown[] }>(await w.request(role, "GET", "/activities?q=cafe"));
      expect(body.items).toEqual([]);
    });

    test("the same-merchant lookup stays on their card", async () => {
      const w = await world();
      const path = `/activities/${w.activityA}/same-merchant`;
      const theirs = await json<{ activityIds: number[] }>(await w.request(role, "GET", path));
      const everyone = await json<{ activityIds: number[] }>(await w.request("owner", "GET", path));
      expect(everyone.activityIds.length).toBeGreaterThan(0);
      expect(theirs.activityIds).toEqual([]);
    });

    test("categories have names and colours, but no account-wide counts", async () => {
      const w = await world();
      const list = await json<object[]>(await w.request(role, "GET", "/categories"));
      expect(list).toEqual([
        expect.objectContaining({ name: "Groceries", activityCount: null, ruleCount: null }),
      ]);
    });

    test("fee schedules are only for their cards' products", async () => {
      const w = await world();
      w.db.update(cards).set({ product: "other" }).where(eq(cards.id, w.b.id)).run();
      w.db
        .insert(feeSchedules)
        .values({
          accountId: w.accountId,
          product: "other",
          kind: "topup",
          rateBps: 100,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          note: "theirs",
        })
        .run();
      const list = await json<{ id: number }[]>(await w.request(role, "GET", "/fee-schedules"));
      expect(list.map((s) => s.id)).toEqual([w.schedule]);
    });

    test("a sync shows its status and times, without what it did", async () => {
      const w = await world();
      const hidden = {
        failedStage: null,
        error: null,
        rowsNew: null,
        rowsUpdated: null,
        rowsMissing: null,
        windowFrom: null,
        windowTo: null,
        ordersFrom: null,
        normalizedFrom: null,
      };
      const list = await json<object[]>(await w.request(role, "GET", "/syncs"));
      expect(list[0]).toMatchObject({ status: "ok", ...hidden });
      expect(await json<object>(await w.request(role, "GET", "/syncs/1"))).toMatchObject(hidden);
      const account = await json<{ lastSync: object }>(await w.request(role, "GET", ""));
      expect(account.lastSync).toMatchObject(hidden);

      const accounts = await w.app.request("/api/accounts", {
        headers: { origin: "http://localhost", cookie: w.cookies[role] ?? "" },
      });
      expect(await json<{ lastSync: object }[]>(accounts)).toMatchObject([{ lastSync: hidden }]);
    });

    test("a transfer names the other card, and nothing else about it", async () => {
      const w = await world();
      w.db.update(logicalCards).set({ name: "Family" }).where(eq(logicalCards.id, w.b.logicalCardId)).run();
      const body = await json<{ items: object[] }>(
        await w.request(role, "GET", "/activities?kind=transfer_out"),
      );
      expect(body.items).toEqual([expect.objectContaining({ counterpartName: "Family" })]);
      const detail = (
        await json<{ items: { id: number }[] }>(await w.request(role, "GET", "/activities?kind=transfer_out"))
      ).items[0];
      const shown = JSON.stringify(
        await json<object>(await w.request(role, "GET", `/activities/${detail?.id}`)),
      );
      expect(shown).not.toContain(w.b.maskedNumber);
      expect(shown).not.toContain(w.b.twofiatId);
    });
  });

  test.each(["owner", "manager", "member"] as const)(
    "a %s gets the whole account, with all its details",
    async (role) => {
      const w = await world();
      const list = await json<{ id: number }[]>(await w.request(role, "GET", "/cards"));
      expect(list.map((c) => c.id).toSorted()).toEqual([w.a.id, w.b.id].toSorted());
      const rows = await json<{ id: number }[]>(await w.request(role, "GET", "/findings?status=all"));
      expect(rows.map((f) => f.id)).toEqual(expect.arrayContaining([w.findingA, w.findingB]));
      const categories = await json<object[]>(await w.request(role, "GET", "/categories"));
      expect(categories).toEqual([expect.objectContaining({ activityCount: 0, ruleCount: 1 })]);
      const syncList = await json<{ rowsNew: number | null }[]>(await w.request(role, "GET", "/syncs"));
      expect(syncList[0]?.rowsNew).toBeGreaterThan(0);
    },
  );

  test("an account member who manages one card still gets the whole account", async () => {
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
    const list = await json<unknown[]>(await w.request("member", "GET", "/logical-cards"));
    expect(list).toHaveLength(2);
  });

  test("grants on two cards show both", async () => {
    const w = await world();
    const cardManager = w.db
      .select()
      .from(grants)
      .where(and(eq(grants.logicalCardId, w.a.logicalCardId), eq(grants.role, "manager")))
      .get();
    w.db
      .insert(grants)
      .values({
        accountId: w.accountId,
        logicalCardId: w.b.logicalCardId,
        userId: cardManager?.userId as number,
        role: "member",
      })
      .run();
    const list = await json<{ id: number }[]>(await w.request("cardManager", "GET", "/cards"));
    expect(list.map((c) => c.id).toSorted()).toEqual([w.a.id, w.b.id].toSorted());
  });
});

describe("managing grants", () => {
  const add = (w: World, body: { username: string; logicalCardId: number | null; role: string }) =>
    w.request("owner", "POST", "/grants", body);
  const owners = (w: World) =>
    w.db
      .select()
      .from(grants)
      .where(and(eq(grants.accountId, w.accountId), eq(grants.role, "owner"), isNull(grants.logicalCardId)))
      .all();

  test("lists who has what, with usernames", async () => {
    const w = await world();
    const res = await w.request("owner", "GET", "/grants");
    expect(await res.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "member", logicalCardId: null, role: "member" }),
        expect.objectContaining({
          username: "cardManager",
          logicalCardId: w.a.logicalCardId,
          role: "manager",
        }),
      ]),
    );
  });

  test("a new grant applies to that user's very next request", async () => {
    const w = await world();
    expect((await w.request("outsider", "GET", "/cards")).status).toBe(404);
    const res = await add(w, { username: "outsider", logicalCardId: w.b.logicalCardId, role: "member" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ username: "outsider", logicalCardId: w.b.logicalCardId });
    const seen = (await (await w.request("outsider", "GET", "/cards")).json()) as { id: number }[];
    expect(seen.map((c) => c.id)).toEqual([w.b.id]);
  });

  test("an unknown username says so", async () => {
    const w = await world();
    const res = await add(w, { username: "nobody", logicalCardId: null, role: "member" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_user" });
  });

  test("a second grant in the same place is refused, but one elsewhere is fine", async () => {
    const w = await world();
    const again = await add(w, { username: "member", logicalCardId: null, role: "manager" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "duplicate_grant" });
    const before = w.grantOf("member");
    expect(
      (await add(w, { username: "member", logicalCardId: w.a.logicalCardId, role: "manager" })).status,
    ).toBe(201);
    expect(w.grantOf("member")).toBe(before);
  });

  test("owner can't be granted on a card, by adding or by changing a role", async () => {
    const w = await world();
    const adding = await add(w, { username: "outsider", logicalCardId: w.a.logicalCardId, role: "owner" });
    expect(adding.status).toBe(400);
    const grant = w.grantOf("cardManager", w.a.logicalCardId);
    expect((await w.request("owner", "PATCH", `/grants/${grant}`, { role: "owner" })).status).toBe(400);
  });

  test("an account owner can also hold a grant on a card", async () => {
    const w = await world();
    expect(
      (await add(w, { username: "owner", logicalCardId: w.a.logicalCardId, role: "manager" })).status,
    ).toBe(201);
  });

  test("a card from another account, or an unknown role, is refused", async () => {
    const w = await world();
    const other = createAccount(w.db, w.secrets, {
      userId: w.userIds.owner,
      label: "other",
      token: NEW_TOKEN,
    });
    const theirs = w.db.insert(logicalCards).values({ accountId: other, name: "x" }).returning().get().id;
    expect((await add(w, { username: "outsider", logicalCardId: theirs, role: "member" })).status).toBe(400);
    expect((await add(w, { username: "outsider", logicalCardId: null, role: "auditor" })).status).toBe(400);
  });

  test("another account's grant can't be reached through this one", async () => {
    const w = await world();
    const other = createAccount(w.db, w.secrets, {
      userId: w.userIds.member,
      label: "other",
      token: NEW_TOKEN,
    });
    const theirs = w.db.select().from(grants).where(eq(grants.accountId, other)).get()?.id;
    expect((await w.request("owner", "PATCH", `/grants/${theirs}`, { role: "member" })).status).toBe(404);
    expect((await w.request("owner", "DELETE", `/grants/${theirs}`)).status).toBe(404);
    expect(w.db.select().from(grants).where(eq(grants.accountId, other)).all()).toHaveLength(1);
  });

  test("demoting and then removing an owner leaves their grant on a card, each step on its own", async () => {
    const w = await world();
    const card = w.a.logicalCardId;
    expect((await add(w, { username: "coOwner", logicalCardId: card, role: "manager" })).status).toBe(201);
    const note = (activityId: number) =>
      w.request("coOwner", "PATCH", `/activities/${activityId}/annotation`, { note: "hello" });

    expect((await w.request("coOwner", "GET", "/grants")).status).toBe(200);
    expect((await note(w.activityB)).status).toBe(200);

    const whole = w.grantOf("coOwner");
    expect((await w.request("owner", "PATCH", `/grants/${whole}`, { role: "member" })).status).toBe(200);
    expect((await w.request("coOwner", "GET", "/grants")).status).toBe(403);
    expect((await note(w.activityA)).status).toBe(200);
    expect((await note(w.activityB)).status).toBe(403);
    expect((await w.request("coOwner", "GET", `/activities/${w.activityB}`)).status).toBe(200);

    expect((await w.request("owner", "DELETE", `/grants/${whole}`)).status).toBe(204);
    expect((await note(w.activityA)).status).toBe(200);
    expect((await w.request("coOwner", "GET", `/activities/${w.activityB}`)).status).toBe(404);
    expect(w.grantOf("coOwner", card)).toBeDefined();
  });

  describe("the last owner", () => {
    async function oneOwner() {
      const w = await world();
      expect((await w.request("owner", "DELETE", `/grants/${w.grantOf("coOwner")}`)).status).toBe(204);
      return w;
    }

    test("can't be demoted, removed or leave, and nothing changes", async () => {
      const w = await oneOwner();
      const grant = w.grantOf("owner");
      const attempts = [
        await w.request("owner", "PATCH", `/grants/${grant}`, { role: "manager" }),
        await w.request("owner", "DELETE", `/grants/${grant}`),
        await w.request("owner", "DELETE", "/grants/mine"),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: "last_owner" });
      }
      expect(owners(w)).toHaveLength(1);
    });

    test("leaving as the last owner keeps their card grants too", async () => {
      const w = await oneOwner();
      await add(w, { username: "owner", logicalCardId: w.a.logicalCardId, role: "manager" });
      expect((await w.request("owner", "DELETE", "/grants/mine")).status).toBe(409);
      expect(w.grantOf("owner", w.a.logicalCardId)).toBeDefined();
    });

    test("can go once there's another owner", async () => {
      const w = await oneOwner();
      await add(w, { username: "member", logicalCardId: w.a.logicalCardId, role: "manager" });
      const res = await w.request("owner", "PATCH", `/grants/${w.grantOf("member")}`, { role: "owner" });
      expect(res.status).toBe(200);
      expect((await w.request("owner", "DELETE", "/grants/mine")).status).toBe(204);
      expect(owners(w).map((g) => g.userId)).toEqual([w.userIds.member]);
    });

    test("keeping the owner role isn't demoting", async () => {
      const w = await oneOwner();
      const res = await w.request("owner", "PATCH", `/grants/${w.grantOf("owner")}`, { role: "owner" });
      expect(res.status).toBe(200);
    });
  });

  test("one of two owners can leave", async () => {
    const w = await world();
    expect((await w.request("coOwner", "DELETE", "/grants/mine")).status).toBe(204);
    expect(owners(w).map((g) => g.userId)).toEqual([w.userIds.owner]);
  });

  test("leaving gives up every grant on the account, and only that account", async () => {
    const w = await world();
    const other = createAccount(w.db, w.secrets, {
      userId: w.userIds.member,
      label: "other",
      token: NEW_TOKEN,
    });
    await add(w, { username: "member", logicalCardId: w.a.logicalCardId, role: "manager" });
    expect((await w.request("member", "DELETE", "/grants/mine")).status).toBe(204);
    expect((await w.request("member", "GET", "")).status).toBe(404);
    const left = w.db.select().from(grants).where(eq(grants.userId, w.userIds.member)).all();
    expect(left.map((g) => g.accountId)).toEqual([other]);
  });
});

describe("linking and separating cards", () => {
  const link = (w: World, cardId: number, logicalCardId: number | null) =>
    w.request("owner", "PATCH", `/cards/${cardId}`, { logicalCardId });
  const seen = async (w: World, user: Role) =>
    ((await (await w.request(user, "GET", "/cards")).json()) as { id: number }[]).map((c) => c.id).toSorted();
  const grantA = (w: World, username: string, logicalCardId: number, role: Role) =>
    w.request("owner", "POST", "/grants", { username, logicalCardId, role });

  test("a grant follows when its logical card goes, and then covers the whole linked card", async () => {
    const w = await world();
    expect((await link(w, w.a.id, w.b.logicalCardId)).status).toBe(200);
    expect(w.grantOf("cardManager", w.b.logicalCardId)).toBeDefined();
    expect(await seen(w, "cardManager")).toEqual([w.a.id, w.b.id].toSorted());
    const res = await w.request("cardManager", "PATCH", `/activities/${w.activityB}/annotation`, {
      note: "yes",
    });
    expect(res.status).toBe(200);
  });

  test("a user with a grant on both keeps the higher role, whichever way round", async () => {
    const w = await world();
    await grantA(w, "cardManager", w.b.logicalCardId, "member");
    await grantA(w, "cardMember", w.b.logicalCardId, "manager");
    expect((await link(w, w.a.id, w.b.logicalCardId)).status).toBe(200);
    const rows = w.db.select().from(grants).where(eq(grants.logicalCardId, w.b.logicalCardId)).all();
    const roleOf = (user: Role) => rows.find((g) => g.userId === w.userIds[user])?.role;
    expect(roleOf("cardManager")).toBe("manager");
    expect(roleOf("cardMember")).toBe("manager");
    expect(rows).toHaveLength(2);
  });

  test("separating a card out of a linked pair leaves grants where they are, so the new card has none", async () => {
    const w = await world();
    expect((await link(w, w.b.id, w.a.logicalCardId)).status).toBe(200);
    expect(await seen(w, "cardManager")).toEqual([w.a.id, w.b.id].toSorted());
    expect((await link(w, w.b.id, null)).status).toBe(200);
    expect(await seen(w, "cardManager")).toEqual([w.a.id]);
    expect(w.grantOf("cardManager", w.a.logicalCardId)).toBeDefined();
  });

  test("separating a logical card's only card keeps its grants on the card", async () => {
    const w = await world();
    expect((await link(w, w.a.id, null)).status).toBe(200);
    expect(await seen(w, "cardManager")).toEqual([w.a.id]);
  });

  test("moving one of several cards away leaves grants on the logical card that stays", async () => {
    const w = await world();
    await link(w, w.b.id, w.a.logicalCardId);
    const third = w.db
      .insert(logicalCards)
      .values({ accountId: w.accountId, name: "third" })
      .returning()
      .get().id;
    expect((await link(w, w.b.id, third)).status).toBe(200);
    expect(await seen(w, "cardMember")).toEqual([w.a.id]);
    expect(w.db.select().from(grants).where(eq(grants.logicalCardId, third)).all()).toEqual([]);
  });
});

describe("what the account says about the user's access", () => {
  type AccountBody = {
    replacedByAccountId: number | null;
    access: {
      accountRole: string | null;
      account: string[];
      everyCard: string[];
      cards: { logicalCardId: number; role: string; permissions: string[] }[];
    };
  };
  const account = async (w: World, user: Role) =>
    (await (await w.request(user, "GET", "")).json()) as AccountBody;

  test("an owner, a manager and a member of the account", async () => {
    const w = await world();
    const owner = (await account(w, "owner")).access;
    expect(owner.accountRole).toBe("owner");
    expect(owner.account).toContain("grants.manage");
    expect(owner.everyCard).toContain("card.adjust");
    const manager = (await account(w, "manager")).access;
    expect(manager.account).toEqual(["account.view", "fees.edit", "categories.manage"]);
    const member = (await account(w, "member")).access;
    expect(member.account).toEqual(["account.view"]);
    expect(member.everyCard).toEqual(["card.view"]);
  });

  test("someone with a role on one card gets nothing on the account or every card", async () => {
    const w = await world();
    const { access } = await account(w, "cardManager");
    expect(access).toMatchObject({ accountRole: null, account: [], everyCard: [] });
    expect(access.cards).toHaveLength(1);
    expect(access.cards[0]).toMatchObject({ logicalCardId: w.a.logicalCardId, role: "manager" });
    expect(access.cards[0]?.permissions).toContain("card.adjust");
    const member = (await account(w, "cardMember")).access;
    expect(member.cards[0]?.permissions).toEqual(["card.view"]);
  });

  test("the account list carries each account's access", async () => {
    const w = await world();
    const res = await w.app.request("/api/accounts", {
      headers: { origin: "http://localhost", cookie: w.cookies.member ?? "" },
    });
    expect(await res.json()).toMatchObject([{ access: { accountRole: "member" } }]);
  });

  test("an archived account names its replacement only to those with access to it", async () => {
    const w = await world();
    const res = await w.request("owner", "POST", "/replacement", { token: NEW_TOKEN });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect((await account(w, "owner")).replacedByAccountId).toBe(id);
    expect((await account(w, "member")).replacedByAccountId).toBe(id);
    expect((await account(w, "cardManager")).replacedByAccountId).toBeNull();
  });
});
