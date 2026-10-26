import type { RawCard, RawCardDetails, RawTransaction } from "../raw/schemas.ts";
import { dollarsToCents, parseCents } from "./money.ts";
import { productTerms } from "./terms.ts";
import { type Activity, type ActivityKind, LOOKBACK_DAYS } from "./types.ts";

const DAY = 86_400_000;

export type FindingKind =
  /** The reported balance differs from the sum of the card's activities. */
  | "balance-gap"
  /**
   * No card-issue order and no opening balance: the card came with a balance whose history isn't visible (e.g. moved
   * over from another token), so the gap can't be judged until an opening balance is set.
   */
  | "history-incomplete"
  /** An order paid for more than it credited. */
  | "credit-shortfall"
  /** An order's credit rows haven't (yet) added up to what it credited. */
  | "credit-incomplete"
  /** Authorised over LOOKBACK_DAYS ago and never posted, voided or released. */
  | "stale-authorization"
  /** Money credited that no order, transfer or refund explains. */
  | "unattributed-credit"
  | "unmatched-transfer"
  /** Transaction fees charged beyond the advertised per-authorisation fee. */
  | "fees-above-advertised"
  /** Top-up fees charged above the advertised rate. */
  | "topup-fee-above-advertised"
  /** A top-up charged a fee other than the accepted schedule's rate: more or less. */
  | "topup-fee-off-schedule"
  /** A month whose transaction fees differ from what the accepted schedule comes to, either way. */
  | "transaction-fees-off-schedule"
  /**
   * 2fiat no longer lists a card it listed before. `reconcile` never produces it, since it only sees listed cards:
   * the app raises it from the cards a sync didn't list.
   */
  | "card-missing";

export interface Finding {
  kind: FindingKind;
  /** The amount at stake, signed from the card holder's point of view (negative = money lost). */
  cents?: number;
  /** Activities the finding is about, by key. */
  activityKeys: string[];
  /** What the finding is about when that isn't its activities, e.g. the month "2026-10". */
  scope?: string;
  message: string;
}

/** A top-up fee rate the user accepted as 2fiat's practice, from a time on. */
export interface TopupFeeSchedule {
  from: string;
  /** Basis points: 650 is 6.5%. */
  rateBps: number;
}

/** Transaction fees the user accepted as 2fiat's practice, from a time on. */
export interface TransactionFeeSchedule {
  from: string;
  /** Per authorisation attempt: approved, reversed or declined. */
  authorizationCents: number;
  /** Per posting, which the terms don't mention. */
  postingCents: number;
}

/** A card's accepted fee schedules. The one in force at a time is the latest from before it. */
export interface FeeSchedules {
  topup?: TopupFeeSchedule[];
  transaction?: TransactionFeeSchedule[];
}

/** What a kind of fee came to: charged, what the advert implies, and what the accepted schedules imply. */
export interface FeeComparison {
  chargedCents: number;
  advertisedCents: number | undefined;
  /** Over the time the accepted schedules cover. */
  accepted: { since: string; chargedCents: number; expectedCents: number } | undefined;
}

export interface FeeAudit {
  /** When fee rows begin for this card; there are none before. */
  since: string;
  chargedCount: number;
  chargedCents: number;
  /** Authorisation attempts (approved, reversed or declined) since `since`, which the terms say are charged. */
  authorizationCount: number;
  /** Postings since `since`, which the terms don't mention but which are charged too. */
  postingCount: number;
  advertisedCents: number | undefined;
}

export interface CardCosts {
  /** Card price: issue order amount minus starting balance. */
  cardCents: number;
  topupFeesCents: number;
  transactionFeesCents: number;
  totalCents: number;
}

export interface CardReconciliation {
  cardId: string;
  reportedBalanceCents: number;
  /** For a card whose history starts mid-life: its balance before the first visible row. */
  openingBalanceCents: number | undefined;
  /** Opening balance plus every activity on the card, including authorisations not yet posted. */
  ledgerBalanceCents: number;
  /** The part of the ledger that's authorised but not yet posted. */
  holdsCents: number;
  /** Reported minus ledger: positive means 2fiat shows more money than its rows explain. */
  gapCents: number;
  /** The ledger starts at the card's issue, or from a given opening balance. */
  historyComplete: boolean;
  totalsByKind: Partial<Record<ActivityKind, number>>;
  costs: CardCosts;
  fees: FeeAudit | undefined;
  feeComparison: { transaction: FeeComparison; topup: FeeComparison };
  findings: Finding[];
}

export interface ReconcileInput {
  cards: (RawCard | RawCardDetails)[];
  /** The full history of raw transactions, for the fee audit. */
  transactions: RawTransaction[];
  /** The full history of activities, as `normalize` returns them. */
  activities: Activity[];
  /** "Now", for staleness. Defaults to the current time. */
  asOf?: string;
  /**
   * Balances before the first visible row, by card id, for cards with no issue order. Typically inferred as the gap
   * at the first sync (so later gaps measure drift from then on), or entered by the user.
   */
  openingBalances?: Record<string, number>;
  /**
   * Fee schedules the user accepted as 2fiat's practice, by card id. Advertised fees are checked only before a kind's
   * first schedule; from then on, against the schedule in force, so a change in 2fiat's charges shows up.
   */
  feeSchedules?: Record<string, FeeSchedules>;
}

const $ = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Compares each card's reported balance and fees with what its rows and published terms say they should be. */
export function reconcile(input: ReconcileInput): CardReconciliation[] {
  const asOf = Date.parse(input.asOf ?? new Date().toISOString());
  return input.cards.map((card) => {
    const acts = input.activities.filter((a) => a.cardId === card.id);
    const rows = input.transactions.filter((t) => t.cardId === card.id);
    const terms = productTerms(card);
    const findings: Finding[] = [];
    const sum = (xs: Activity[]) => xs.reduce((s, a) => s + a.amountCents, 0);

    const totalsByKind: Partial<Record<ActivityKind, number>> = {};
    for (const a of acts) totalsByKind[a.kind] = (totalsByKind[a.kind] ?? 0) + a.amountCents;

    const reportedBalanceCents = dollarsToCents(card.balance);
    const issued = acts.some((a) => a.kind === "card_issue");
    const openingBalanceCents = issued ? undefined : input.openingBalances?.[card.id];
    const ledgerBalanceCents = (openingBalanceCents ?? 0) + sum(acts);
    const holdsCents = sum(acts.filter((a) => a.status === "pending"));
    const gapCents = reportedBalanceCents - ledgerBalanceCents;
    const historyComplete = issued || openingBalanceCents !== undefined;
    if (!historyComplete) {
      findings.push({
        kind: "history-incomplete",
        activityKeys: [],
        message:
          "The card's history starts mid-life (no issue order), so its balance can't be checked until an opening balance is set.",
      });
    } else if (gapCents !== 0) {
      findings.push({
        kind: "balance-gap",
        cents: gapCents,
        activityKeys: [],
        message: `2fiat reports ${$(gapCents)} ${gapCents > 0 ? "more" : "less"} than the card's ${openingBalanceCents === undefined ? "" : "opening balance, "}transactions and orders add up to.`,
      });
    }

    // Credit for an order that 2fiat moved without a row (e.g. support making up a short top-up by hand), as the
    // user recorded it: adjustments that name the order.
    const adjustedByOrder = new Map<string, number>();
    for (const a of acts) {
      if (a.kind === "adjustment" && a.orderId !== undefined) {
        adjustedByOrder.set(a.orderId, (adjustedByOrder.get(a.orderId) ?? 0) + a.amountCents);
      }
    }

    for (const a of acts) {
      const adjusted = (a.orderId !== undefined && adjustedByOrder.get(a.orderId)) || 0;
      if (
        a.kind === "topup" &&
        a.requestedAmountCents !== undefined &&
        a.amountCents + adjusted < a.requestedAmountCents
      ) {
        findings.push({
          kind: "credit-shortfall",
          cents: a.amountCents + adjusted - a.requestedAmountCents,
          activityKeys: [a.key],
          message: `A top-up for ${$(a.requestedAmountCents)} was paid but only ${$(a.amountCents)} was credited${adjusted ? `, and ${$(adjusted)} made up by adjustment` : ""}.`,
        });
      }
      if (a.flags.includes("credit-incomplete")) {
        findings.push({
          kind: "credit-incomplete",
          activityKeys: [a.key],
          message: "A top-up's credit hasn't fully arrived.",
        });
      }
      if (a.flags.includes("unattributed-credit")) {
        findings.push({
          kind: "unattributed-credit",
          cents: a.amountCents,
          activityKeys: [a.key],
          message: `${$(a.amountCents)} was credited with no order, transfer or refund to explain it.`,
        });
      }
      if (a.flags.includes("unmatched-transfer")) {
        findings.push({
          kind: "unmatched-transfer",
          activityKeys: [a.key],
          message: "A transfer's other side wasn't found.",
        });
      }
      const age = asOf - Date.parse(a.occurredAt);
      if (
        a.status === "pending" &&
        (a.kind === "purchase" || a.kind === "refund") &&
        age > LOOKBACK_DAYS * DAY
      ) {
        findings.push({
          kind: "stale-authorization",
          cents: a.amountCents,
          activityKeys: [a.key],
          message: `${$(a.amountCents)} at ${a.description} was authorised ${Math.floor(age / DAY)} days ago and never posted.`,
        });
      }
    }

    // Transaction fees: against the advert until the user accepts a schedule, then against the schedule.
    const fees = auditFees(rows, terms.advertisedAuthorizationFeeCents);
    const txSchedules = byFrom(input.feeSchedules?.[card.id]?.transaction);
    const txFrom = txSchedules[0]?.from;
    const beforeTx =
      txFrom === undefined
        ? fees
        : auditFees(
            rows.filter((t) => t.createdAt < txFrom),
            terms.advertisedAuthorizationFeeCents,
          );
    if (
      beforeTx?.advertisedCents !== undefined &&
      Math.abs(beforeTx.chargedCents) > beforeTx.advertisedCents
    ) {
      const excess = Math.abs(beforeTx.chargedCents) - beforeTx.advertisedCents;
      findings.push({
        kind: "fees-above-advertised",
        cents: -excess,
        activityKeys: acts
          .filter(
            (a) =>
              a.kind === "fee" &&
              a.occurredAt >= beforeTx.since &&
              (txFrom === undefined || a.occurredAt < txFrom),
          )
          .map((a) => a.key),
        message: `Since ${beforeTx.since.slice(0, 10)}, ${beforeTx.chargedCount} fees were charged against ${beforeTx.authorizationCount} authorisations and ${beforeTx.postingCount} postings. The terms advertise a fee per authorisation only, which would be ${$(beforeTx.advertisedCents)}: ${$(excess)} less.`,
      });
    }
    const months = checkFeeMonths(rows, acts, txSchedules, asOf);
    findings.push(...months.findings);

    // Top-up fees likewise, one top-up at a time once a schedule is accepted.
    const topups = acts.filter(
      (a) => a.kind === "topup" && a.feeCents !== undefined && a.requestedAmountCents,
    );
    const topupFeesCents = topups.reduce((s, a) => s + (a.feeCents ?? 0), 0);
    const topupSchedules = byFrom(input.feeSchedules?.[card.id]?.topup);
    const topupFrom = topupSchedules[0]?.from;
    const beforeTopup = topups.filter((a) => topupFrom === undefined || a.occurredAt < topupFrom);
    const beforeFees = beforeTopup.reduce((s, a) => s + (a.feeCents ?? 0), 0);
    const beforeRequested = beforeTopup.reduce((s, a) => s + (a.requestedAmountCents ?? 0), 0);
    if (terms.advertisedTopupFeeRate !== undefined && beforeRequested > 0) {
      const advertised = Math.round(beforeRequested * terms.advertisedTopupFeeRate);
      if (beforeFees > advertised) {
        findings.push({
          kind: "topup-fee-above-advertised",
          cents: advertised - beforeFees,
          activityKeys: beforeTopup.map((a) => a.key),
          message: `Top-ups were charged ${((beforeFees / beforeRequested) * 100).toFixed(1)}% in fees; the product description advertises ${(terms.advertisedTopupFeeRate * 100).toFixed(1)}%, which would be ${$(advertised)}: ${$(beforeFees - advertised)} less.`,
        });
      }
    }
    let topupAccepted: FeeComparison["accepted"];
    for (const a of topups) {
      const schedule = inForce(topupSchedules, a.occurredAt);
      if (!schedule || topupFrom === undefined) continue;
      const fee = a.feeCents ?? 0;
      const expected = Math.round(((a.requestedAmountCents ?? 0) * schedule.rateBps) / 10_000);
      topupAccepted = {
        since: topupFrom,
        chargedCents: (topupAccepted?.chargedCents ?? 0) + fee,
        expectedCents: (topupAccepted?.expectedCents ?? 0) + expected,
      };
      // A cent either way is rounding.
      if (Math.abs(fee - expected) > 1) {
        findings.push({
          kind: "topup-fee-off-schedule",
          cents: expected - fee,
          activityKeys: [a.key],
          message: `A top-up for ${$(a.requestedAmountCents ?? 0)} was charged ${$(fee)} in fees; the accepted ${percent(schedule.rateBps)} would be ${$(expected)}: ${$(fee - expected)} ${fee > expected ? "more" : "less"}.`,
        });
      }
    }
    const requested = topups.reduce((s, a) => s + (a.requestedAmountCents ?? 0), 0);

    const cardCents = acts.filter((a) => a.kind === "card_issue").reduce((s, a) => s + (a.feeCents ?? 0), 0);
    const transactionFeesCents = 0 - (totalsByKind.fee ?? 0);
    return {
      cardId: card.id,
      reportedBalanceCents,
      openingBalanceCents,
      ledgerBalanceCents,
      holdsCents,
      gapCents,
      historyComplete,
      totalsByKind,
      costs: {
        cardCents,
        topupFeesCents,
        transactionFeesCents,
        totalCents: cardCents + topupFeesCents + transactionFeesCents,
      },
      fees,
      feeComparison: {
        transaction: {
          chargedCents: fees ? Math.abs(fees.chargedCents) : 0,
          advertisedCents: fees?.advertisedCents,
          accepted: months.accepted,
        },
        topup: {
          chargedCents: topupFeesCents,
          advertisedCents:
            terms.advertisedTopupFeeRate === undefined
              ? undefined
              : Math.round(requested * terms.advertisedTopupFeeRate),
          accepted: topupAccepted,
        },
      },
      findings,
    };
  });
}

const byFrom = <T extends { from: string }>(schedules: T[] | undefined): T[] =>
  [...(schedules ?? [])].sort((a, b) => a.from.localeCompare(b.from));

/** The schedule in force at a time: the latest from before it. `schedules` must be sorted by `from`. */
const inForce = <T extends { from: string }>(schedules: T[], at: string): T | undefined =>
  schedules.findLast((s) => s.from <= at);

const percent = (bps: number) => `${(bps / 100).toFixed(bps % 10 === 0 ? 1 : 2)}%`;

/** Fees post in batches on even hours, so a fee follows its authorisation or posting by up to about this. */
const FEE_LAG = 2 * 3_600_000;

/** At the start, the first fees cover events up to this long before them (as `auditFees` counts them). */
const FEE_START_LAG = 6 * 3_600_000;

/** Fee rows a month may differ from its schedule by, in fees, before it's a finding (e.g. a batch in flight). */
const FEE_ALLOWANCE = 2;

const isFeeRow = (t: RawTransaction) => t.type === "INTERNAL" && t.kind === "fee";

/**
 * Checks each UTC month's transaction fees against the accepted schedules, from the first schedule (or the card's
 * first fee row, if later: 2fiat charged none before) to `asOf`. A month's fees are matched with the authorisations
 * and postings from `FEE_LAG` before its start (`FEE_START_LAG` before the start of the check) to `FEE_LAG` before
 * its end (or `asOf`). It's a finding when the totals
 * differ by more than `FEE_ALLOWANCE` fees, or when any fee isn't one of the schedule's amounts.
 */
function checkFeeMonths(
  rows: RawTransaction[],
  acts: Activity[],
  schedules: TransactionFeeSchedule[],
  asOf: number,
): { findings: Finding[]; accepted: FeeComparison["accepted"] } {
  const first = schedules[0];
  const feeRows = rows.filter(isFeeRow);
  const firstFee = feeRows.map((t) => Date.parse(t.createdAt)).sort((a, b) => a - b)[0];
  if (!first || firstFee === undefined) return { findings: [], accepted: undefined };
  const start = Math.max(firstFee, Date.parse(first.from));
  const events = rows.filter((t) => t.type === "AUTHORIZATION");
  const within = (iso: string, from: number, to: number) => {
    const t = Date.parse(iso);
    return t >= from && t < to;
  };

  const findings: Finding[] = [];
  let chargedTotal = 0;
  let expectedTotal = 0;
  for (let month = monthStart(start); month <= asOf; month = nextMonth(month)) {
    const from = Math.max(month, start);
    const to = nextMonth(month);
    const monthFees = feeRows.filter((t) => within(t.createdAt, from, to));
    const lag = from === start ? FEE_START_LAG : FEE_LAG;
    const monthEvents = events.filter((t) => within(t.createdAt, from - lag, Math.min(to, asOf) - FEE_LAG));
    let expected = 0;
    let postings = 0;
    for (const e of monthEvents) {
      const s = inForce(schedules, e.createdAt) ?? first;
      const posting = e.status === "PENDING";
      if (posting) postings++;
      expected += posting ? s.postingCents : s.authorizationCents;
    }
    const charged = monthFees.reduce((sum, t) => sum - parseCents(t.amount), 0);
    const odd = monthFees.filter((t) => {
      const s = inForce(schedules, t.createdAt) ?? first;
      return ![s.authorizationCents, s.postingCents].includes(-parseCents(t.amount));
    }).length;
    chargedTotal += charged;
    expectedTotal += expected;

    const unit = Math.max(...schedules.map((s) => Math.max(s.authorizationCents, s.postingCents)));
    if (Math.abs(charged - expected) <= FEE_ALLOWANCE * unit && odd === 0) continue;
    const scope = new Date(month).toISOString().slice(0, 7);
    const label = new Date(month).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const differs =
      charged === expected
        ? "the same total"
        : `${$(charged - expected)} ${charged > expected ? "more" : "less"}`;
    findings.push({
      kind: "transaction-fees-off-schedule",
      cents: expected - charged,
      scope,
      activityKeys: acts.filter((a) => a.kind === "fee" && within(a.occurredAt, from, to)).map((a) => a.key),
      message: `In ${label}, ${$(charged)} in fees was charged for ${monthEvents.length - postings} authorisations and ${postings} postings; the accepted schedule comes to ${$(expected)}: ${differs}.${odd ? ` ${odd} ${odd === 1 ? "fee wasn't" : "fees weren't"} one of the schedule's amounts.` : ""}`,
    });
  }
  return {
    findings,
    accepted: {
      since: new Date(start).toISOString(),
      chargedCents: chargedTotal,
      expectedCents: expectedTotal,
    },
  };
}

function monthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function auditFees(rows: RawTransaction[], advertisedCents: number | undefined): FeeAudit | undefined {
  const feeRows = rows.filter(isFeeRow);
  const since = feeRows.map((t) => t.createdAt).sort()[0];
  if (!since) return undefined;
  // Fees post in batches up to a few hours after what they're for, so count from a little before the first one.
  const from = new Date(Date.parse(since) - 6 * 3_600_000).toISOString();
  const auths = rows.filter((t) => t.type === "AUTHORIZATION" && t.createdAt >= from);
  const authorizationCount = auths.filter((t) => t.status !== "PENDING").length;
  return {
    since,
    chargedCount: feeRows.length,
    chargedCents: feeRows.reduce((s, t) => s + parseCents(t.amount), 0),
    authorizationCount,
    postingCount: auths.length - authorizationCount,
    advertisedCents: advertisedCents === undefined ? undefined : authorizationCount * advertisedCents,
  };
}
