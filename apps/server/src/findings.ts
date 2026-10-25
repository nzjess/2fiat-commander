import type { CardReconciliation, FindingKind } from "@twofiat/client";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, IMMEDIATE } from "./db/db.ts";
import { activities, cards, findings } from "./db/schema.ts";

/** Kinds about the card as a whole: one per card, whatever the amount or the activities involved. */
const CARD_LEVEL = new Set<FindingKind>([
  "balance-gap",
  "history-incomplete",
  "fees-above-advertised",
  "topup-fee-above-advertised",
]);

/**
 * A finding's identity across syncs, within its card. Built from our stable activity ids rather than activity
 * keys, which can change when re-matching picks another anchor row.
 */
export function findingFingerprint(kind: FindingKind, activityIds: number[]): string {
  if (CARD_LEVEL.has(kind)) return kind;
  return `${kind}:${[...activityIds].sort((a, b) => a - b).join(",")}`;
}

export interface RecordFindingsResult {
  /** New, or back after being resolved. */
  opened: number;
  /** Still there from an earlier sync. */
  continued: number;
  resolved: number;
}

/**
 * Records one sync's findings for the given cards. A finding seen before is updated in place; an open one that
 * this sync no longer sees is marked resolved by it. Cards not passed are left alone.
 */
export function recordFindings(
  db: Db,
  accountId: number,
  syncId: number,
  reconciliations: Pick<CardReconciliation, "cardId" | "findings">[],
): RecordFindingsResult {
  return db.transaction((q) => {
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
        const fingerprint = findingFingerprint(f.kind, ids);
        seen.add(fingerprint);
        const values = {
          cents: f.cents ?? null,
          message: f.message,
          activityIds: ids,
          lastSeenSyncId: syncId,
        };

        const existing = q
          .select()
          .from(findings)
          .where(and(eq(findings.cardId, cardId), eq(findings.fingerprint, fingerprint)))
          .get();
        if (existing) {
          q.update(findings)
            .set({ ...values, resolvedSyncId: null })
            .where(eq(findings.id, existing.id))
            .run();
          if (existing.resolvedSyncId === null) result.continued++;
          else result.opened++;
        } else {
          q.insert(findings)
            .values({ ...values, cardId, kind: f.kind, fingerprint, firstSeenSyncId: syncId })
            .run();
          result.opened++;
        }
      }

      const open = q
        .select({ id: findings.id, fingerprint: findings.fingerprint })
        .from(findings)
        .where(and(eq(findings.cardId, cardId), isNull(findings.resolvedSyncId)))
        .all();
      for (const f of open) {
        if (seen.has(f.fingerprint)) continue;
        q.update(findings).set({ resolvedSyncId: syncId }).where(eq(findings.id, f.id)).run();
        result.resolved++;
      }
    }
    return result;
  }, IMMEDIATE);
}
