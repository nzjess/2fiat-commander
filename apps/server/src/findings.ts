import { type CardReconciliation, dollarsToCents, type FindingKind } from "@twofiat/client";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import { activities, balanceObservations, cards, findings } from "./db/schema.ts";

/** Kinds about the card as a whole: one per card, whatever the amount or the activities involved. */
const CARD_LEVEL = new Set<FindingKind>([
  "card-missing",
  "balance-gap",
  "history-incomplete",
  "fees-above-advertised",
  "topup-fee-above-advertised",
]);

/** Kinds identified by a scope (e.g. the month "2026-10" of a month's fees): their fingerprint is `kind:scope`. */
export const SCOPED_KINDS = ["transaction-fees-off-schedule"] as const satisfies FindingKind[];

/**
 * A finding's identity across evaluations, within its card. Built from our stable activity ids rather than activity
 * keys, which can change when re-matching picks another anchor row. A scoped finding (e.g. a month's fees) is
 * identified by its scope, since its activities keep changing.
 */
export function findingFingerprint(kind: FindingKind, activityIds: number[], scope?: string): string {
  if (scope !== undefined) return `${kind}:${scope}`;
  if (CARD_LEVEL.has(kind)) return kind;
  return `${kind}:${[...activityIds].sort((a, b) => a - b).join(",")}`;
}

export interface RecordFindingsResult {
  /** New, or back after being resolved. */
  opened: number;
  /** Still there from an earlier evaluation. */
  continued: number;
  resolved: number;
}

/** A card's findings, and the kinds this evaluation couldn't judge, whose findings stay exactly as they were. */
type Reconciliations = (Pick<CardReconciliation, "cardId" | "findings"> & { held?: FindingKind[] })[];

/**
 * Records one evaluation's findings for the given cards. A finding seen before is updated in place; an open one
 * that this evaluation no longer sees is marked resolved by it, unless its kind is held. Cards not passed are left
 * alone.
 */
export function recordFindings(
  db: Db,
  accountId: number,
  evaluationId: number,
  reconciliations: Reconciliations,
): RecordFindingsResult {
  return db.transaction((q) => recordFindingsIn(q, accountId, evaluationId, reconciliations), IMMEDIATE);
}

/** `recordFindings` inside the caller's transaction. */
export function recordFindingsIn(
  q: Executor,
  accountId: number,
  evaluationId: number,
  reconciliations: Reconciliations,
): RecordFindingsResult {
  const result = { opened: 0, continued: 0, resolved: 0 };
  const cardIds = new Map(
    q
      .select({ id: cards.id, twofiatId: cards.twofiatId })
      .from(cards)
      .where(eq(cards.accountId, accountId))
      .all()
      .map((c) => [c.twofiatId, c.id]),
  );
  const activityIds = new Map(
    q
      .select({ id: activities.id, key: activities.key })
      .from(activities)
      .where(eq(activities.accountId, accountId))
      .all()
      .map((a) => [a.key, a.id]),
  );

  for (const rec of reconciliations) {
    const cardId = cardIds.get(rec.cardId);
    if (cardId === undefined) throw new Error(`No card ${rec.cardId} in account ${accountId}`);

    const seen = new Set<string>();
    for (const f of rec.findings) {
      const ids = f.activityKeys.map((key) => {
        const id = activityIds.get(key);
        if (id === undefined) throw new Error(`Finding ${f.kind} refers to unknown activity ${key}`);
        return id;
      });
      const fingerprint = findingFingerprint(f.kind, ids, f.scope);
      seen.add(fingerprint);
      const values = {
        cents: f.cents ?? null,
        message: f.message,
        activityIds: ids,
        lastSeenEvaluationId: evaluationId,
      };

      const existing = q
        .select()
        .from(findings)
        .where(and(eq(findings.cardId, cardId), eq(findings.fingerprint, fingerprint)))
        .get();
      if (existing) {
        q.update(findings)
          .set({ ...values, resolvedEvaluationId: null })
          .where(eq(findings.id, existing.id))
          .run();
        if (existing.resolvedEvaluationId === null) result.continued++;
        else result.opened++;
      } else {
        q.insert(findings)
          .values({ ...values, cardId, kind: f.kind, fingerprint, firstSeenEvaluationId: evaluationId })
          .run();
        result.opened++;
      }
    }

    const open = q
      .select({ id: findings.id, kind: findings.kind, fingerprint: findings.fingerprint })
      .from(findings)
      .where(and(eq(findings.cardId, cardId), isNull(findings.resolvedEvaluationId)))
      .all();
    for (const f of open) {
      if (seen.has(f.fingerprint) || rec.held?.includes(f.kind)) continue;
      q.update(findings).set({ resolvedEvaluationId: evaluationId }).where(eq(findings.id, f.id)).run();
      result.resolved++;
    }
  }
  return result;
}

/**
 * Records a `card-missing` finding for each of the account's cards that 2fiat's latest card list left out, and
 * resolves it for a card listed again. A missing card isn't reconciled, so its other findings are left as they were.
 */
export function recordMissingCardsIn(
  q: Executor,
  accountId: number,
  evaluationId: number,
): RecordFindingsResult {
  const result = { opened: 0, continued: 0, resolved: 0 };
  for (const card of q.select().from(cards).where(eq(cards.accountId, accountId)).all()) {
    const existing = q
      .select()
      .from(findings)
      .where(and(eq(findings.cardId, card.id), eq(findings.fingerprint, "card-missing")))
      .get();
    if (card.missingSince === null) {
      if (existing && existing.resolvedEvaluationId === null) {
        q.update(findings)
          .set({ resolvedEvaluationId: evaluationId })
          .where(eq(findings.id, existing.id))
          .run();
        result.resolved++;
      }
      continue;
    }

    // The money at stake: what 2fiat last said the card held.
    const lastCents =
      q
        .select({ cents: balanceObservations.reportedCents })
        .from(balanceObservations)
        .where(eq(balanceObservations.cardId, card.id))
        .orderBy(desc(balanceObservations.syncId))
        .limit(1)
        .get()?.cents ?? dollarsToCents(card.raw.balance);
    const since = new Date(card.missingSince).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const values = {
      cents: -lastCents,
      message: `2fiat no longer lists this card, since ${since}. Its last reported balance was $${(lastCents / 100).toFixed(2)}.`,
      activityIds: [],
      lastSeenEvaluationId: evaluationId,
    };
    if (existing) {
      q.update(findings)
        .set({ ...values, resolvedEvaluationId: null })
        .where(eq(findings.id, existing.id))
        .run();
      if (existing.resolvedEvaluationId === null) result.continued++;
      else result.opened++;
    } else {
      q.insert(findings)
        .values({
          ...values,
          cardId: card.id,
          kind: "card-missing",
          fingerprint: "card-missing",
          firstSeenEvaluationId: evaluationId,
        })
        .run();
      result.opened++;
    }
  }
  return result;
}
