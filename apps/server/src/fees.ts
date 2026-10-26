import { type FeeComparison, productTerms, reconcile } from "@twofiat/client";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Executor } from "./db/db.ts";
import { activities, cards, logicalCards } from "./db/schema.ts";
import { loadReconcileInput } from "./evaluate.ts";

export type FeeKind = "topup" | "transaction";

/**
 * What a logical card's fees came to, per physical card: charged, what the advert implies, and what the accepted
 * schedules imply. Computed now from the stored ledger; nothing is stored. Undefined if there's no such logical card.
 */
export function feeComparisons(
  q: Executor,
  accountId: number,
  logicalCardId: number,
  asOf: string,
): { cardId: number; product: string; transaction: FeeComparison; topup: FeeComparison }[] | undefined {
  const logical = q
    .select({ id: logicalCards.id })
    .from(logicalCards)
    .where(and(eq(logicalCards.id, logicalCardId), eq(logicalCards.accountId, accountId)))
    .get();
  if (!logical) return undefined;
  const loaded = loadReconcileInput(q, accountId, asOf);
  if (!loaded) return [];
  return reconcile(loaded.input).flatMap((r) => {
    const card = loaded.byTwofiatId.get(r.cardId)?.card;
    if (card?.logicalCardId !== logicalCardId) return [];
    return [{ cardId: card.id, product: card.product, ...r.feeComparison }];
  });
}

/**
 * What to accept as 2fiat's practice for a card's product, from what it has charged, starting at the start of its
 * history so every past fee is checked against it. Top-ups: 2fiat's own configured rate (else the commonest rate
 * charged). Transaction fees: the commonest fee, for each authorisation and each posting, as 2fiat charges both.
 * Undefined if the card isn't the account's, or it hasn't been charged that kind of fee yet.
 */
export function suggestSchedule(q: Executor, accountId: number, cardId: number, kind: FeeKind) {
  const card = q
    .select()
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.accountId, accountId)))
    .get();
  if (!card) return undefined;
  const productCards = q
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.accountId, accountId), eq(cards.product, card.product)));

  if (kind === "topup") {
    const topups = q
      .select({
        at: activities.occurredAt,
        fee: activities.feeCents,
        requested: activities.requestedAmountCents,
      })
      .from(activities)
      .where(
        and(
          inArray(activities.cardId, productCards),
          eq(activities.kind, "topup"),
          isNotNull(activities.feeCents),
          isNotNull(activities.requestedAmountCents),
        ),
      )
      .orderBy(asc(activities.occurredAt))
      .all();
    const first = topups[0];
    if (!first) return undefined;
    const configured = productTerms(card.raw).topupFeeRate;
    const rateBps =
      configured === undefined
        ? commonest(topups.map((t) => Math.round(((t.fee ?? 0) / (t.requested || 1)) * 10_000)))
        : Math.round(configured * 10_000);
    return { product: card.product, kind: "topup" as const, effectiveFrom: first.at, rateBps };
  }

  const fees = q
    .select({ at: activities.occurredAt, cents: activities.amountCents })
    .from(activities)
    .where(and(inArray(activities.cardId, productCards), eq(activities.kind, "fee")))
    .orderBy(asc(activities.occurredAt))
    .all();
  const first = fees[0];
  if (!first) return undefined;
  const fee = commonest(fees.map((f) => Math.abs(f.cents)));
  return {
    product: card.product,
    kind: "transaction" as const,
    effectiveFrom: first.at,
    authorizationFeeCents: fee,
    postingFeeCents: fee,
  };
}

function commonest(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}
