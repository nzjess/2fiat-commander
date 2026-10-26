import type { Card, FindingKind } from "../api.ts";

const moneyFormats = new Map<string, Intl.NumberFormat>();

/**
 * Integer cents as money in the given currency, e.g. "$12.50". `signed` always shows the sign, as gaps need.
 * An unknown currency code falls back to "12.50 XYZ".
 */
export function formatMoney(
  cents: number,
  currency: string,
  { signed = false, locale }: { signed?: boolean; locale?: string } = {},
): string {
  const key = `${locale}|${currency}|${signed}`;
  let format = moneyFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        signDisplay: signed ? "exceptZero" : "auto",
      });
    } catch {
      const amount = (cents / 100).toFixed(2);
      return `${signed && cents > 0 ? "+" : ""}${amount} ${currency}`;
    }
    moneyFormats.set(key, format);
  }
  return format.format(cents / 100);
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
};

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
