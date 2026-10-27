// Chart rows for a logical card's running balance, in either of two modes: a step per activity, or one closing
// balance per day. Times are epoch milliseconds, so the chart's axis is real time.

export interface HistoryPoint {
  at: string;
  cents: number;
  activity: { description: string; amountCents: number } | null;
}

export interface Reported {
  at: string;
  cents: number;
}

export interface ChartRow {
  t: number;
  /** The ledger balance from here on; absent on rows that only carry a reported balance. */
  balance?: number;
  /** What 2fiat reported at this time. */
  reported?: number;
  /** What moved the balance: an activity's description, or "Opening balance". */
  label?: string;
  /** By how much: an activity's amount, or a day's net change. */
  changeCents?: number;
  /** Daily mode: how many changes the day had. */
  changes?: number;
}

const ms = (iso: string) => Date.parse(iso);

/** The balance carried into a range: the last point before it, if any. */
function carriedInto(points: HistoryPoint[], from: number): number | undefined {
  let carried: number | undefined;
  for (const p of points) {
    if (ms(p.at) >= from) break;
    carried = p.cents;
  }
  return carried;
}

/**
 * A step per change to the ledger from `from` (all of history when undefined) to `now`, with the reported
 * balances as their own rows. The balance carried into the range opens it, and the latest one closes it at `now`.
 */
export function activityRows(
  points: HistoryPoint[],
  reported: Reported[],
  from: number | undefined,
  now: number,
): ChartRow[] {
  const rows: ChartRow[] = [];
  const carried = from === undefined ? undefined : carriedInto(points, from);
  if (from !== undefined && carried !== undefined) rows.push({ t: from, balance: carried });
  for (const p of points) {
    const t = ms(p.at);
    if (from !== undefined && t < from) continue;
    rows.push({
      t,
      balance: p.cents,
      label: p.activity?.description ?? "Opening balance",
      changeCents: p.activity?.amountCents,
    });
  }
  for (const r of reported) {
    const t = ms(r.at);
    if (from === undefined || t >= from) rows.push({ t, reported: r.cents });
  }
  const last = points.at(-1);
  if (last && ms(last.at) < now) rows.push({ t: now, balance: last.cents });
  return rows.sort((a, b) => a.t - b.t);
}

/** Local midnight of the day `t` falls in. */
const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const nextDay = (day: number) => {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/**
 * One row per local day from `from` (or the first point's day) to `now`'s: the day's closing balance, its net
 * change and how many changes it had, and the last balance 2fiat reported that day. Days before the first point
 * have no balance.
 */
export function dailyRows(
  points: HistoryPoint[],
  reported: Reported[],
  from: number | undefined,
  now: number,
): ChartRow[] {
  const first = points[0];
  if (!first) return [];
  const rows: ChartRow[] = [];
  let balance = from === undefined ? undefined : carriedInto(points, from);
  let i = 0;
  let j = 0;
  while (i < points.length && from !== undefined && ms((points[i] as HistoryPoint).at) < from) i++;
  while (j < reported.length && from !== undefined && ms((reported[j] as Reported).at) < from) j++;
  for (let day = startOfDay(from ?? ms(first.at)); day <= now; day = nextDay(day)) {
    const end = nextDay(day);
    const opening = balance;
    let changes = 0;
    for (; i < points.length && ms((points[i] as HistoryPoint).at) < end; i++) {
      balance = (points[i] as HistoryPoint).cents;
      changes++;
    }
    let lastReported: number | undefined;
    for (; j < reported.length && ms((reported[j] as Reported).at) < end; j++) {
      lastReported = (reported[j] as Reported).cents;
    }
    rows.push({
      t: day,
      ...(balance !== undefined && { balance }),
      ...(lastReported !== undefined && { reported: lastReported }),
      ...(changes > 0 && { changes, changeCents: (balance ?? 0) - (opening ?? 0) }),
    });
  }
  return rows;
}

export interface TimeTicks {
  ticks: number[];
  format: (t: number) => string;
}

const DAY = 86_400_000;
const local = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

/**
 * Ticks for a time axis from `from` to `to`, at local calendar boundaries spaced for the span: days, Mondays, the
 * 1st and 15th, months, quarters or years. Built from calendar fields, so a daylight saving change doesn't drift
 * them off midnight.
 */
export function timeTicks(from: number, to: number): TimeTicks {
  const days = (to - from) / DAY;
  const start = new Date(from);
  const [y, m, d] = [start.getFullYear(), start.getMonth(), start.getDate()];
  const candidates: number[] = [];
  let format: (t: number) => string;
  if (days <= 45) {
    // Every day, or every Monday.
    const step = days <= 10 ? 1 : 7;
    const offset = step === 1 ? 0 : (8 - start.getDay()) % 7;
    for (let i = offset; local(y, m, d + i) <= to; i += step) candidates.push(local(y, m, d + i));
    format = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } else if (days <= 120) {
    for (let i = 0; local(y, m + i, 1) <= to; i++) candidates.push(local(y, m + i, 1), local(y, m + i, 15));
    format = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } else if (days <= 1100) {
    const step = days <= 400 ? 1 : 3;
    for (let i = -(m % step); local(y, m + i, 1) <= to; i += step) candidates.push(local(y, m + i, 1));
    format = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  } else {
    for (let i = 0; local(y + i, 0, 1) <= to; i++) candidates.push(local(y + i, 0, 1));
    format = (t) => String(new Date(t).getFullYear());
  }
  return { ticks: candidates.filter((t) => t >= from && t <= to), format };
}

export const RANGES = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "1y", label: "1 year", days: 365 },
  { value: "all", label: "All", days: undefined },
] as const;
export type Range = (typeof RANGES)[number]["value"];

/** Where a range starts, `now` being its end. */
export function rangeStart(range: Range, now: number): number | undefined {
  const days = RANGES.find((r) => r.value === range)?.days;
  return days === undefined ? undefined : now - days * 86_400_000;
}
