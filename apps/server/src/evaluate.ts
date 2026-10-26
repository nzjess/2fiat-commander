import {
  type Activity,
  type CardReconciliation,
  type FeeSchedules,
  type ReconcileInput,
  reconcile,
} from "@twofiat/client";
import { and, eq, max, sql } from "drizzle-orm";
import { type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import {
  accounts,
  activities,
  balanceObservations,
  balanceSnapshots,
  cards,
  evaluations,
  feeSchedules,
  openingBalances,
  rawTransactions,
} from "./db/schema.ts";
import { type RecordFindingsResult, recordFindingsIn, recordMissingCardsIn } from "./findings.ts";

export class LedgerNotReadyError extends Error {
  constructor(accountId: number) {
    super(`account ${accountId} has raw rows that aren't normalised yet`);
    this.name = "LedgerNotReadyError";
  }
}

export interface EvaluateResult {
  evaluationId: number;
  reconciliations: CardReconciliation[];
  /** Cards whose opening balance this evaluation inferred. */
  inferredOpenings: number;
  findings: RecordFindingsResult;
}

/**
 * Reconciles an account's ledger against the balances its latest sync observed, and records the results as one
 * evaluation: balance snapshots and findings. Cards the latest sync didn't see (e.g. cancelled ones) are left out.
 *
 * A card with no history from its issue and no opening balance gets one inferred as its current gap, so later
 * gaps measure drift from here. Not while its balance is transient, since that gap may be an artefact.
 *
 * Refuses to run on a ledger with raw rows not normalised yet. Returns undefined before the first sync.
 */
export function evaluate(
  db: Db,
  accountId: number,
  options: { syncId?: number; asOf?: string } = {},
): EvaluateResult | undefined {
  return db.transaction((q) => {
    const account = q
      .select({ dirtyFrom: accounts.ledgerDirtyFrom })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    if (!account) throw new Error(`No account ${accountId}`);
    if (account.dirtyFrom !== null) throw new LedgerNotReadyError(accountId);

    const asOf = options.asOf ?? new Date().toISOString();
    const loaded = loadReconcileInput(q, accountId, asOf);
    if (!loaded) return undefined;
    const { observedSyncId, byTwofiatId, input } = loaded;
    const openings = { ...input.openingBalances };

    const evaluationId = q
      .insert(evaluations)
      .values({ accountId, syncId: options.syncId ?? null, asOf })
      .returning({ id: evaluations.id })
      .get().id;

    let reconciliations = reconcile(input);
    let inferredOpenings = 0;
    for (const rec of reconciliations) {
      const o = byTwofiatId.get(rec.cardId);
      if (!o || rec.historyComplete || o.observation.transient) continue;
      q.insert(openingBalances)
        .values({
          cardId: o.card.id,
          cents: rec.gapCents,
          source: "inferred",
          setByEvaluationId: evaluationId,
        })
        .run();
      openings[rec.cardId] = rec.gapCents;
      inferredOpenings++;
    }
    if (inferredOpenings > 0) reconciliations = reconcile({ ...input, openingBalances: openings });

    for (const rec of reconciliations) {
      const o = byTwofiatId.get(rec.cardId);
      if (!o) continue;
      q.insert(balanceSnapshots)
        .values({
          cardId: o.card.id,
          evaluationId,
          observedSyncId,
          reportedCents: rec.reportedBalanceCents,
          ledgerCents: rec.ledgerBalanceCents,
          holdsCents: rec.holdsCents,
          gapCents: rec.gapCents,
          transient: o.observation.transient,
        })
        .run();
    }
    const reconciled = recordFindingsIn(q, accountId, evaluationId, reconciliations);
    const missing = recordMissingCardsIn(q, accountId, evaluationId);
    const findings = {
      opened: reconciled.opened + missing.opened,
      continued: reconciled.continued + missing.continued,
      resolved: reconciled.resolved + missing.resolved,
    };
    return { evaluationId, reconciliations, inferredOpenings, findings };
  }, IMMEDIATE);
}

/**
 * What `reconcile` needs for an account: the cards its latest sync observed (with the balances it saw), all their
 * rows and activities, opening balances, and accepted fee schedules. Undefined before the first sync.
 */
export function loadReconcileInput(q: Executor, accountId: number, asOf: string) {
  const observedSyncId = q
    .select({ syncId: max(balanceObservations.syncId) })
    .from(balanceObservations)
    .innerJoin(cards, eq(cards.id, balanceObservations.cardId))
    .where(eq(cards.accountId, accountId))
    .get()?.syncId;
  if (observedSyncId === null || observedSyncId === undefined) return undefined;

  const observed = q
    .select({ card: cards, observation: balanceObservations })
    .from(balanceObservations)
    .innerJoin(cards, eq(cards.id, balanceObservations.cardId))
    .where(and(eq(cards.accountId, accountId), eq(balanceObservations.syncId, observedSyncId)))
    .all();
  const byTwofiatId = new Map(observed.map((o) => [o.card.twofiatId, o]));

  const openingCents: Record<string, number> = Object.fromEntries(
    q
      .select({ twofiatId: cards.twofiatId, cents: openingBalances.cents })
      .from(openingBalances)
      .innerJoin(cards, eq(cards.id, openingBalances.cardId))
      .where(eq(cards.accountId, accountId))
      .all()
      .map((o) => [o.twofiatId, o.cents]),
  );

  // Each card gets its product's schedules.
  const byProduct = new Map<string, Required<FeeSchedules>>();
  for (const s of q.select().from(feeSchedules).where(eq(feeSchedules.accountId, accountId)).all()) {
    let schedules = byProduct.get(s.product);
    if (!schedules) {
      schedules = { topup: [], transaction: [] };
      byProduct.set(s.product, schedules);
    }
    if (s.kind === "topup" && s.rateBps !== null) {
      schedules.topup.push({ from: s.effectiveFrom, rateBps: s.rateBps });
    } else if (s.kind === "transaction" && s.authorizationFeeCents !== null && s.postingFeeCents !== null) {
      schedules.transaction.push({
        from: s.effectiveFrom,
        authorizationCents: s.authorizationFeeCents,
        postingCents: s.postingFeeCents,
      });
    }
  }

  const input: ReconcileInput & { openingBalances: Record<string, number> } = {
    // Reconcile against the observed balance, which can be newer than the stored card details.
    cards: observed.map(({ card, observation }) => ({
      ...card.raw,
      balance: observation.reportedCents / 100,
    })),
    transactions: q
      .select({ raw: rawTransactions.raw })
      .from(rawTransactions)
      .where(eq(rawTransactions.accountId, accountId))
      .all()
      .map((r) => r.raw),
    activities: loadActivities(q, accountId),
    asOf,
    openingBalances: openingCents,
    feeSchedules: Object.fromEntries(
      observed.flatMap(({ card }) => {
        const schedules = byProduct.get(card.product);
        return schedules ? [[card.twofiatId, schedules]] : [];
      }),
    ),
  };
  return { observedSyncId, byTwofiatId, input };
}

/** The account's stored ledger, in the shape `normalize` returns it. */
export function loadActivities(q: Executor, accountId: number): Activity[] {
  const cardTwofiatIds = new Map(
    q
      .select({ id: cards.id, twofiatId: cards.twofiatId })
      .from(cards)
      .where(eq(cards.accountId, accountId))
      .all()
      .map((c) => [c.id, c.twofiatId]),
  );
  const sources = new Map<number, Activity["sources"]>();
  const rows = q.all<{ activity_id: number; tx: string | null; ord: string | null }>(sql`
    SELECT s.activity_id, t.twofiat_id AS tx, o.twofiat_id AS ord
    FROM activity_sources s
    JOIN activities a ON a.id = s.activity_id
    LEFT JOIN raw_transactions t ON t.id = s.raw_transaction_id
    LEFT JOIN raw_orders o ON o.id = s.raw_order_id
    WHERE a.account_id = ${accountId}`);
  for (const r of rows) {
    let s = sources.get(r.activity_id);
    if (!s) {
      s = { transactionIds: [], orderIds: [] };
      sources.set(r.activity_id, s);
    }
    if (r.tx !== null) s.transactionIds.push(r.tx);
    if (r.ord !== null) s.orderIds.push(r.ord);
  }

  const twofiatId = (cardId: number) => cardTwofiatIds.get(cardId) as string;
  return q
    .select()
    .from(activities)
    .where(eq(activities.accountId, accountId))
    .all()
    .map((a) => ({
      key: a.key,
      cardId: twofiatId(a.cardId),
      kind: a.kind,
      status: a.status,
      amountCents: a.amountCents,
      authorizedAmountCents: a.authorizedAmountCents ?? undefined,
      attemptedAmountCents: a.attemptedAmountCents ?? undefined,
      requestedAmountCents: a.requestedAmountCents ?? undefined,
      feeCents: a.feeCents ?? undefined,
      currency: a.currency,
      occurredAt: a.occurredAt,
      settledAt: a.settledAt ?? undefined,
      description: a.description,
      postedDescription: a.postedDescription ?? undefined,
      orderId: a.orderTwofiatId ?? undefined,
      transferId: a.transferId ?? undefined,
      counterpartCardId: a.counterpartCardId === null ? undefined : twofiatId(a.counterpartCardId),
      sources: sources.get(a.id) ?? { transactionIds: [], orderIds: [] },
      flags: a.flags,
    }));
}
