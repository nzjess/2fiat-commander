import { NORMALIZER_VERSION } from "@twofiat/client";
import { and, eq } from "drizzle-orm";
import { type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import {
  activities,
  activitySources,
  adjustments,
  cards,
  evaluations,
  openingBalances,
  rawOrders,
} from "./db/schema.ts";

export type AdjustmentRow = typeof adjustments.$inferSelect;

export interface AdjustmentInput {
  /** Signed: positive is money added to the card. */
  cents: number;
  occurredAt: string;
  note: string;
}

export class AdjustmentNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "AdjustmentNotFoundError";
  }
}

/**
 * Records money 2fiat moved without a row, as an adjustment and its activity. The caller re-evaluates the account.
 * The card must be in the account. With `topupActivityId`, the adjustment completes that top-up's order: e.g. a
 * top-up paid short whose rest support credited by hand.
 */
export function createAdjustment(
  db: Db,
  accountId: number,
  cardId: number,
  input: AdjustmentInput,
  { topupActivityId }: { topupActivityId?: number } = {},
): AdjustmentRow {
  return db.transaction((q) => {
    const card = q
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.accountId, accountId)))
      .get();
    if (!card) throw new AdjustmentNotFoundError("card");
    const rawOrderId =
      topupActivityId === undefined ? null : orderOfTopup(q, accountId, cardId, topupActivityId);
    const adjustment = q
      .insert(adjustments)
      .values({ accountId, cardId, rawOrderId, ...input })
      .returning()
      .get();
    writeActivity(q, adjustment);
    compensateOpening(q, cardId, undefined, adjustment);
    return adjustment;
  }, IMMEDIATE);
}

export function updateAdjustment(
  db: Db,
  accountId: number,
  id: number,
  input: Partial<AdjustmentInput>,
): AdjustmentRow {
  return db.transaction((q) => {
    const before = adjustmentOf(q, accountId, id);
    const after = q
      .update(adjustments)
      .set({ ...input, updatedAt: new Date().toISOString() })
      .where(eq(adjustments.id, id))
      .returning()
      .get();
    writeActivity(q, after);
    compensateOpening(q, after.cardId, before, after);
    return after;
  }, IMMEDIATE);
}

export function deleteAdjustment(db: Db, accountId: number, id: number): void {
  db.transaction((q) => {
    const before = adjustmentOf(q, accountId, id);
    const activityId = activityOf(q, id);
    if (activityId !== undefined) q.delete(activities).where(eq(activities.id, activityId)).run();
    q.delete(adjustments).where(eq(adjustments.id, id)).run();
    compensateOpening(q, before.cardId, before, undefined);
  }, IMMEDIATE);
}

function adjustmentOf(q: Executor, accountId: number, id: number): AdjustmentRow {
  const adjustment = q
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.id, id), eq(adjustments.accountId, accountId)))
    .get();
  if (!adjustment) throw new AdjustmentNotFoundError("adjustment");
  return adjustment;
}

/** The raw order behind a top-up activity on the card. */
function orderOfTopup(q: Executor, accountId: number, cardId: number, activityId: number): number {
  const order = q
    .select({ id: rawOrders.id })
    .from(activities)
    .innerJoin(
      rawOrders,
      and(eq(rawOrders.accountId, activities.accountId), eq(rawOrders.twofiatId, activities.orderTwofiatId)),
    )
    .where(
      and(
        eq(activities.id, activityId),
        eq(activities.accountId, accountId),
        eq(activities.cardId, cardId),
        eq(activities.kind, "topup"),
      ),
    )
    .get();
  if (!order) throw new AdjustmentNotFoundError("top-up");
  return order.id;
}

/** The id of the activity an adjustment is the source of. */
export function activityOf(q: Executor, adjustmentId: number): number | undefined {
  return q
    .select({ id: activitySources.activityId })
    .from(activitySources)
    .where(eq(activitySources.adjustmentId, adjustmentId))
    .get()?.id;
}

/** Creates or updates the adjustment's activity. Re-normalisation never touches it: it has no raw rows. */
function writeActivity(q: Executor, a: AdjustmentRow) {
  const card = q.select({ currency: cards.currency }).from(cards).where(eq(cards.id, a.cardId)).get();
  const order =
    a.rawOrderId === null
      ? undefined
      : q
          .select({ twofiatId: rawOrders.twofiatId })
          .from(rawOrders)
          .where(eq(rawOrders.id, a.rawOrderId))
          .get();
  const values = {
    accountId: a.accountId,
    cardId: a.cardId,
    key: `adjustment:${a.id}`,
    kind: "adjustment" as const,
    status: "settled" as const,
    amountCents: a.cents,
    currency: card?.currency ?? "USD",
    occurredAt: a.occurredAt,
    settledAt: a.occurredAt,
    description: a.note,
    // Names the order it completes, so reconciliation counts it towards that order's credit.
    orderTwofiatId: order?.twofiatId ?? null,
    flags: [],
    normalizerVersion: NORMALIZER_VERSION,
  };
  const existing = activityOf(q, a.id);
  if (existing !== undefined) {
    q.update(activities).set(values).where(eq(activities.id, existing)).run();
    return;
  }
  const activityId = q.insert(activities).values(values).returning({ id: activities.id }).get().id;
  q.insert(activitySources).values({ activityId, adjustmentId: a.id }).run();
}

/**
 * An inferred opening balance absorbed everything its card's ledger couldn't explain when it was inferred. An
 * adjustment dated before then accounts for part of that, so the opening moves by the opposite of its change:
 * the opening plus those adjustments stays what was inferred, and so does every gap since. Adjustments dated
 * after the inference, and opening balances the user entered, are left alone.
 */
function compensateOpening(
  q: Executor,
  cardId: number,
  before: Pick<AdjustmentRow, "cents" | "occurredAt"> | undefined,
  after: Pick<AdjustmentRow, "cents" | "occurredAt"> | undefined,
) {
  const opening = q
    .select({ cents: openingBalances.cents, setAt: openingBalances.setAt, inferredAt: evaluations.asOf })
    .from(openingBalances)
    .leftJoin(evaluations, eq(evaluations.id, openingBalances.setByEvaluationId))
    .where(and(eq(openingBalances.cardId, cardId), eq(openingBalances.source, "inferred")))
    .get();
  if (!opening) return;
  const inferredAt = opening.inferredAt ?? opening.setAt;
  const absorbed = (a: typeof before) => (a && a.occurredAt < inferredAt ? a.cents : 0);
  const change = absorbed(after) - absorbed(before);
  if (change === 0) return;
  q.update(openingBalances)
    .set({ cents: opening.cents - change })
    .where(eq(openingBalances.cardId, cardId))
    .run();
}
