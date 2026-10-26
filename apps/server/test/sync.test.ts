import { authorization, CARD_A, CARD_B, card, fee, order, posting } from "@twofiat/client/fixtures";
import { asc, eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createAccount } from "../src/accounts.ts";
import { openDb } from "../src/db/db.ts";
import {
  accounts,
  activities,
  balanceObservations,
  balanceSnapshots,
  cards,
  logicalCards,
  openingBalances,
  rawOrders,
  rawTransactions,
  syncs,
  users,
} from "../src/db/schema.ts";
import { evaluate, LedgerNotReadyError } from "../src/evaluate.ts";
import { canonicalJson } from "../src/ingest.ts";
import { Secrets } from "../src/secrets.ts";
import { SyncAlreadyRunningError, SyncRunner } from "../src/sync.ts";
import { fake2fiat } from "./fake-2fiat.ts";

const control = vi.hoisted(() => ({ failNormalize: false }));
vi.mock("../src/ledger.ts", async (importOriginal) => {
  const ledger = await importOriginal<typeof import("../src/ledger.ts")>();
  return {
    ...ledger,
    normalizeAccount: (...args: Parameters<typeof ledger.normalizeAccount>) => {
      if (control.failNormalize) throw new Error("the normaliser broke");
      return ledger.normalizeAccount(...args);
    },
  };
});

const APP_SECRET = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "token1abc123";

/**
 * Card A has its whole history: issued with $20, then a $5 purchase and its fee, leaving $14.50.
 * Card B was inherited: $100 reported, with only a $20 purchase visible, so its opening balance must be $120.
 */
function scenario() {
  const issue = order({
    card: CARD_A,
    at: "2026-08-19T01:30:00.000Z",
    amount: 50,
    orderType: "issue",
    status: "paid_fully",
  });
  const authA = authorization({
    card: CARD_A,
    at: "2026-10-10T08:00:00.000Z",
    amount: "-5.00",
    description: "SHOP SPRINGFIELD USA",
  });
  const feeA = fee({ card: CARD_A, at: "2026-10-10T08:00:01.000Z" });
  const postA = posting({
    card: CARD_A,
    at: "2026-10-10T22:00:00.000Z",
    amount: "-5.00",
    description: "SHOP",
  });
  const authB = authorization({
    card: CARD_B,
    at: "2026-10-12T08:00:00.000Z",
    amount: "-20.00",
    description: "CAFE SPRINGFIELD USA",
  });
  const postB = posting({
    card: CARD_B,
    at: "2026-10-12T20:00:00.000Z",
    amount: "-20.00",
    description: "CAFE",
  });
  return { issue, authA, feeA, postA, authB, postB };
}

function setup(options: { today?: string } = {}) {
  const db = openDb(":memory:");
  const secrets = new Secrets(APP_SECRET);
  const userId = db.insert(users).values({ username: "u", passwordHash: "x" }).returning().get().id;
  const accountId = createAccount(db, secrets, { userId, label: "main", token: TOKEN });
  const rows = scenario();
  const twofiat = fake2fiat({
    cards: [card({ id: CARD_A, balance: 14.5 }), card({ id: CARD_B, balance: 100 })],
    transactions: [rows.authA, rows.feeA, rows.postA, rows.authB, rows.postB],
    orders: [rows.issue],
  });
  const clock = { now: new Date(options.today ?? "2026-10-20T12:00:00.000Z") };
  const runner = new SyncRunner({
    db,
    secrets,
    session: { fetch: twofiat.fetch, sleep: async () => {} },
    now: () => clock.now,
  });
  const cardId = (twofiatId: string) =>
    db.select().from(cards).where(eq(cards.twofiatId, twofiatId)).get()?.id as number;
  const activityOf = (twofiatTxId: string) =>
    db
      .select({ id: activities.id, status: activities.status, amountCents: activities.amountCents })
      .from(activities)
      .where(eq(activities.key, `purchase:${twofiatTxId}`))
      .get();
  const account = () => db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  return { db, secrets, accountId, rows, twofiat, clock, runner, cardId, activityOf, account };
}

describe("SyncRunner", () => {
  test("a first sync pulls everything, normalises, and infers an inherited card's opening balance", async () => {
    const s = setup();
    const { sync, evaluation } = await s.runner.sync(s.accountId, "manual");

    expect(sync).toMatchObject({
      status: "ok",
      failedStage: null,
      rowsNew: 6,
      rowsUpdated: 0,
      rowsMissing: 0,
      windowFrom: "2026-06-14",
      windowTo: "2026-10-20",
      ordersFrom: null,
      normalizedFrom: "2026-08-12T01:30:00.000Z",
    });
    expect(s.db.select().from(logicalCards).all()).toHaveLength(2);
    expect(s.account()?.ledgerDirtyFrom).toBeNull();
    expect(s.activityOf(s.rows.authA.id)).toMatchObject({ status: "settled", amountCents: -500 });

    expect(evaluation?.inferredOpenings).toBe(1);
    expect(s.db.select().from(openingBalances).all()).toMatchObject([
      {
        cardId: s.cardId(CARD_B),
        cents: 12_000,
        source: "inferred",
        setByEvaluationId: evaluation?.evaluationId,
      },
    ]);
    const snapshots = s.db
      .select()
      .from(balanceSnapshots)
      .orderBy(asc(balanceSnapshots.cardId))
      .all()
      .map((b) => [b.reportedCents, b.ledgerCents, b.gapCents, b.transient]);
    expect(snapshots).toEqual([
      [1450, 1450, 0, false],
      [10_000, 10_000, 0, false],
    ]);
  });

  test("keeps the sid encrypted and reuses it on the next sync", async () => {
    const s = setup();
    await s.runner.sync(s.accountId, "manual");
    const stored = s.account();
    expect(stored?.sidEnc).not.toContain("sid-1");
    expect(s.secrets.decrypt(stored?.sidEnc as string)).toBe("sid-1");
    expect(stored?.sidExpiresAt).toBe("2026-11-03T12:00:00.000Z");
    expect(s.secrets.decrypt(stored?.tokenEnc as string)).toBe(TOKEN);

    s.twofiat.calls.length = 0;
    await s.runner.sync(s.accountId, "manual");
    expect(s.twofiat.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("an incremental sync re-pulls the overlap and keeps activity ids", async () => {
    const s = setup();
    const authLate = authorization({
      card: CARD_A,
      at: "2026-10-19T09:00:00.000Z",
      amount: "-3.00",
      description: "BAKERY SPRINGFIELD USA",
    });
    s.twofiat.state.transactions.push(authLate);
    s.twofiat.state.cards[0] = card({ id: CARD_A, balance: 11.5 });
    await s.runner.sync(s.accountId, "manual");
    const before = s.activityOf(authLate.id);
    expect(before?.status).toBe("pending");

    s.clock.now = new Date("2026-10-21T12:00:00.000Z");
    s.twofiat.calls.length = 0;
    s.twofiat.state.transactions.push(
      posting({ card: CARD_A, at: "2026-10-20T21:00:00.000Z", amount: "-3.50", description: "BAKERY" }),
    );
    s.twofiat.state.cards[0] = card({ id: CARD_A, balance: 11 });
    const { sync, evaluation } = await s.runner.sync(s.accountId, "scheduled");

    expect(sync).toMatchObject({
      status: "ok",
      rowsNew: 1,
      rowsUpdated: 0,
      windowFrom: "2026-10-13",
      windowTo: "2026-10-21",
    });
    // The overlap is re-pulled, and only the dirty part of the ledger is re-normalised.
    const txCall = s.twofiat.calls.find((c) => c.url.pathname.endsWith("vccTransactions"));
    expect(txCall?.url.searchParams.get("dateFrom")).toBe("2026-10-13");
    expect(sync.normalizedFrom).toBe("2026-10-13T21:00:00.000Z");
    expect(s.activityOf(authLate.id)).toEqual({ id: before?.id, status: "settled", amountCents: -350 });
    expect(evaluation?.reconciliations.find((r) => r.cardId === CARD_A)?.gapCents).toBe(0);
  });

  test("re-pulls recent orders, and picks up a change of status", async () => {
    const s = setup();
    const old = order({ card: CARD_A, at: "2026-10-01T00:00:00.000Z", amount: 100 });
    const recent = order({
      card: CARD_A,
      at: "2026-10-14T00:00:00.000Z",
      amount: 50,
      status: "paid_fully",
      credited: null,
    });
    s.twofiat.state.orders.push(old, recent);
    await s.runner.sync(s.accountId, "manual");

    s.twofiat.state.orders[2] = { ...recent, status: "credited_fully", credited_usd: "50" };
    const { sync } = await s.runner.sync(s.accountId, "manual");

    // Only orders from the overlap before the newest one are re-pulled.
    expect(sync).toMatchObject({
      status: "ok",
      rowsNew: 0,
      rowsUpdated: 1,
      ordersFrom: "2026-10-07T00:00:00.000Z",
    });
    const stored = s.db.select().from(rawOrders).where(eq(rawOrders.twofiatId, recent.id)).get();
    expect(stored?.raw.credited_usd).toBe("50");
    expect(sync.normalizedFrom).toBe("2026-10-07T00:00:00.000Z");
  });

  test("counts stored rows 2fiat stopped returning, and keeps them", async () => {
    const s = setup();
    const verification = authorization({
      card: CARD_A,
      at: "2026-10-18T09:00:00.000Z",
      amount: "-0.00",
      description: "PAYMENT CHECK SPRINGFIELD USA",
    });
    s.twofiat.state.transactions.push(verification);
    await s.runner.sync(s.accountId, "manual");
    s.twofiat.state.transactions = s.twofiat.state.transactions.filter((t) => t.id !== verification.id);

    const { sync } = await s.runner.sync(s.accountId, "manual");
    expect(sync).toMatchObject({
      status: "ok",
      rowsNew: 0,
      rowsUpdated: 0,
      rowsMissing: 1,
      normalizedFrom: null,
    });
    expect(s.db.select().from(rawTransactions).all()).toHaveLength(6);
    const row = s.db
      .select()
      .from(rawTransactions)
      .where(eq(rawTransactions.twofiatId, verification.id))
      .get();
    expect(row?.lastSeenAt).toBe(row?.firstSeenAt);
  });

  test("a failed normalisation keeps the raw rows, and the next sync catches up", async () => {
    const s = setup();
    control.failNormalize = true;
    try {
      const failed = await s.runner.sync(s.accountId, "manual");
      expect(failed.sync).toMatchObject({
        status: "failed",
        failedStage: "normalize",
        error: "the normaliser broke",
      });
      expect(failed.evaluation).toBeUndefined();
    } finally {
      control.failNormalize = false;
    }
    expect(s.db.select().from(rawTransactions).all()).toHaveLength(5);
    expect(s.db.select().from(activities).all()).toHaveLength(0);
    expect(s.account()?.ledgerDirtyFrom).toBe("2026-08-19T01:30:00.000Z");
    expect(() => evaluate(s.db, s.accountId)).toThrow(LedgerNotReadyError);

    const { sync } = await s.runner.sync(s.accountId, "manual");
    // Normalisation resumes from where the failed sync left the ledger dirty.
    expect(sync).toMatchObject({ status: "ok", rowsNew: 0, normalizedFrom: "2026-08-12T01:30:00.000Z" });
    expect(s.account()?.ledgerDirtyFrom).toBeNull();
    expect(s.activityOf(s.rows.authA.id)?.status).toBe("settled");
  });

  test("a failed fetch writes nothing", async () => {
    const s = setup();
    s.twofiat.state.transactions.push(
      authorization({ card: "card-unknown", at: "2026-10-15T00:00:00.000Z", amount: "-1.00" }),
    );

    const { sync } = await s.runner.sync(s.accountId, "manual");
    expect(sync).toMatchObject({ status: "failed", failedStage: "fetch", ingestedAt: null });
    expect(sync.error).toContain("404");
    expect(s.db.select().from(cards).all()).toHaveLength(0);
    expect(s.db.select().from(rawTransactions).all()).toHaveLength(0);
  });

  test("marks balances that moved mid-sync as transient, and infers no opening balance from them", async () => {
    const s = setup();
    s.twofiat.state.balancesAfterRows = { [CARD_B]: 95 };
    const { sync, evaluation } = await s.runner.sync(s.accountId, "manual");

    expect(sync.status).toBe("ok");
    const observations = s.db
      .select()
      .from(balanceObservations)
      .orderBy(asc(balanceObservations.cardId))
      .all();
    expect(observations.map((o) => [o.reportedCents, o.transient])).toEqual([
      [1450, false],
      [9500, true],
    ]);
    expect(evaluation?.inferredOpenings).toBe(0);
    expect(s.db.select().from(openingBalances).all()).toHaveLength(0);
    const snapshot = s.db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.cardId, s.cardId(CARD_B)))
      .get();
    expect(snapshot?.transient).toBe(true);

    // The next sync sees a settled balance and infers it then.
    s.twofiat.state.balancesAfterRows = undefined;
    s.twofiat.state.cards[1] = card({ id: CARD_B, balance: 95 });
    const next = await s.runner.sync(s.accountId, "manual");
    expect(next.evaluation?.inferredOpenings).toBe(1);
  });

  test("leaves cards 2fiat no longer lists out of the evaluation", async () => {
    const s = setup();
    await s.runner.sync(s.accountId, "manual");
    s.twofiat.state.cards = s.twofiat.state.cards.filter((c) => c.id !== CARD_B);

    const { evaluation } = await s.runner.sync(s.accountId, "manual");
    expect(evaluation?.reconciliations.map((r) => r.cardId)).toEqual([CARD_A]);
    expect(s.db.select().from(cards).all()).toHaveLength(2);
  });

  test("a second trigger while a sync runs gets the same sync", async () => {
    const s = setup();
    const first = s.runner.sync(s.accountId, "manual");
    const second = s.runner.sync(s.accountId, "scheduled");
    expect(second).toBe(first);
    await first;
    expect(s.db.select().from(syncs).all()).toHaveLength(1);
  });

  test("refuses to start while another process's sync is running, and recovers interrupted ones", async () => {
    const s = setup();
    s.db.insert(syncs).values({ accountId: s.accountId, trigger: "scheduled", status: "running" }).run();
    await expect(s.runner.sync(s.accountId, "manual")).rejects.toThrow(SyncAlreadyRunningError);

    expect(s.runner.recover()).toBe(1);
    expect(s.db.select().from(syncs).get()).toMatchObject({ status: "failed", error: "interrupted" });
    expect((await s.runner.sync(s.accountId, "manual")).sync.status).toBe("ok");
  });
});

describe("canonicalJson", () => {
  test("ignores key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
});
