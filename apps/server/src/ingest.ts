import type { RawCardDetails, RawOrder, RawTransaction } from "@twofiat/client";
import { and, eq, gte, inArray, isNotNull, lt, max } from "drizzle-orm";
import { chunks, type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import {
  accounts,
  balanceObservations,
  cards,
  logicalCards,
  rawOrders,
  rawTransactions,
  syncs,
} from "./db/schema.ts";
import { addDays, daysBefore, utcDay } from "./time.ts";

/** Everything one sync fetched from 2fiat. */
export interface Pull {
  /** Details of every listed card, and of any unlisted card the rows refer to that we don't know yet. */
  cards: RawCardDetails[];
  /** Reported balances of the listed cards, by 2fiat card id. */
  balances: Map<string, { cents: number; transient: boolean }>;
  observedAt: string;
  transactions: RawTransaction[];
  /** The transaction window fetched (UTC days, inclusive). */
  window: { from: string; to: string };
  orders: RawOrder[];
  /** Orders were fetched back to this time; undefined when all were fetched. */
  ordersFrom: string | undefined;
}

export interface PullPlan {
  /** Where the transaction window starts, if the account has been pulled before. */
  transactionsFrom: string | undefined;
  ordersFrom: string | undefined;
  /** The 2fiat ids of the cards already stored. */
  knownCards: Set<string>;
}

/**
 * What the next pull needs to fetch. Transactions are re-pulled from `overlapDays` before the last pulled window
 * ended, to catch rows 2fiat changes or backdates. Orders are re-pulled from `overlapDays` before the newest one
 * stored: an order is paid within hours or never (its invoice times out), so only recent ones can still change.
 */
export function planPull(db: Db, accountId: number, overlapDays: number): PullPlan {
  const lastWindow = db
    .select({ to: max(syncs.windowTo) })
    .from(syncs)
    .where(and(eq(syncs.accountId, accountId), isNotNull(syncs.ingestedAt)))
    .get()?.to;
  const newestOrder = db
    .select({ at: max(rawOrders.createdAt) })
    .from(rawOrders)
    .where(eq(rawOrders.accountId, accountId))
    .get()?.at;
  const knownCards = new Set(
    db
      .select({ twofiatId: cards.twofiatId })
      .from(cards)
      .where(eq(cards.accountId, accountId))
      .all()
      .map((c) => c.twofiatId),
  );
  return {
    transactionsFrom: lastWindow ? addDays(lastWindow, -overlapDays) : undefined,
    ordersFrom: newestOrder ? daysBefore(newestOrder, overlapDays) : undefined,
    knownCards,
  };
}

/**
 * Where a pull's transaction window starts: the planned start, or earlier to cover the whole life of any card
 * not seen before (all of them, on an account's first pull).
 */
export function windowStart(plan: PullPlan, details: RawCardDetails[], today: string): string {
  const starts = details
    .filter((c) => !plan.knownCards.has(c.id))
    .map((c) => addDays(utcDay(c.createdAt), -1));
  if (plan.transactionsFrom) starts.push(plan.transactionsFrom);
  return starts.sort()[0] ?? today;
}

export interface IngestResult {
  rowsNew: number;
  rowsUpdated: number;
  rowsMissing: number;
  newCards: number;
  /** The earliest new or changed row, from which the ledger needs re-normalising. */
  dirtyFrom: string | undefined;
}

/**
 * Writes one pull: cards (creating a logical card for each new one), raw rows and balance observations. Marks the
 * ledger dirty from the earliest new or changed row, and records the counts on the sync, all in one transaction.
 *
 * Unchanged rows only get their last-seen time bumped. Stored rows inside the fetched windows that 2fiat didn't
 * return are counted as missing and kept.
 */
export function ingest(db: Db, accountId: number, syncId: number, pull: Pull): IngestResult {
  return db.transaction((q) => {
    const now = new Date().toISOString();
    const newCards = upsertCards(q, accountId, pull.cards, now);
    const cardIds = new Map(
      q
        .select({ id: cards.id, twofiatId: cards.twofiatId })
        .from(cards)
        .where(eq(cards.accountId, accountId))
        .all()
        .map((c) => [c.twofiatId, c.id]),
    );
    const cardId = (twofiatId: string) => {
      const id = cardIds.get(twofiatId);
      if (id === undefined) throw new Error(`No card ${twofiatId} in account ${accountId}`);
      return id;
    };

    const tx = upsertRows(
      q,
      rawTransactions,
      accountId,
      pull.transactions.map((raw) => ({ raw, cardId: cardId(raw.cardId) })),
      now,
    );
    const orders = upsertRows(
      q,
      rawOrders,
      accountId,
      pull.orders.map((raw) => ({ raw, cardId: raw.cardId === null ? null : cardId(raw.cardId) })),
      now,
    );

    const missingTx = countMissing(
      q,
      rawTransactions,
      accountId,
      new Set(pull.transactions.map((t) => t.id)),
      `${pull.window.from}T00:00:00.000Z`,
      `${addDays(pull.window.to, 1)}T00:00:00.000Z`,
    );
    const missingOrders = countMissing(
      q,
      rawOrders,
      accountId,
      new Set(pull.orders.map((o) => o.id)),
      pull.ordersFrom ?? "",
    );

    for (const [twofiatId, balance] of pull.balances) {
      q.insert(balanceObservations)
        .values({
          cardId: cardId(twofiatId),
          syncId,
          reportedCents: balance.cents,
          observedAt: pull.observedAt,
          transient: balance.transient,
        })
        .run();
    }

    const dirtyFrom = [tx.dirtyFrom, orders.dirtyFrom].filter((t) => t !== undefined).sort()[0];
    if (dirtyFrom !== undefined) {
      const current = q
        .select({ dirtyFrom: accounts.ledgerDirtyFrom })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get()?.dirtyFrom;
      const next = current === null || current === undefined || dirtyFrom < current ? dirtyFrom : current;
      q.update(accounts).set({ ledgerDirtyFrom: next }).where(eq(accounts.id, accountId)).run();
    }

    const result = {
      rowsNew: tx.inserted + orders.inserted,
      rowsUpdated: tx.updated + orders.updated,
      rowsMissing: missingTx + missingOrders,
      newCards,
      dirtyFrom,
    };
    q.update(syncs)
      .set({
        ingestedAt: now,
        rowsNew: result.rowsNew,
        rowsUpdated: result.rowsUpdated,
        rowsMissing: result.rowsMissing,
        windowFrom: pull.window.from,
        windowTo: pull.window.to,
        ordersFrom: pull.ordersFrom ?? null,
      })
      .where(eq(syncs.id, syncId))
      .run();
    return result;
  }, IMMEDIATE);
}

function upsertCards(q: Executor, accountId: number, details: RawCardDetails[], now: string): number {
  let created = 0;
  for (const raw of details) {
    const values = {
      alias: raw.alias,
      maskedNumber: raw.cardNumber,
      currency: raw.currency,
      product: raw.cardProduct.title,
      status: raw.status,
      issuedAt: new Date(raw.createdAt).toISOString(),
      expiresAt: new Date(raw.expireDate).toISOString(),
      raw,
      updatedAt: now,
    };
    const existing = q
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.accountId, accountId), eq(cards.twofiatId, raw.id)))
      .get();
    if (existing) {
      q.update(cards).set(values).where(eq(cards.id, existing.id)).run();
      continue;
    }
    const logicalCardId = q
      .insert(logicalCards)
      .values({ accountId, name: raw.alias })
      .returning({ id: logicalCards.id })
      .get().id;
    q.insert(cards)
      .values({ ...values, accountId, logicalCardId, twofiatId: raw.id, firstSeenAt: now })
      .run();
    created++;
  }
  return created;
}

type RawTable = typeof rawTransactions | typeof rawOrders;

function upsertRows(
  q: Executor,
  table: RawTable,
  accountId: number,
  rows: { raw: RawTransaction | RawOrder; cardId: number | null }[],
  now: string,
) {
  const stored = new Map<string, { id: number; createdAt: string; raw: unknown }>();
  for (const chunk of chunks(rows.map((r) => r.raw.id))) {
    const found = q
      .select({ id: table.id, twofiatId: table.twofiatId, createdAt: table.createdAt, raw: table.raw })
      .from(table)
      .where(and(eq(table.accountId, accountId), inArray(table.twofiatId, chunk)))
      .all();
    for (const r of found) stored.set(r.twofiatId, r);
  }

  let inserted = 0;
  let updated = 0;
  let dirtyFrom: string | undefined;
  const dirty = (at: string) => {
    if (dirtyFrom === undefined || at < dirtyFrom) dirtyFrom = at;
  };
  const unchanged: number[] = [];
  for (const { raw, cardId } of rows) {
    const createdAt = new Date(raw.createdAt).toISOString();
    const old = stored.get(raw.id);
    if (!old) {
      // Drizzle can't type an insert into a union of tables; the two raw tables share these columns.
      q.insert(table as typeof rawOrders)
        .values({
          accountId,
          cardId,
          twofiatId: raw.id,
          createdAt,
          raw: raw as RawOrder,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();
      inserted++;
      dirty(createdAt);
    } else if (canonicalJson(old.raw) !== canonicalJson(raw)) {
      q.update(table as typeof rawOrders)
        .set({ cardId, createdAt, raw: raw as RawOrder, lastSeenAt: now })
        .where(eq(table.id, old.id))
        .run();
      updated++;
      // The row's old activity sits at its old time, so re-normalise from whichever is earlier.
      dirty(old.createdAt);
      dirty(createdAt);
    } else {
      unchanged.push(old.id);
    }
  }
  for (const chunk of chunks(unchanged)) {
    q.update(table as typeof rawOrders)
      .set({ lastSeenAt: now })
      .where(inArray(table.id, chunk))
      .run();
  }
  return { inserted, updated, dirtyFrom };
}

/** Stored rows created in [from, to) that the pull didn't return. */
function countMissing(
  q: Executor,
  table: RawTable,
  accountId: number,
  fetched: Set<string>,
  from: string,
  to?: string,
): number {
  const conditions = [eq(table.accountId, accountId), gte(table.createdAt, from)];
  if (to !== undefined) conditions.push(lt(table.createdAt, to));
  return q
    .select({ twofiatId: table.twofiatId })
    .from(table)
    .where(and(...conditions))
    .all()
    .filter((r) => !fetched.has(r.twofiatId)).length;
}

/** JSON with object keys sorted, so equal values compare equal whatever order their keys came in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
