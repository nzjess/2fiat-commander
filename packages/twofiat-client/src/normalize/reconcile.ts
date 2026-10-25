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
  | "topup-fee-above-advertised";

export interface Finding {
  kind: FindingKind;
  /** The amount at stake, signed from the card holder's point of view (negative = money lost). */
  cents?: number;
  /** Activities the finding is about, by key. */
  activityKeys: string[];
  message: string;
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

    for (const a of acts) {
      if (
        a.kind === "topup" &&
        a.requestedAmountCents !== undefined &&
        a.amountCents < a.requestedAmountCents
      ) {
        findings.push({
          kind: "credit-shortfall",
          cents: a.amountCents - a.requestedAmountCents,
          activityKeys: [a.key],
          message: `A top-up for ${$(a.requestedAmountCents)} was paid but only ${$(a.amountCents)} was credited.`,
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

    const fees = auditFees(rows, terms.advertisedAuthorizationFeeCents);
    if (fees?.advertisedCents !== undefined && Math.abs(fees.chargedCents) > fees.advertisedCents) {
      const excess = Math.abs(fees.chargedCents) - fees.advertisedCents;
      findings.push({
        kind: "fees-above-advertised",
        cents: -excess,
        activityKeys: acts.filter((a) => a.kind === "fee" && a.occurredAt >= fees.since).map((a) => a.key),
        message: `Since ${fees.since.slice(0, 10)}, ${fees.chargedCount} fees were charged against ${fees.authorizationCount} authorisations and ${fees.postingCount} postings. The terms advertise a fee per authorisation only, which would be ${$(fees.advertisedCents)}: ${$(excess)} less.`,
      });
    }

    const topups = acts.filter(
      (a) => a.kind === "topup" && a.feeCents !== undefined && a.requestedAmountCents,
    );
    const topupFeesCents = topups.reduce((s, a) => s + (a.feeCents ?? 0), 0);
    const requested = topups.reduce((s, a) => s + (a.requestedAmountCents ?? 0), 0);
    if (terms.advertisedTopupFeeRate !== undefined && requested > 0) {
      const advertised = Math.round(requested * terms.advertisedTopupFeeRate);
      if (topupFeesCents > advertised) {
        findings.push({
          kind: "topup-fee-above-advertised",
          cents: advertised - topupFeesCents,
          activityKeys: topups.map((a) => a.key),
          message: `Top-ups were charged ${((topupFeesCents / requested) * 100).toFixed(1)}% in fees; the product description advertises ${(terms.advertisedTopupFeeRate * 100).toFixed(1)}%, which would be ${$(advertised)}: ${$(topupFeesCents - advertised)} less.`,
        });
      }
    }

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
      findings,
    };
  });
}

function auditFees(rows: RawTransaction[], advertisedCents: number | undefined): FeeAudit | undefined {
  const feeRows = rows.filter((t) => t.type === "INTERNAL" && t.kind === "fee");
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
