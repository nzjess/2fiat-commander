import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { activities, activityAnnotations, cards } from "./db/schema.ts";

/** One movement of money on a logical card. */
export interface Flow {
  id: number;
  cardId: number;
  at: string;
  kind: (typeof activities.$inferSelect)["kind"];
  status: (typeof activities.$inferSelect)["status"];
  /** Signed: negative is money out. */
  amountCents: number;
  description: string;
  /** Set on spending only (`CATEGORY_KINDS`). */
  categoryId: number | null;
}

/**
 * A logical card's money in and out, oldest first: every activity that moved its balance (holds included, as the
 * ledger counts them), except transfers between its own physical cards, which only move money within it.
 */
export function cashFlow(db: Db, accountId: number, logicalCardId: number): Flow[] | undefined {
  const ids = db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.accountId, accountId), eq(cards.logicalCardId, logicalCardId)))
    .all()
    .map((c) => c.id);
  if (ids.length === 0) return undefined;
  const own = new Set(ids);
  return db
    .select({
      id: activities.id,
      cardId: activities.cardId,
      at: activities.occurredAt,
      kind: activities.kind,
      status: activities.status,
      amountCents: activities.amountCents,
      description: activities.description,
      categoryId: activityAnnotations.categoryId,
      counterpartCardId: activities.counterpartCardId,
    })
    .from(activities)
    .leftJoin(activityAnnotations, eq(activityAnnotations.activityId, activities.id))
    .where(and(inArray(activities.cardId, ids), ne(activities.amountCents, 0)))
    .orderBy(asc(activities.occurredAt), asc(activities.id))
    .all()
    .filter((a) => a.counterpartCardId === null || !own.has(a.counterpartCardId))
    .map(({ counterpartCardId: _, ...flow }) => flow);
}
