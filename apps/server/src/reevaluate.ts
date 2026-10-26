import { NORMALIZER_VERSION } from "@twofiat/client";
import { eq, lt } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { accounts, activities } from "./db/schema.ts";
import { type EvaluateResult, evaluate } from "./evaluate.ts";
import { markForRebuild, normalizeAccount } from "./ledger.ts";

/**
 * Brings an account's ledger up to date with the raw rows already stored and evaluates it again, without
 * fetching from 2fiat: e.g. after an opening balance edit, or a normaliser change.
 *
 * Safe alongside a running sync in this process: both stages are synchronous, so they never interleave with the
 * sync's own, and they don't depend on its fetch.
 */
export function reevaluate(db: Db, accountId: number, now: Date): EvaluateResult | undefined {
  normalizeAccount(db, accountId);
  return evaluate(db, accountId, { asOf: now.toISOString() });
}

/**
 * Rebuilds and re-evaluates every account whose ledger an older normaliser wrote. Run at startup. Returns the
 * accounts it rebuilt.
 */
export function rebuildOutdated(db: Db, now: Date): number[] {
  const outdated = db
    .selectDistinct({ id: accounts.id })
    .from(accounts)
    .innerJoin(activities, eq(activities.accountId, accounts.id))
    .where(lt(activities.normalizerVersion, NORMALIZER_VERSION))
    .all()
    .map((a) => a.id);
  for (const id of outdated) {
    markForRebuild(db, id);
    reevaluate(db, id, now);
  }
  return outdated;
}
