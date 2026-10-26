import { authorization, CARD_A, CARD_B, card } from "@twofiat/client/fixtures";
import { eq } from "drizzle-orm";
import { type ClientResponse, hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import { describe, expect, test } from "vitest";
import { type App, createApp } from "../src/app.ts";
import { createUser, hashPassword } from "../src/auth.ts";
import { openDb } from "../src/db/db.ts";
import { accounts, sessions, syncs } from "../src/db/schema.ts";
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
