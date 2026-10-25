import { type Activity, NORMALIZER_VERSION, normalize } from "@twofiat/client";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { chunks, type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import {
  activities,
  activityAnnotations,
  activitySources,
  cards,
  rawOrders,
  rawTransactions,
} from "./db/schema.ts";

export interface RenormalizeResult {
  /** Where the slice actually started, after widening it to whole activities. */
  from: string;
  inserted: number;
  updated: number;
  deleted: number;
}

/**
 * Re-normalises an account's raw rows from `from` onwards (everything when omitted) and writes the result.
 *
 * Callers pass LOOKBACK_DAYS before the earliest new row. The slice is then widened back until no activity
 * straddles its start, so every raw row in it is re-normalised along with every row it was grouped with.
 *
 * Activity ids are stable: a new activity takes over the id of the old one it shares the most rows with,
 * preferring the oldest id, so when activities merge the oldest survives. An old activity that no new one takes
 * over has merged into another one, and its annotation is merged into that one's.
 */
export function renormalize(db: Db, accountId: number, from = ""): RenormalizeResult {
  return db.transaction((q) => {
    const sliceFrom = widenSlice(q, accountId, from);

    const cardRows = q.select().from(cards).where(eq(cards.accountId, accountId)).all();
    const cardIds = new Map(cardRows.map((c) => [c.twofiatId, c.id]));
    const txRows = q
      .select({ id: rawTransactions.id, twofiatId: rawTransactions.twofiatId, raw: rawTransactions.raw })
      .from(rawTransactions)
      .where(and(eq(rawTransactions.accountId, accountId), gte(rawTransactions.createdAt, sliceFrom)))
      .all();
    const orderRows = q
      .select({ id: rawOrders.id, twofiatId: rawOrders.twofiatId, raw: rawOrders.raw })
      .from(rawOrders)
      .where(and(eq(rawOrders.accountId, accountId), gte(rawOrders.createdAt, sliceFrom)))
      .all();

    const fresh = normalize({
      transactions: txRows.map((r) => r.raw),
      orders: orderRows.map((r) => r.raw),
      cards: cardRows.map((c) => c.raw),
    });

    // Sources are keyed "t<raw id>" or "o<raw id>" by our raw-row ids.
    const txIds = new Map(txRows.map((r) => [r.twofiatId, r.id]));
    const orderIds = new Map(orderRows.map((r) => [r.twofiatId, r.id]));
    const sourcesOf = (a: Activity) => [
      ...a.sources.transactionIds.map((id) => `t${txIds.get(id)}`),
      ...a.sources.orderIds.map((id) => `o${orderIds.get(id)}`),
    ];

    // After widening, these are all the sources of every old activity in the slice.
    const oldSources = q.all<{ activity_id: number; source: string }>(sql`
      SELECT s.activity_id, coalesce('t' || s.raw_transaction_id, 'o' || s.raw_order_id) AS source
      FROM activity_sources s
      LEFT JOIN raw_transactions t ON t.id = s.raw_transaction_id
      LEFT JOIN raw_orders o ON o.id = s.raw_order_id
      WHERE coalesce(t.account_id, o.account_id) = ${accountId}
        AND coalesce(t.created_at, o.created_at) >= ${sliceFrom}`);
    const oldBySource = new Map(oldSources.map((s) => [s.source, s.activity_id]));
    const oldIds = [...new Set(oldSources.map((s) => s.activity_id))];

    const overlaps: { index: number; oldId: number; shared: number }[] = [];
    fresh.forEach((a, index) => {
      const shared = new Map<number, number>();
      for (const source of sourcesOf(a)) {
        const oldId = oldBySource.get(source);
        if (oldId !== undefined) shared.set(oldId, (shared.get(oldId) ?? 0) + 1);
      }
      for (const [oldId, n] of shared) overlaps.push({ index, oldId, shared: n });
    });

    // Oldest id first, then the new activity sharing the most rows with it.
    overlaps.sort((x, y) => x.oldId - y.oldId || y.shared - x.shared || x.index - y.index);
    const ids: (number | undefined)[] = fresh.map(() => undefined);
    const kept = new Set<number>();
    for (const o of overlaps) {
      if (ids[o.index] === undefined && !kept.has(o.oldId)) {
        ids[o.index] = o.oldId;
        kept.add(o.oldId);
      }
    }
    const dropped = oldIds.filter((id) => !kept.has(id));
    // Each dropped activity's rows went mostly to one new activity: that's where its annotation goes.
    const mergedInto = new Map<number, number>();
    for (const o of [...overlaps].sort((x, y) => y.shared - x.shared || x.index - y.index)) {
      if (!kept.has(o.oldId) && !mergedInto.has(o.oldId)) mergedInto.set(o.oldId, o.index);
    }

    const droppedNotes = [];
    for (const chunk of chunks(dropped)) {
      droppedNotes.push(
        ...q.select().from(activityAnnotations).where(inArray(activityAnnotations.activityId, chunk)).all(),
      );
    }
    for (const chunk of chunks(oldIds)) {
      q.delete(activitySources).where(inArray(activitySources.activityId, chunk)).run();
    }
    for (const chunk of chunks(dropped)) q.delete(activities).where(inArray(activities.id, chunk)).run();
    // Keys are unique per account and may move between kept activities, so clear them out of the way first.
    for (const chunk of chunks([...kept])) {
      q.update(activities)
        .set({ key: sql`'~' || ${activities.id}` })
        .where(inArray(activities.id, chunk))
        .run();
    }

    const cardId = (twofiatId: string) => {
      const id = cardIds.get(twofiatId);
      if (id === undefined) throw new Error(`No card ${twofiatId} in account ${accountId}`);
      return id;
    };
    fresh.forEach((a, index) => {
      const row = {
        accountId,
        cardId: cardId(a.cardId),
        key: a.key,
        kind: a.kind,
        status: a.status,
        amountCents: a.amountCents,
        authorizedAmountCents: a.authorizedAmountCents ?? null,
        attemptedAmountCents: a.attemptedAmountCents ?? null,
        requestedAmountCents: a.requestedAmountCents ?? null,
        feeCents: a.feeCents ?? null,
        currency: a.currency,
        occurredAt: a.occurredAt,
        settledAt: a.settledAt ?? null,
        description: a.description,
        postedDescription: a.postedDescription ?? null,
        orderTwofiatId: a.orderId ?? null,
        transferId: a.transferId ?? null,
        counterpartCardId:
          a.counterpartCardId === undefined ? null : (cardIds.get(a.counterpartCardId) ?? null),
        flags: a.flags,
        normalizerVersion: NORMALIZER_VERSION,
      };
      let id = ids[index];
      if (id === undefined) {
        id = q.insert(activities).values(row).returning({ id: activities.id }).get().id;
        ids[index] = id;
      } else {
        q.update(activities).set(row).where(eq(activities.id, id)).run();
      }
      const activityId = id;
      q.insert(activitySources)
        .values([
          ...a.sources.transactionIds.map((t) => ({ activityId, rawTransactionId: txIds.get(t) })),
          ...a.sources.orderIds.map((o) => ({ activityId, rawOrderId: orderIds.get(o) })),
        ])
        .run();
    });

    for (const note of droppedNotes) {
      const index = mergedInto.get(note.activityId);
      const into = index === undefined ? undefined : ids[index];
      if (into !== undefined) mergeAnnotation(q, into, note);
    }

    return {
      from: sliceFrom,
      inserted: fresh.length - kept.size,
      updated: kept.size,
      deleted: dropped.length,
    };
  }, IMMEDIATE);
}

/** Moves `from` back until no activity has rows on both sides of it. */
function widenSlice(q: Executor, accountId: number, from: string): string {
  let start = from;
  for (;;) {
    const row = q.get<{ earliest: string | null }>(sql`
      WITH src AS (
        SELECT s.activity_id, coalesce(t.created_at, o.created_at) AS created_at
        FROM activity_sources s
        LEFT JOIN raw_transactions t ON t.id = s.raw_transaction_id
        LEFT JOIN raw_orders o ON o.id = s.raw_order_id
        WHERE coalesce(t.account_id, o.account_id) = ${accountId}
      )
      SELECT min(created_at) AS earliest FROM src
      WHERE activity_id IN (SELECT activity_id FROM src WHERE created_at >= ${start})`);
    if (row.earliest === null || row.earliest >= start) return start;
    start = row.earliest;
  }
}

type Annotation = typeof activityAnnotations.$inferSelect;

/** The survivor keeps its category (taking the merged one's if it has none), and the notes are joined. */
function mergeAnnotation(q: Executor, into: number, from: Annotation) {
  const existing = q.select().from(activityAnnotations).where(eq(activityAnnotations.activityId, into)).get();
  if (!existing) {
    q.insert(activityAnnotations)
      .values({ activityId: into, categoryId: from.categoryId, note: from.note })
      .run();
    return;
  }
  const note = [existing.note, from.note].filter(Boolean).join("\n\n") || null;
  q.update(activityAnnotations)
    .set({ categoryId: existing.categoryId ?? from.categoryId, note, updatedAt: new Date().toISOString() })
    .where(eq(activityAnnotations.activityId, into))
    .run();
}
