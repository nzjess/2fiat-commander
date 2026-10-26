import type { ActivityFlag, ActivityKind, ActivityStatus, Card, FindingKind } from "../api.ts";

// 2fiat runs purely in US dollars, so money is always USD: "$12.50" in any locale.
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const signedMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  signDisplay: "exceptZero",
});

/** Integer cents as dollars, e.g. "$12.50". `signed` always shows the sign, as gaps need. */
export function formatMoney(cents: number, { signed = false }: { signed?: boolean } = {}): string {
  return (signed ? signedMoney : money).format(cents / 100);
}

/** Dollars as typed into a form, as integer cents; undefined unless it's a number with at most two decimals. */
export function toCents(value: string | number): number | undefined {
  const text = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  "balance-gap": "Balance gap",
  "history-incomplete": "History incomplete",
  "credit-shortfall": "Credit shortfall",
  "credit-incomplete": "Credit incomplete",
  "stale-authorization": "Stale authorisation",
  "unattributed-credit": "Unattributed credit",
  "unmatched-transfer": "Unmatched transfer",
  "fees-above-advertised": "Fees above advertised",
  "topup-fee-above-advertised": "Top-up fee above advertised",
  "topup-fee-off-schedule": "Top-up fee off schedule",
  "transaction-fees-off-schedule": "Fees off schedule",
};

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  purchase: "Purchase",
  refund: "Refund",
  fee: "Fee",
  topup: "Top-up",
  card_issue: "Card issue",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  declined: "Declined",
  verification: "Verification",
  other: "Other",
  adjustment: "Adjustment",
};

// Pending means authorised but not yet posted: 2fiat's own row statuses say otherwise (see docs/2fiat-api.md).
export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  pending: "Pending",
  settled: "Settled",
  failed: "Failed",
  voided: "Voided",
};

export const ACTIVITY_FLAG_LABELS: Record<ActivityFlag, { label: string; description: string }> = {
  "amount-changed": {
    label: "Amount changed",
    description: "The posted amount differs from the authorised one (a tip, a final fare, a hold)",
  },
  "partial-reversal": {
    label: "Partial reversal",
    description: "Part of the authorised amount was released; the posting already nets it",
  },
  "duplicate-posting": {
    label: "Duplicate posting",
    description: "2fiat reported the posting more than once, a moment apart; it counts once",
  },
  "split-credit": { label: "Split credit", description: "The order was credited through more than one row" },
  "partial-credit": { label: "Partial credit", description: "2fiat credited the order only in part" },
  "credit-incomplete": {
    label: "Credit incomplete",
    description: "The order's credit rows don't add up to what 2fiat says it credited",
  },
  "order-only": {
    label: "Order only",
    description: "A credited order with no top-up row: from before 2fiat recorded top-ups as rows",
  },
  "unattributed-credit": {
    label: "Unattributed credit",
    description: "A top-up row explained by no order, transfer or refund",
  },
  "unmatched-transfer": {
    label: "Unmatched transfer",
    description: "The other side of the transfer wasn't found",
  },
  "unknown-row": { label: "Unknown row", description: "A kind of 2fiat row we don't know" },
};

/** A rate in basis points as a percentage, e.g. 650 → "6.5%". */
export function formatRate(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** A percentage as typed ("6.5" or "6.5%") as basis points; undefined unless 0–100 with at most two decimals. */
export function toBps(value: string): number | undefined {
  const text = value.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const bps = Math.round(Number(text) * 100);
  return bps <= 10_000 ? bps : undefined;
}

/** The last four digits of a masked card number like "5257 **** **** 0000". */
export function lastFour(maskedNumber: string): string {
  return maskedNumber.replace(/\D/g, "").slice(-4);
}

/** A physical card in one line: its alias and last four digits. */
export const cardLabel = (card: Pick<Card, "alias" | "maskedNumber">) =>
  `${card.alias} ·· ${lastFour(card.maskedNumber)}`;

/** 2fiat reports status "1" for an active card; other values are shown as they are. */
export const isActive = (card: Pick<Card, "status">) => card.status === null || card.status === "1";

/** An ISO date as e.g. "Aug 2027", for expiry dates. */
export function formatMonth(iso: string | null, locale?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** A local date from a date input ("2026-10-26") as an ISO time: noon that day, so no time zone moves its date. */
export function localDateToIso(date: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const at = new Date(y, m - 1, d, 12);
  return at.getMonth() === m - 1 && at.getDate() === d ? at.toISOString() : undefined;
}

/** The start of a local date ("2026-10-26"), `addDays` later, as an ISO time; undefined unless it's a real date. */
export function localDayStart(date: string, addDays = 0): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const at = new Date(y, m - 1, d);
  if (at.getMonth() !== m - 1 || at.getDate() !== d) return undefined;
  at.setDate(d + addDays);
  return at.toISOString();
}

/** An ISO time as a date input's value, in local time. */
export function isoToLocalDate(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** An ISO time as a local date, e.g. "26 Oct 2026". */
export function formatDate(iso: string | null, locale?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** An ISO time as a local date and time. */
export function formatDateTime(iso: string | null, locale?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

/** How long ago an ISO time was, e.g. "5 minutes ago"; under a minute is "just now". */
export function timeAgo(iso: string, now = Date.now(), format = relative): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}
