// Chart rows for a logical card's money in and out: one bar per activity, or totals per day, week or month (in
// local time). Each kind group has an "in" and an "out" series, so a bar stacks money in above the axis and money
// out below it.

export interface Flow {
  id: number;
  cardId: number;
  at: string;
  kind: string;
  amountCents: number;
  description: string;
}

export const FLOW_GROUPS = [
  { key: "purchases", label: "Purchases", color: "red.6", kinds: ["purchase"] },
  { key: "refunds", label: "Refunds", color: "teal.5", kinds: ["refund"] },
  { key: "fees", label: "Fees", color: "orange.5", kinds: ["fee"] },
  { key: "topups", label: "Top-ups", color: "green.6", kinds: ["topup", "card_issue"] },
  { key: "transfers", label: "Transfers", color: "violet.5", kinds: ["transfer_in", "transfer_out"] },
  { key: "adjustments", label: "Adjustments", color: "blue.5", kinds: ["adjustment"] },
  { key: "other", label: "Other", color: "gray.6", kinds: [] },
] as const;
export type GroupKey = (typeof FLOW_GROUPS)[number]["key"];

/** The group an activity kind belongs to; unknown kinds are "other". */
export function groupOf(kind: string): GroupKey {
  return FLOW_GROUPS.find((g) => (g.kinds as readonly string[]).includes(kind))?.key ?? "other";
}

/** The groups the flows fall into, in display order. */
export function presentGroups(flows: Flow[]): GroupKey[] {
  const present = new Set(flows.map((f) => groupOf(f.kind)));
  return FLOW_GROUPS.filter((g) => present.has(g.key)).map((g) => g.key);
}

/** A series' data key: a group's money in or out. */
export const seriesKey = (group: GroupKey, direction: "in" | "out") => `${group}_${direction}`;

export const BUCKETS = [
  { value: "none", label: "None" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
export type Bucket = (typeof BUCKETS)[number]["value"];

export interface SpendingRow {
  /** Epoch ms: the activity's time, or the period's start. */
  t: number;
  /** In cents, by series key: positive for money in, negative for money out. */
  [series: string]: number | string | undefined;
  /** One activity: its description. */
  label?: string;
  inCents: number;
  outCents: number;
  count: number;
}

/** Local midnight on the day, the week's Monday or the month's first. */
export function periodStart(t: number, bucket: Exclude<Bucket, "none">): number {
  const d = new Date(t);
  if (bucket === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (bucket === "week") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

function nextPeriod(start: number, bucket: Exclude<Bucket, "none">): number {
  const d = new Date(start);
  if (bucket === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (bucket === "week" ? 7 : 1)).getTime();
}

function add(row: SpendingRow, flow: Flow) {
  const direction = flow.amountCents > 0 ? "in" : "out";
  const key = seriesKey(groupOf(flow.kind), direction);
  row[key] = ((row[key] as number | undefined) ?? 0) + flow.amountCents;
  if (direction === "in") row.inCents += flow.amountCents;
  else row.outCents += flow.amountCents;
  row.count++;
}

/**
 * The rows for the flows from `from` (all of them when undefined) to `now`, leaving out groups not in `shown`.
 * With no bucket, a row per activity; otherwise a row per period, empty ones included so time reads evenly.
 */
export function spendingRows(
  flows: Flow[],
  bucket: Bucket,
  shown: ReadonlySet<GroupKey>,
  from: number | undefined,
  now: number,
): SpendingRow[] {
  const inRange = flows.filter((f) => {
    const t = Date.parse(f.at);
    return shown.has(groupOf(f.kind)) && (from === undefined || t >= from) && t <= now;
  });
  if (bucket === "none") {
    return inRange.map((f) => {
      const row: SpendingRow = {
        t: Date.parse(f.at),
        label: f.description,
        inCents: 0,
        outCents: 0,
        count: 0,
      };
      add(row, f);
      return row;
    });
  }
  const first = from ?? (inRange[0] ? Date.parse(inRange[0].at) : undefined);
  if (first === undefined) return [];
  const rows: SpendingRow[] = [];
  let i = 0;
  for (let start = periodStart(first, bucket); start <= now; start = nextPeriod(start, bucket)) {
    const end = nextPeriod(start, bucket);
    const row: SpendingRow = { t: start, inCents: 0, outCents: 0, count: 0 };
    for (; i < inRange.length && Date.parse((inRange[i] as Flow).at) < end; i++) add(row, inRange[i] as Flow);
    rows.push(row);
  }
  return rows;
}

/** Totals over rows: money in, money out and the net. */
export function totals(rows: SpendingRow[]) {
  const inCents = rows.reduce((s, r) => s + r.inCents, 0);
  const outCents = rows.reduce((s, r) => s + r.outCents, 0);
  return { inCents, outCents, netCents: inCents + outCents };
}

/**
 * The grouping that suits a range: every activity over a week, a day each over a month, a week over a quarter, a
 * month beyond.
 */
export function defaultBucket(days: number | undefined): Bucket {
  if (days !== undefined && days <= 7) return "none";
  if (days !== undefined && days <= 31) return "day";
  if (days !== undefined && days <= 92) return "week";
  return "month";
}
