import { type Bucket, nextPeriod, periodStart } from "./cashflow.ts";

// Spending: what the card's money went on. Purchases count towards their category, refunds back against it, and
// fees (never linked to a purchase) are their own series. Amounts here are positive for money spent.

export interface SpendingFlow {
  at: string;
  kind: string;
  /** Signed, as in the cash flow: negative is money out. */
  amountCents: number;
  categoryId: number | null;
}

/** A spending series: a category's id, or one of the neutral ones. */
export type SeriesKey = number | "fees" | "uncategorised" | "other";

/** At most this many categories have a series of their own; the rest fold into "other". */
export const MAX_CATEGORIES = 8;

export type SpendingBucket = Exclude<Bucket, "none">;

const SPENDING_KINDS = new Set(["purchase", "refund", "fee"]);

function seriesOf(flow: SpendingFlow): SeriesKey {
  if (flow.kind === "fee") return "fees";
  return flow.categoryId ?? "uncategorised";
}

function inRange(flows: readonly SpendingFlow[], from: number | undefined, now: number) {
  return flows.filter((f) => {
    const t = Date.parse(f.at);
    return SPENDING_KINDS.has(f.kind) && (from === undefined || t >= from) && t <= now;
  });
}

/** Net spending per series from `from` (all of it when undefined) to `now`. */
export function spendingTotals(
  flows: readonly SpendingFlow[],
  from: number | undefined,
  now: number,
): Map<SeriesKey, number> {
  const totals = new Map<SeriesKey, number>();
  for (const f of inRange(flows, from, now)) {
    const key = seriesOf(f);
    totals.set(key, (totals.get(key) ?? 0) - f.amountCents);
  }
  return totals;
}

/**
 * The series to show, in order: the categories by what was spent (most first), up to `MAX_CATEGORIES`, then
 * "other" for the rest, then uncategorised and fees. Series that net to nothing are left out. `fold` maps a
 * category's id to the series it's shown in.
 */
export function spendingSeries(totals: ReadonlyMap<SeriesKey, number>): {
  keys: SeriesKey[];
  fold: (key: SeriesKey) => SeriesKey;
} {
  const categories = [...totals]
    .filter((e): e is [number, number] => typeof e[0] === "number" && e[1] !== 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id);
  const own = new Set(
    categories.length > MAX_CATEGORIES ? categories.slice(0, MAX_CATEGORIES - 1) : categories,
  );
  const fold = (key: SeriesKey): SeriesKey => (typeof key === "number" && !own.has(key) ? "other" : key);
  const keys: SeriesKey[] = [...own];
  if (own.size < categories.length) keys.push("other");
  for (const key of ["uncategorised", "fees"] as const) if (totals.get(key)) keys.push(key);
  return { keys, fold };
}

/** A series' total: the categories folded into it summed. */
export function seriesTotal(
  totals: ReadonlyMap<SeriesKey, number>,
  fold: (key: SeriesKey) => SeriesKey,
  key: SeriesKey,
): number {
  let cents = 0;
  for (const [k, v] of totals) if (fold(k) === key) cents += v;
  return cents;
}

/** A series' data key in chart rows. */
export const seriesName = (key: SeriesKey) => (typeof key === "number" ? `c${key}` : key);

export interface SpendingRow {
  /** Epoch ms: the period's start. */
  t: number;
  /** In cents, by `seriesName`. */
  [series: string]: number;
}

/** A row per period from `from` (or the first flow) to `now`, empty ones included, each series folded. */
export function spendingRows(
  flows: readonly SpendingFlow[],
  bucket: SpendingBucket,
  fold: (key: SeriesKey) => SeriesKey,
  from: number | undefined,
  now: number,
): SpendingRow[] {
  const shown = inRange(flows, from, now);
  const first = from ?? (shown[0] ? Date.parse(shown[0].at) : undefined);
  if (first === undefined) return [];
  const rows: SpendingRow[] = [];
  let i = 0;
  for (let start = periodStart(first, bucket); start <= now; start = nextPeriod(start, bucket)) {
    const end = nextPeriod(start, bucket);
    const row: SpendingRow = { t: start };
    for (; i < shown.length && Date.parse((shown[i] as SpendingFlow).at) < end; i++) {
      const f = shown[i] as SpendingFlow;
      const name = seriesName(fold(seriesOf(f)));
      row[name] = (row[name] ?? 0) - f.amountCents;
    }
    rows.push(row);
  }
  return rows;
}

/** The grouping for a range, as for the cash flow chart but never one bar per activity. */
export const defaultSpendingBucket = (days: number | undefined): SpendingBucket =>
  days !== undefined && days <= 31 ? "day" : days !== undefined && days <= 92 ? "week" : "month";
