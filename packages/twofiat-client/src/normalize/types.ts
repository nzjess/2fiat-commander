/** Bumped whenever normalisation rules change, so stored activities can be rebuilt deliberately. */
export const NORMALIZER_VERSION = 1;

/**
 * How far before the earliest new raw row a re-normalisation must reach. Every matching rule pairs rows that are
 * at most a few days apart (authorisation and posting ≤ 4 days, split credits and refund credits ≤ 3 days, transfers seconds),
 * so rows older than this can't be affected by new ones.
 */
export const LOOKBACK_DAYS = 7;

export type ActivityKind =
  | "purchase"
  | "refund"
  | "fee"
  | "topup"
  | "card_issue"
  | "transfer_out"
  | "transfer_in"
  | "declined"
  | "verification"
  | "other"
  /**
   * Money 2fiat moved without any row to show for it (e.g. a balance support credited by hand), entered by the
   * user. `normalize` never produces it: the app derives it from the user's entry.
   */
  | "adjustment";

/**
 * For card payments, 2fiat's row statuses are misleading: a COMPLETED authorisation row is the approval at purchase
 * time, and the PENDING row that follows (median ~12 h later) is the posting with the final amount (tips added, fares
 * finalised, holds netted). So `pending` here means authorised but not yet posted, and `settled` means posted.
 */
export type ActivityStatus = "pending" | "settled" | "failed" | "voided";

export type ActivityFlag =
  /** The posted amount differs from the authorised amount (tips, final fares, holds). */
  | "amount-changed"
  /** A partial release of the authorised amount was folded into the purchase; the posting already nets it. */
  | "partial-reversal"
  /** Extra posting rows identical to another one a moment apart: double notifications. */
  | "duplicate-posting"
  /** An order credited through more than one top-up row. */
  | "split-credit"
  /** The order was only partly credited (`credited_partially`). */
  | "partial-credit"
  /** The order's credit rows don't (yet) add up to `credited_usd`. */
  | "credit-incomplete"
  /** A credited order with no top-up rows: from before 2fiat recorded top-ups as transactions. */
  | "order-only"
  /** A top-up row explained by no order, transfer or refund. */
  | "unattributed-credit"
  /** A transfer whose other side wasn't found. */
  | "unmatched-transfer"
  /** A row of a type/kind/status combination we don't know. */
  | "unknown-row";

export interface Activity {
  /** Deterministic for a given normaliser version: `<kind>:<anchor source id>`. */
  key: string;
  cardId: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** Signed effect on the card balance in cents: the posted amount, else the authorised one. Zero when voided. */
  amountCents: number;
  /** The authorisation's amount, when there was an authorisation row. */
  authorizedAmountCents?: number;
  /** What a declined authorisation tried to charge. */
  attemptedAmountCents?: number;
  /** What a top-up order asked for, before partial crediting. */
  requestedAmountCents?: number;
  /** What 2fiat charged on top: the top-up fee on an order, or the card price on an issue. */
  feeCents?: number;
  currency: string;
  occurredAt: string;
  settledAt?: string;
  /** The most complete description: the authorisation's, which usually adds city and country. */
  description: string;
  /** The posting row's description, when it differs (often shorter, sometimes a different merchant name). */
  postedDescription?: string;
  orderId?: string;
  /** Shared by both sides of a transfer. */
  transferId?: string;
  counterpartCardId?: string;
  sources: { transactionIds: string[]; orderIds: string[] };
  flags: ActivityFlag[];
}
