import { authorization, CARD_A, CARD_B, card, order, topupRow, withdraw } from "@twofiat/client/fixtures";
import { eq } from "drizzle-orm";
import { type ClientResponse, hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import { describe, expect, test } from "vitest";
import { type App, createApp } from "../src/app.ts";
import { createUser, hashPassword } from "../src/auth.ts";
import { openDb } from "../src/db/db.ts";
import { accounts, cards as cardsTable, sessions, syncs } from "../src/db/schema.ts";
import { markForRebuild } from "../src/ledger.ts";
import { reevaluate } from "../src/reevaluate.ts";
import { Secrets } from "../src/secrets.ts";
import { SyncRunner } from "../src/sync.ts";
import { fake2fiat } from "./fake-2fiat.ts";
import { scenario } from "./scenario.ts";

const APP_SECRET = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "token1abc123";
const NEW_TOKEN = "token1def456";
const PASSWORD = "correct horse battery";

async function setup() {
  const db = openDb(":memory:");
  const secrets = new Secrets(APP_SECRET);
  const rows = scenario();
  // A purchase authorised long ago and never posted: stale by the 20th.
  const authOld = authorization({
    card: CARD_A,
    at: "2026-10-05T08:00:00.000Z",
    amount: "-2.00",
    description: "KIOSK SPRINGFIELD USA",
  });
  const twofiat = fake2fiat({
    cards: [card({ id: CARD_A, balance: 12.5 }), card({ id: CARD_B, balance: 100 })],
    transactions: [authOld, rows.authA, rows.feeA, rows.postA, rows.authB, rows.postB],
    orders: [rows.issue],
  });
  twofiat.state.validTokens = [TOKEN, NEW_TOKEN];
  const clock = { now: new Date("2026-10-20T12:00:00.000Z") };
  const session = { fetch: twofiat.fetch, sleep: async () => {} };
  const runner = new SyncRunner({ db, secrets, session, now: () => clock.now });
  const app = createApp({ db, secrets, runner, session, now: () => clock.now });
  const userId = createUser(db, "jesse", await hashPassword(PASSWORD));
  return { db, secrets, rows, authOld, twofiat, clock, runner, app, userId };
}

type OkBody<R> =
  R extends ClientResponse<infer T, infer U, "json"> ? (U extends SuccessStatusCode ? T : never) : never;

/** The body of a successful response, typed as such; anything else fails the test. */
async function ok<R extends ClientResponse<unknown, number, "json">>(res: Promise<R>): Promise<OkBody<R>> {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as OkBody<R>;
}

/** A typed client for the app, keeping cookies like a browser and sending its origin. */
function client(app: App) {
  const jar = new Map<string, string>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", "http://localhost");
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await app.request(input, { ...init, headers });
    for (const cookie of res.headers.getSetCookie()) {
      const [name, value] = (cookie.split(";")[0] ?? "").split("=");
      if (!name) continue;
      if (!value || /Max-Age=0/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }) as typeof globalThis.fetch;
  return { api: hc<App>("http://localhost", { fetch }).api, jar };
}

async function loggedIn(s: Awaited<ReturnType<typeof setup>>) {
  const c = client(s.app);
  const res = await c.api.auth.login.$post({ json: { username: "jesse", password: PASSWORD } });
  expect(res.status).toBe(200);
  return c;
}

/** Logged in, with the account added and synced once. */
async function synced() {
  const s = await setup();
  const c = await loggedIn(s);
  const created = await c.api.accounts.$post({ json: { label: "main", token: TOKEN } });
  const accountId = ((await created.json()) as { id: number }).id;
  const res = await c.api.accounts[":accountId"].syncs.$post({ param: { accountId: String(accountId) } });
  expect(res.status).toBe(202);
  await s.runner.sync(accountId, "manual");
  const param = { accountId: String(accountId) };
  const account = c.api.accounts[":accountId"];
  const cardsByTwofiatId = async () =>
    new Map((await ok(account.cards.$get({ param }))).map((card) => [card.twofiatId, card]));
  return { ...s, ...c, accountId, param, account, cardsByTwofiatId };
}

describe("auth", () => {
  test("logs in with a session cookie, and out again", async () => {
    const s = await setup();
    const c = client(s.app);
    expect((await c.api.accounts.$get()).status).toBe(401);

    const res = await c.api.auth.login.$post({ json: { username: "jesse", password: PASSWORD } });
    expect(await res.json()).toEqual({ user: { id: s.userId, username: "jesse" } });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^session=[\w-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    // Plain-http localhost: a Secure cookie would be dropped.
    expect(cookie).not.toMatch(/Secure/);
    // Only the token's hash is stored.
    expect(s.db.select().from(sessions).get()?.id).not.toBe(c.jar.get("session"));

    expect(await ok(c.api.auth.me.$get())).toEqual({ user: { id: s.userId, username: "jesse" } });
    expect((await c.api.auth.logout.$post()).status).toBe(204);
    expect(c.jar.has("session")).toBe(false);
    expect(s.db.select().from(sessions).all()).toEqual([]);
    expect((await c.api.auth.me.$get()).status).toBe(401);
  });

  test("refuses a wrong password and an unknown user alike", async () => {
    const s = await setup();
    const c = client(s.app);
    for (const json of [
      { username: "jesse", password: "wrong" },
      { username: "nobody", password: PASSWORD },
    ]) {
      const res = await c.api.auth.login.$post({ json });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "invalid_credentials",
        message: "wrong username or password",
      });
    }
    expect((await c.api.auth.login.$post({ json: { username: "", password: "" } })).status).toBe(400);
  });

  test("sessions slide forward on use, at most daily, and expire after 30 idle days", async () => {
    const s = await setup();
    const c = await loggedIn(s);
    const expiry = () => s.db.select().from(sessions).get()?.expiresAt;
    expect(expiry()).toBe("2026-11-19T12:00:00.000Z");

    s.clock.now = new Date("2026-10-20T20:00:00.000Z");
    const same = await c.api.auth.me.$get();
    expect(same.headers.get("set-cookie")).toBeNull();
    expect(expiry()).toBe("2026-11-19T12:00:00.000Z");

    s.clock.now = new Date("2026-10-22T12:00:00.000Z");
    const renewed = await c.api.auth.me.$get();
    expect(renewed.headers.get("set-cookie")).toMatch(/^session=/);
    expect(expiry()).toBe("2026-11-21T12:00:00.000Z");

    s.clock.now = new Date("2026-11-21T12:00:00.000Z");
    expect((await c.api.auth.me.$get()).status).toBe(401);
    expect(s.db.select().from(sessions).all()).toEqual([]);
  });

  test("rejects cross-origin form posts", async () => {
    const s = await setup();
    const res = await s.app.request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "username=jesse&password=x",
    });
    expect(res.status).toBe(403);
  });
});

describe("accounts", () => {
  test("adding an account checks the token with 2fiat and stores its sid, without syncing", async () => {
    const s = await setup();
    const c = await loggedIn(s);
    const res = await c.api.accounts.$post({ json: { label: " main ", token: TOKEN } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ label: "main", archivedAt: null, lastSync: null });
    expect(JSON.stringify(body)).not.toMatch(/token|sid/i);

    const stored = s.db.select().from(accounts).get();
    expect(s.secrets.decrypt(stored?.sidEnc as string)).toBe("sid-1");
    expect(stored?.sidExpiresAt).toBe("2026-11-03T12:00:00.000Z");
    expect(s.db.select().from(syncs).all()).toEqual([]);
    expect(await ok(c.api.accounts.$get())).toHaveLength(1);
  });

  test("refuses malformed, rejected and duplicate tokens", async () => {
    const s = await setup();
    const c = await loggedIn(s);
    const add = (token: string) => c.api.accounts.$post({ json: { label: "x", token } });

    const malformed = await add("https://2fiat.com/login/token1abc");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_request" });
    const rejected = await add("token1unknown");
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: "token_rejected" });
    expect((await add(TOKEN)).status).toBe(201);
    const duplicate = await add(TOKEN);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "duplicate_account" });
  });

  test("another user's account is not found", async () => {
    const s = await synced();
    createUser(s.db, "other", await hashPassword(PASSWORD));
    const other = client(s.app);
    await other.api.auth.login.$post({ json: { username: "other", password: PASSWORD } });
    const account = other.api.accounts[":accountId"];
    expect(await ok(other.api.accounts.$get())).toEqual([]);
    expect((await account.$get({ param: s.param })).status).toBe(404);
    expect((await account.cards.$get({ param: s.param })).status).toBe(404);
    expect((await account.syncs.$post({ param: s.param })).status).toBe(404);
    expect((await other.api.accounts[":accountId"].$get({ param: { accountId: "x" } })).status).toBe(404);
  });

  test("renames an account", async () => {
    const s = await synced();
    const res = await s.account.$patch({ param: s.param, json: { label: "Everyday" } });
    expect(await res.json()).toMatchObject({ id: s.accountId, label: "Everyday" });
  });

  test("replacing the token archives the account: it stays readable but never syncs", async () => {
    const s = await synced();
    const res = await s.account.replacement.$post({ param: s.param, json: { token: NEW_TOKEN } });
    expect(res.status).toBe(201);
    const replacement = (await res.json()) as { id: number; label: string };
    expect(replacement.label).toBe("main");

    const old = await ok(s.account.$get({ param: s.param }));
    expect(old).toMatchObject({
      replacedByAccountId: replacement.id,
      archivedAt: "2026-10-20T12:00:00.000Z",
    });
    const stored = s.db.select().from(accounts).where(eq(accounts.id, s.accountId)).get();
    expect(stored).toMatchObject({ tokenEnc: null, sidEnc: null, sidExpiresAt: null });

    expect((await ok(s.account.cards.$get({ param: s.param }))).length).toBe(2);
    const sync = await s.account.syncs.$post({ param: s.param });
    expect(sync.status).toBe(409);
    expect(await sync.json()).toMatchObject({ error: "account_archived" });
    const again = await s.account.replacement.$post({ param: s.param, json: { token: "token1zzz" } });
    expect(again.status).toBe(409);
  });
});

describe("syncs", () => {
  test("a triggered sync returns at once, and its status can be polled", async () => {
    const s = await setup();
    const c = await loggedIn(s);
    const created = await c.api.accounts.$post({ json: { label: "main", token: TOKEN } });
    const param = { accountId: String(((await created.json()) as { id: number }).id) };
    const syncsApi = c.api.accounts[":accountId"].syncs;

    const started = await syncsApi.$post({ param });
    expect(started.status).toBe(202);
    const sync = (await started.json()) as { id: number; status: string };
    expect(sync.status).toBe("running");
    // A second trigger joins it.
    expect(((await ok(syncsApi.$post({ param }))) as { id: number }).id).toBe(sync.id);

    await s.runner.sync(Number(param.accountId), "manual");
    const polled = await syncsApi[":syncId"].$get({ param: { ...param, syncId: String(sync.id) } });
    expect(await polled.json()).toMatchObject({ id: sync.id, status: "ok", rowsNew: 7 });
    expect(await ok(syncsApi.$get({ param, query: {} }))).toHaveLength(1);
    expect(await ok(c.api.accounts.$get())).toMatchObject([{ lastSync: { id: sync.id, status: "ok" } }]);
    expect((await syncsApi[":syncId"].$get({ param: { ...param, syncId: "999" } })).status).toBe(404);
  });
});

describe("cards and balances", () => {
  test("lists physical cards with their latest balance and opening balance", async () => {
    const s = await synced();
    const cards = await s.cardsByTwofiatId();
    expect(cards.get(CARD_A)).toMatchObject({
      balance: { reportedCents: 1250, ledgerCents: 1250, gapCents: 0, transient: false },
      openingBalance: null,
    });
    expect(cards.get(CARD_B)).toMatchObject({
      balance: { reportedCents: 10_000, ledgerCents: 10_000, gapCents: 0 },
      openingBalance: { cents: 12_000, source: "inferred" },
    });
    const one = await s.account.cards[":cardId"].$get({
      param: { ...s.param, cardId: String(cards.get(CARD_A)?.id) },
    });
    expect(await one.json()).toMatchObject({ twofiatId: CARD_A });
  });

  test("an entered opening balance re-evaluates without a sync; deleting it infers it again", async () => {
    const s = await synced();
    const b = (await s.cardsByTwofiatId()).get(CARD_B);
    const param = { ...s.param, cardId: String(b?.id) };
    const opening = s.account.cards[":cardId"]["opening-balance"];
    s.twofiat.calls.length = 0;

    const entered = await ok(opening.$put({ param, json: { cents: 11_000 } }));
    expect(entered).toMatchObject({
      openingBalance: { cents: 11_000, source: "entered" },
      balance: { reportedCents: 10_000, ledgerCents: 9000, gapCents: 1000 },
    });
    expect(s.twofiat.calls).toEqual([]);

    const snapshots = await ok(s.account.snapshots.$get({ param: s.param, query: { cardId: param.cardId } }));
    expect(snapshots.map((x) => x.gapCents)).toEqual([0, 1000]);

    const reset = await ok(opening.$delete({ param }));
    expect(reset).toMatchObject({
      openingBalance: { cents: 11_000 + 1000, source: "inferred" },
      balance: { gapCents: 0 },
    });
  });

  test("groups a physical card into another logical card, and splits it out again", async () => {
    const s = await synced();
    const cards = await s.cardsByTwofiatId();
    const [a, b] = [cards.get(CARD_A), cards.get(CARD_B)];
    const move = (logicalCardId: number | null) =>
      s.account.cards[":cardId"].$patch({
        param: { ...s.param, cardId: String(b?.id) },
        json: { logicalCardId },
      });

    expect((await ok(move(a?.logicalCardId ?? 0))) as { logicalCardId: number }).toMatchObject({
      logicalCardId: a?.logicalCardId,
    });
    const merged = await ok(s.account["logical-cards"].$get({ param: s.param }));
    expect(merged).toMatchObject([
      { id: a?.logicalCardId, cardIds: [a?.id, b?.id], balance: { reportedCents: 11_250, gapCents: 0 } },
    ]);

    const split = (await ok(move(null))) as { logicalCardId: number };
    expect(split.logicalCardId).not.toBe(a?.logicalCardId);
    const renamed = await s.account["logical-cards"][":logicalCardId"].$patch({
      param: { ...s.param, logicalCardId: String(split.logicalCardId) },
      json: { name: "Everyday" },
    });
    expect(await renamed.json()).toMatchObject({ name: "Everyday", cardIds: [b?.id] });
    expect((await move(999)).status).toBe(404);
  });

  test("a logical card's balance runs over all its cards, from their opening balances", async () => {
    const s = await synced();
    const cards = await s.cardsByTwofiatId();
    const [a, b] = [cards.get(CARD_A), cards.get(CARD_B)];
    // B (inherited, opening $120) becomes part of A's logical card.
    await ok(
      s.account.cards[":cardId"].$patch({
        param: { ...s.param, cardId: String(b?.id) },
        json: { logicalCardId: a?.logicalCardId ?? 0 },
      }),
    );
    const param = { ...s.param, logicalCardId: String(a?.logicalCardId) };
    const history = await ok(s.account["logical-cards"][":logicalCardId"]["balance-history"].$get({ param }));

    const at = history.points.map((p) => p.at);
    expect(at).toEqual([...at].sort());
    // It ends at the two ledgers' sum: A's $12.50 and B's $100.
    expect(history.points.at(-1)?.cents).toBe(11_250);
    // B's opening balance comes in just before B's first activity.
    const opening = history.points.findIndex((p) => p.openingCardId === b?.id);
    expect(history.points[opening]).toMatchObject({
      cents: (history.points[opening - 1]?.cents ?? 0) + 12_000,
    });
    expect(history.points[opening + 1]?.activity).toMatchObject({ cardId: b?.id, amountCents: -2000 });
    expect(history.points.filter((p) => p.openingCardId !== null)).toHaveLength(1);
    expect(history.reported).toEqual([{ at: "2026-10-20T12:00:00.000Z", cents: 11_250 }]);

    // The logical card's findings, snapshots and adjustments span both cards.
    const query = { logicalCardId: param.logicalCardId };
    const snapshots = await ok(s.account.snapshots.$get({ param: s.param, query }));
    expect(new Set(snapshots.map((x) => x.cardId))).toEqual(new Set([a?.id, b?.id]));
    const findings = await ok(s.account.findings.$get({ param: s.param, query }));
    expect(findings.map((f) => f.kind)).toContain("stale-authorization");
    await ok(
      s.account.adjustments.$post({
        param: s.param,
        json: { cardId: b?.id ?? 0, cents: 100, occurredAt: "2026-10-20T13:00:00.000Z", note: "x" },
      }),
    );
    expect((await ok(s.account.adjustments.$get({ param: s.param, query }))).map((x) => x.cardId)).toEqual([
      b?.id,
    ]);
    const other = await ok(
      s.account.findings.$get({
        param: s.param,
        query: { logicalCardId: String((a?.logicalCardId ?? 0) + 99) },
      }),
    );
    expect(other).toEqual([]);

    expect(
      (
        await s.account["logical-cards"][":logicalCardId"]["balance-history"].$get({
          param: { ...s.param, logicalCardId: "999" },
        })
      ).status,
    ).toBe(404);
  });

  test("a logical card's spending is its money in and out, without transfers between its own cards", async () => {
    const s = await synced();
    // $10 moves from A to B: a withdrawal on A, and a top-up on B a second later.
    s.twofiat.state.transactions.push(
      withdraw({ card: CARD_A, at: "2026-10-18T09:00:00.000Z", amount: "10.00" }),
      topupRow({ card: CARD_B, at: "2026-10-18T09:00:01.000Z", amount: "+10.00" }),
    );
    s.twofiat.state.cards = [card({ id: CARD_A, balance: 2.5 }), card({ id: CARD_B, balance: 110 })];
    await s.runner.sync(s.accountId, "manual");
    const cards = await s.cardsByTwofiatId();
    const [a, b] = [cards.get(CARD_A), cards.get(CARD_B)];
    const flows = async (logicalCardId: number | undefined) =>
      (
        await ok(
          s.account["logical-cards"][":logicalCardId"].spending.$get({
            param: { ...s.param, logicalCardId: String(logicalCardId) },
          }),
        )
      ).activities;

    // Apart, the transfer is money out of one and into the other.
    const ofA = await flows(a?.logicalCardId);
    expect(ofA.map((f) => [f.kind, f.amountCents])).toContainEqual(["transfer_out", -1000]);
    expect(ofA.every((f) => f.amountCents !== 0 && f.cardId === a?.id)).toBe(true);
    expect(ofA.map((f) => f.at)).toEqual(ofA.map((f) => f.at).sort());
    expect((await flows(b?.logicalCardId)).map((f) => [f.kind, f.amountCents])).toContainEqual([
      "transfer_in",
      1000,
    ]);

    // Together, it only moved money within the card.
    await ok(
      s.account.cards[":cardId"].$patch({
        param: { ...s.param, cardId: String(b?.id) },
        json: { logicalCardId: a?.logicalCardId ?? 0 },
      }),
    );
    const merged = await flows(a?.logicalCardId);
    expect(merged.some((f) => f.kind === "transfer_in" || f.kind === "transfer_out")).toBe(false);
    expect(merged.map((f) => f.description)).toContain("CAFE SPRINGFIELD USA");
    expect(
      (
        await s.account["logical-cards"][":logicalCardId"].spending.$get({
          param: { ...s.param, logicalCardId: "999" },
        })
      ).status,
    ).toBe(404);
  });

  test("keeps exactly one current card per logical card", async () => {
    const s = await synced();
    // B replaces A: issued later.
    s.db
      .update(cardsTable)
      .set({ issuedAt: "2026-09-01T00:00:00.000Z" })
      .where(eq(cardsTable.twofiatId, CARD_B))
      .run();
    const cards = await s.cardsByTwofiatId();
    const [a, b] = [cards.get(CARD_A), cards.get(CARD_B)];
    expect([a?.isCurrent, b?.isCurrent]).toEqual([true, true]);
    const move = (id: number | undefined, logicalCardId: number | null) =>
      ok(
        s.account.cards[":cardId"].$patch({
          param: { ...s.param, cardId: String(id) },
          json: { logicalCardId },
        }),
      );
    const logical = async () => {
      const all = await ok(s.account["logical-cards"].$get({ param: s.param }));
      return all.map((l) => ({ cardIds: l.cardIds, currentCardId: l.currentCardId }));
    };
    const setCurrent = (logicalCardId: number | undefined, currentCardId: number | undefined) =>
      s.account["logical-cards"][":logicalCardId"].$patch({
        param: { ...s.param, logicalCardId: String(logicalCardId) },
        json: { currentCardId },
      });

    // The later-issued card moving in becomes current.
    await move(b?.id, a?.logicalCardId ?? 0);
    expect(await logical()).toEqual([{ cardIds: [a?.id, b?.id], currentCardId: b?.id }]);

    // The user can override it, but only with a member.
    expect((await setCurrent(a?.logicalCardId, a?.id)).status).toBe(200);
    expect(await logical()).toEqual([{ cardIds: [a?.id, b?.id], currentCardId: a?.id }]);

    // Moving the current card out leaves the other one current; it's current in its own logical card.
    const split = await move(a?.id, null);
    expect(await logical()).toEqual([
      { cardIds: [b?.id], currentCardId: b?.id },
      { cardIds: [a?.id], currentCardId: a?.id },
    ]);
    expect((await setCurrent(split.logicalCardId, b?.id)).status).toBe(400);

    // An earlier-issued card moving in doesn't take over.
    await move(a?.id, a?.logicalCardId ?? 0);
    expect(await logical()).toEqual([{ cardIds: [a?.id, b?.id], currentCardId: b?.id }]);
  });
});

describe("activities", () => {
  test("pages newest first with a cursor, and filters", async () => {
    const s = await synced();
    const activities = s.account.activities;
    const all = await ok(activities.$get({ param: s.param, query: {} }));
    expect(all.nextCursor).toBeNull();
    expect(all.items.map((a) => a.kind)).toEqual(["purchase", "fee", "purchase", "purchase", "card_issue"]);

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await ok(activities.$get({ param: s.param, query: { limit: "2", cursor } }));
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.items.map((a) => a.id));

    const query = async (q: Record<string, string>) =>
      (await ok(activities.$get({ param: s.param, query: q }))).items.map((a) => a.description);
    expect(await query({ kind: "fee,card_issue" })).toHaveLength(2);
    expect(await query({ q: "cafe" })).toEqual(["CAFE SPRINGFIELD USA"]);
    expect(await query({ q: "%" })).toEqual([]);
    expect(await query({ stale: "true" })).toEqual(["KIOSK SPRINGFIELD USA"]);
    expect(await query({ from: "2026-10-10T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" })).toHaveLength(2);
    const b = (await s.cardsByTwofiatId()).get(CARD_B);
    expect(await query({ cardId: String(b?.id) })).toEqual(["CAFE SPRINGFIELD USA"]);
    expect(await query({ logicalCardId: String(b?.logicalCardId) })).toEqual(["CAFE SPRINGFIELD USA"]);
    expect((await activities.$get({ param: s.param, query: { cursor: "junk" } })).status).toBe(400);

    const findings = await ok(s.account.findings.$get({ param: s.param, query: {} }));
    const staleFinding = findings.find((f) => f.kind === "stale-authorization");
    expect(await query({ findingId: String(staleFinding?.id) })).toEqual(["KIOSK SPRINGFIELD USA"]);
    expect(await query({ findingId: "999" })).toEqual([]);
  });

  test("one activity comes with 2fiat's rows behind it and the findings that point at it", async () => {
    const s = await synced();
    const list = await ok(s.account.activities.$get({ param: s.param, query: { stale: "true" } }));
    const stale = list.items[0];
    const res = await s.account.activities[":activityId"].$get({
      param: { ...s.param, activityId: String(stale?.id) },
    });
    const detail = await res.json();
    expect(detail).toMatchObject({ stale: true, status: "pending" });
    expect(detail.sources.transactions.map((t) => t.twofiatId)).toEqual([s.authOld.id]);
    expect(detail.sources.orders).toEqual([]);
    const findings = await ok(s.account.findings.$get({ param: s.param, query: {} }));
    expect(findings.filter((f) => detail.findingIds.includes(f.id)).map((f) => f.kind)).toEqual([
      "stale-authorization",
    ]);
    expect(
      (await s.account.activities[":activityId"].$get({ param: { ...s.param, activityId: "999" } })).status,
    ).toBe(404);
  });
});

describe("adjustments", () => {
  test("an adjustment closes a gap without a sync, and survives a full rebuild", async () => {
    const s = await synced();
    // 2fiat's support credits card A $5 by hand: no row says so.
    s.twofiat.state.cards[0] = card({ id: CARD_A, balance: 17.5 });
    s.clock.now = new Date("2026-10-21T12:00:00.000Z");
    await s.runner.sync(s.accountId, "manual");
    const cardA = async () => (await s.cardsByTwofiatId()).get(CARD_A);
    const a = await cardA();
    expect(a?.balance?.gapCents).toBe(500);
    s.twofiat.calls.length = 0;

    const adjustments = s.account.adjustments;
    const created = await ok(
      adjustments.$post({
        param: s.param,
        json: {
          cardId: a?.id ?? 0,
          cents: 500,
          occurredAt: "2026-10-21T09:00:00.000Z",
          note: "Support credit",
        },
      }),
    );
    expect(created).toMatchObject({ cardId: a?.id, cents: 500, occurredAt: "2026-10-21T09:00:00.000Z" });
    expect(s.twofiat.calls).toEqual([]);
    expect((await cardA())?.balance).toMatchObject({ ledgerCents: 1750, gapCents: 0 });
    expect(await ok(s.account.findings.$get({ param: s.param, query: { kind: "balance-gap" } }))).toEqual([]);

    const adjustmentActivities = async () =>
      (await ok(s.account.activities.$get({ param: s.param, query: { kind: "adjustment" } }))).items;
    expect(await adjustmentActivities()).toMatchObject([
      { id: created.activityId, amountCents: 500, status: "settled", description: "Support credit" },
    ]);
    const activityParam = { ...s.param, activityId: String(created.activityId) };
    const detail = await ok(s.account.activities[":activityId"].$get({ param: activityParam }));
    expect(detail.sources).toMatchObject({ transactions: [], orders: [], adjustment: { id: created.id } });

    // A full rebuild re-normalises every raw row, and leaves the adjustment's activity as it was.
    markForRebuild(s.db, s.accountId);
    reevaluate(s.db, s.accountId, s.clock.now);
    expect((await adjustmentActivities()).map((x) => x.id)).toEqual([created.activityId]);
    expect((await cardA())?.balance?.gapCents).toBe(0);

    const param = { ...s.param, adjustmentId: String(created.id) };
    await ok(adjustments[":adjustmentId"].$patch({ param, json: { cents: 300 } }));
    expect((await cardA())?.balance?.gapCents).toBe(200);
    expect((await adjustments[":adjustmentId"].$delete({ param })).status).toBe(204);
    expect((await cardA())?.balance?.gapCents).toBe(500);
    expect((await s.account.activities[":activityId"].$get({ param: activityParam })).status).toBe(404);
    expect(await ok(adjustments.$get({ param: s.param, query: {} }))).toEqual([]);

    expect(
      (
        await adjustments.$post({
          param: s.param,
          json: { cardId: a?.id ?? 0, cents: 0, occurredAt: created.occurredAt, note: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await adjustments.$post({
          param: s.param,
          json: { cardId: 999, cents: 1, occurredAt: created.occurredAt, note: "x" },
        })
      ).status,
    ).toBe(404);
    expect((await adjustments[":adjustmentId"].$delete({ param })).status).toBe(404);
  });

  test("one that completes a short top-up settles both the gap and the shortfall", async () => {
    const s = await synced();
    // A $100 top-up paid short, so 2fiat credited a cent; support credited the rest by hand, with no row.
    const short = order({ card: CARD_A, at: "2026-10-15T10:00:00.000Z", amount: 100, credited: "0.01" });
    s.twofiat.state.orders.push(short);
    s.twofiat.state.cards[0] = card({ id: CARD_A, balance: 112.5 });
    await s.runner.sync(s.accountId, "manual");
    const open = async () =>
      (
        await ok(s.account.findings.$get({ param: s.param, query: { kind: "balance-gap,credit-shortfall" } }))
      ).map((f) => [f.kind, f.cents]);
    expect(await open()).toEqual(
      expect.arrayContaining([
        ["balance-gap", 9999],
        ["credit-shortfall", -9999],
      ]),
    );
    const shortfall = (
      await ok(s.account.findings.$get({ param: s.param, query: { kind: "credit-shortfall" } }))
    )[0];
    const a = (await s.cardsByTwofiatId()).get(CARD_A);
    const fields = { cardId: a?.id ?? 0, occurredAt: "2026-10-16T09:00:00.000Z", note: "Support made it up" };

    // Naming a top-up that isn't one is refused.
    const notTopup = (await ok(s.account.activities.$get({ param: s.param, query: { kind: "purchase" } })))
      .items[0];
    expect(
      (
        await s.account.adjustments.$post({
          param: s.param,
          json: { ...fields, cents: 9999, topupActivityId: notTopup?.id ?? 0 },
        })
      ).status,
    ).toBe(404);

    const created = await ok(
      s.account.adjustments.$post({
        param: s.param,
        json: { ...fields, cents: 9999, topupActivityId: shortfall?.activityIds[0] ?? 0 },
      }),
    );
    expect(created.order).toMatchObject({ twofiatId: short.id });
    expect(await open()).toEqual([]);
    expect((await s.cardsByTwofiatId()).get(CARD_A)?.balance?.gapCents).toBe(0);
  });

  test("one from before an inferred opening balance moves the opening, not the gap", async () => {
    // Card B's opening balance was inferred as $120 at the first sync, on the 20th at noon.
    const s = await synced();
    const cardB = async () => (await s.cardsByTwofiatId()).get(CARD_B);
    const b = await cardB();
    const add = (cents: number, occurredAt: string) =>
      ok(
        s.account.adjustments.$post({
          param: s.param,
          json: { cardId: b?.id ?? 0, cents, occurredAt, note: "x" },
        }),
      );

    // Money moved before the inference was already in the inferred opening: it moves out of it.
    const early = await add(2000, "2026-10-01T00:00:00.000Z");
    expect(await cardB()).toMatchObject({
      openingBalance: { cents: 10_000, source: "inferred" },
      balance: { ledgerCents: 10_000, gapCents: 0 },
    });
    // Money moved after it is new: it shows in the gap.
    await add(-1000, "2026-10-20T13:00:00.000Z");
    expect(await cardB()).toMatchObject({ openingBalance: { cents: 10_000 }, balance: { gapCents: 1000 } });
    // Moving the early one past the inference gives its money back to the opening.
    await ok(
      s.account.adjustments[":adjustmentId"].$patch({
        param: { ...s.param, adjustmentId: String(early.id) },
        json: { occurredAt: "2026-10-20T14:00:00.000Z" },
      }),
    );
    expect(await cardB()).toMatchObject({ openingBalance: { cents: 12_000 }, balance: { gapCents: -1000 } });

    // An opening balance the user entered is theirs: adjustments never move it.
    await ok(
      s.account.cards[":cardId"]["opening-balance"].$put({
        param: { ...s.param, cardId: String(b?.id) },
        json: { cents: 12_000 },
      }),
    );
    await add(500, "2026-10-01T00:00:00.000Z");
    expect((await cardB())?.openingBalance).toMatchObject({ cents: 12_000, source: "entered" });
  });
});

describe("findings", () => {
  test("lists open findings, marks one explained, and shows resolved ones", async () => {
    const s = await synced();
    const findings = s.account.findings;
    const open = await ok(findings.$get({ param: s.param, query: {} }));
    const stale = open.find((f) => f.kind === "stale-authorization");
    expect(stale).toMatchObject({
      firstSeenAt: "2026-10-20T12:00:00.000Z",
      resolvedAt: null,
      explainedAt: null,
    });

    const param = { ...s.param, findingId: String(stale?.id) };
    const explained = await (
      await findings[":findingId"].$patch({ param, json: { explanation: "a kiosk hold" } })
    ).json();
    expect(explained).toMatchObject({ explanation: "a kiosk hold", explainedAt: "2026-10-20T12:00:00.000Z" });
    // Explained findings leave the open list for their own, until the data resolves them.
    const ids = async (status?: "explained") =>
      (await ok(findings.$get({ param: s.param, query: status ? { status } : {} }))).map((f) => f.id);
    expect(await ids()).not.toContain(stale?.id);
    expect(await ids("explained")).toEqual([stale?.id]);
    const unexplained = await (
      await findings[":findingId"].$patch({ param, json: { explanation: null } })
    ).json();
    expect(unexplained).toMatchObject({ explanation: null, explainedAt: null });

    // Card A's balance drops with no row to explain it, then comes back: the gap opens and resolves.
    const syncWithBalance = async (balance: number, at: string) => {
      s.twofiat.state.cards[0] = card({ id: CARD_A, balance });
      s.clock.now = new Date(at);
      await s.runner.sync(s.accountId, "manual");
    };
    await syncWithBalance(11.5, "2026-10-21T12:00:00.000Z");
    const gap = (await ok(findings.$get({ param: s.param, query: { kind: "balance-gap" } })))[0];
    expect(gap).toMatchObject({ cents: -100, firstSeenAt: "2026-10-21T12:00:00.000Z" });
    await syncWithBalance(12.5, "2026-10-22T12:00:00.000Z");
    const resolved = await ok(findings.$get({ param: s.param, query: { status: "resolved" } }));
    expect(resolved).toMatchObject([{ id: gap?.id, resolvedAt: "2026-10-22T12:00:00.000Z" }]);
    const all = await ok(findings.$get({ param: s.param, query: { status: "all" } }));
    expect(all).toHaveLength(open.length + 1);
  });
});
