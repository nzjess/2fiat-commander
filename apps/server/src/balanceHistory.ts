import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { activities, balanceSnapshots, cards, evaluations, openingBalances } from "./db/schema.ts";

export interface BalancePoint {
  at: string;
  /** The logical card's ledger balance after this change. */
  cents: number;
  /** What changed it: an activity, or a physical card's opening balance (null). */
  activity: { id: number; cardId: number; kind: string; description: string; amountCents: number } | null;
  /** For an opening balance: the physical card it belongs to. */
  openingCardId: number | null;
}

export interface BalanceHistory {
  /** Oldest first: one per change to the ledger. */
  points: BalancePoint[];
  /** What 2fiat reported at each evaluation, summed over the cards it saw. */
  reported: { at: string; cents: number }[];
}

/**
 * A logical card's running ledger balance: its physical cards' opening balances, then every activity in time
 * order, as the ledger counts them (holds included). Transfers between its own cards cancel out, so a replaced
 * card reads as one continuous balance. Opening balances count only for cards with no issue in their history, as
 * in reconciliation, and each comes in just before its card's first activity.
 */
export function balanceHistory(db: Db, accountId: number, logicalCardId: number): BalanceHistory | undefined {
  const members = db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.accountId, accountId), eq(cards.logicalCardId, logicalCardId)))
    .all();
  if (members.length === 0) return undefined;
  const ids = members.map((m) => m.id);

  const rows = db
    .select({
      id: activities.id,
      cardId: activities.cardId,
      kind: activities.kind,
      description: activities.description,
      amountCents: activities.amountCents,
      occurredAt: activities.occurredAt,
    })
    .from(activities)
    .where(inArray(activities.cardId, ids))
    .orderBy(asc(activities.occurredAt), asc(activities.id))
    .all();
  const openings = db.select().from(openingBalances).where(inArray(openingBalances.cardId, ids)).all();
  const issued = new Set(rows.filter((r) => r.kind === "card_issue").map((r) => r.cardId));
  const pendingOpenings = new Map(
    openings.filter((o) => !issued.has(o.cardId)).map((o) => [o.cardId, o.cents] as const),
  );

  const points: BalancePoint[] = [];
  let cents = 0;
  for (const r of rows) {
    const opening = pendingOpenings.get(r.cardId);
    if (opening !== undefined) {
      pendingOpenings.delete(r.cardId);
      cents += opening;
      points.push({ at: r.occurredAt, cents, activity: null, openingCardId: r.cardId });
    }
    // A zero-amount activity (a decline, a verification, a voided hold) doesn't move the balance.
    if (r.amountCents === 0) continue;
    cents += r.amountCents;
    const { occurredAt, ...activity } = r;
    points.push({ at: occurredAt, cents, activity, openingCardId: null });
  }

  const snapshots = db
    .select({ at: evaluations.asOf, evaluationId: evaluations.id, cents: balanceSnapshots.reportedCents })
    .from(balanceSnapshots)
    .innerJoin(evaluations, eq(evaluations.id, balanceSnapshots.evaluationId))
    .where(inArray(balanceSnapshots.cardId, ids))
    .orderBy(asc(evaluations.id))
    .all();
  const reported: BalanceHistory["reported"] = [];
  for (const s of snapshots) {
    const last = reported.at(-1);
    if (last && last.at === s.at) last.cents += s.cents;
    else reported.push({ at: s.at, cents: s.cents });
  }

  return { points, reported };
}
