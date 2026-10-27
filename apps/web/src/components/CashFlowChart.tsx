import { BarChart } from "@mantine/charts";
import {
  Chip,
  ColorSwatch,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  useMantineTheme,
} from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { RANGES, type Range, rangeStart } from "../lib/balance.ts";
import {
  BUCKETS,
  type Bucket,
  type CashFlowRow,
  cashFlowRows,
  defaultBucket,
  FLOW_GROUPS,
  type GroupKey,
  presentGroups,
  seriesKey,
  totals,
} from "../lib/cashflow.ts";
import type { Money } from "../lib/fx.ts";
import { cashFlowQuery } from "../queries.ts";
import { useMoney } from "./Money.tsx";

const ALL_GROUPS = FLOW_GROUPS.map((g) => g.key);
const DAY = 86_400_000;

function periodLabel(t: number, bucket: Bucket): string {
  const d = new Date(t);
  if (bucket === "month") return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return bucket === "week" ? `w/c ${day}` : day;
}

/**
 * A logical card's money in and out over time: a bar per activity, or totals per day, week or month, stacked by
 * kind with money in above the axis and money out below. Each kind can be toggled, e.g. to leave out top-ups.
 */
export function CashFlowChart({ accountId, logicalCardId }: { accountId: string; logicalCardId: number }) {
  const { data } = useSuspenseQuery(cashFlowQuery(accountId, logicalCardId));
  const theme = useMantineTheme();
  const [range, setRange] = useState<Range>("90d");
  const [bucket, setBucket] = useState<Bucket>(defaultBucket(90));
  const [shown, setShown] = useState<GroupKey[]>(ALL_GROUPS);
  const money = useMoney();
  // Each activity in the display currency at its own day's rate, before anything is summed.
  const flows = useMemo(
    () => data.activities.map((f) => ({ ...f, amountCents: money.convert(f.amountCents, f.at).cents })),
    [data, money],
  );

  if (data.activities.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No activity yet.
      </Text>
    );
  }
  const now = Date.now();
  const from = rangeStart(range, now);
  const present = presentGroups(flows);
  const rows = cashFlowRows(flows, bucket, new Set(shown), from, now);
  const sum = totals(rows);
  // Only the series with something in them, so empty ones don't take up room.
  const series = FLOW_GROUPS.flatMap((g) =>
    (["in", "out"] as const)
      .map((direction) => seriesKey(g.key, direction))
      .filter((key) => rows.some((r) => r[key] !== undefined))
      .map((name) => ({ name, label: g.label, color: g.color })),
  );
  const color = (c: string) => {
    const [name, shade] = c.split(".");
    return theme.colors[name ?? "gray"]?.[Number(shade)] ?? c;
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Group by
          </Text>
          <SegmentedControl
            size="xs"
            value={bucket}
            onChange={(v) => setBucket(v as Bucket)}
            data={BUCKETS.map((b) => ({ value: b.value, label: b.label }))}
          />
        </Group>
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => {
            setRange(v as Range);
            setBucket(defaultBucket(RANGES.find((r) => r.value === v)?.days));
          }}
          data={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </Group>
      <Chip.Group multiple value={shown} onChange={(v) => setShown(v as GroupKey[])}>
        <Group gap={6}>
          {FLOW_GROUPS.filter((g) => present.includes(g.key)).map((g) => (
            <Chip
              key={g.key}
              value={g.key}
              size="xs"
              variant="light"
              icon={<ColorSwatch color={color(g.color)} size={10} />}
            >
              {g.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      <Group gap="lg">
        <Text size="sm">
          In <b>{money.format(sum.inCents)}</b>
        </Text>
        <Text size="sm">
          Out <b>{money.format(-sum.outCents)}</b>
        </Text>
        <Text size="sm">
          Net <b>{money.format(sum.netCents, { signed: true })}</b>
        </Text>
        {money.converts && (
          <Text size="xs" c="dimmed">
            Converted from USD at each day's rate, so approximate
          </Text>
        )}
      </Group>
      <BarChart
        h={280}
        data={rows}
        dataKey="t"
        type="stacked"
        series={series}
        barChartProps={{ stackOffset: "sign" }}
        maxBarWidth={36}
        barProps={bucket === "none" ? { shape: TimeBar } : {}}
        xAxisProps={
          bucket === "none"
            ? {
                type: "number",
                scale: "time",
                domain: [from ?? (rows[0]?.t ?? now) - DAY, now],
                minTickGap: 40,
                tickFormatter: (t: number) => periodLabel(t, "day"),
              }
            : { minTickGap: 16, tickFormatter: (t: number) => periodLabel(t, bucket) }
        }
        valueFormatter={(cents) => money.format(cents)}
        tooltipProps={{
          content: ({ active, payload }) => {
            const row = payload?.[0]?.payload as CashFlowRow | undefined;
            return active && row ? <Tip row={row} bucket={bucket} money={money} /> : null;
          },
        }}
      />
    </Stack>
  );
}

const TIME_BAR_WIDTH = 4;

/**
 * An ungrouped bar, drawn at a fixed width centred on its activity's time. On a time axis, Recharts sizes bars by
 * the closest two points, which can be a second apart (a purchase and its fee), leaving every bar too thin to see.
 */
function TimeBar(props: unknown) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    fill,
  } = props as {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fill?: string;
  };
  // Money out stacks below the axis, where Recharts gives a negative height.
  const top = Math.min(y, y + height);
  return (
    <rect
      x={x + width / 2 - TIME_BAR_WIDTH / 2}
      y={top}
      width={TIME_BAR_WIDTH}
      height={Math.abs(height)}
      fill={fill}
    />
  );
}

function Tip({ row, bucket, money }: { row: CashFlowRow; bucket: Bucket; money: Money }) {
  const when =
    bucket === "none"
      ? new Date(row.t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : periodLabel(row.t, bucket);
  const parts = FLOW_GROUPS.flatMap((g) =>
    (["in", "out"] as const).flatMap((direction) => {
      const cents = row[seriesKey(g.key, direction)];
      return typeof cents === "number" ? [{ label: g.label, cents }] : [];
    }),
  );
  return (
    <Paper withBorder shadow="md" p="xs" radius="md" maw={320}>
      <Text size="xs" c="dimmed">
        {when}
      </Text>
      {bucket === "none" ? (
        <>
          <Text size="sm">{row.label}</Text>
          <Text size="sm" fw={600}>
            {money.format(row.inCents + row.outCents, { signed: true })}
          </Text>
        </>
      ) : (
        <>
          {parts.map((p) => (
            <Group key={`${p.label}${p.cents > 0}`} justify="space-between" gap="md">
              <Text size="xs">{p.label}</Text>
              <Text size="xs">{money.format(p.cents, { signed: true })}</Text>
            </Group>
          ))}
          <Text size="xs" fw={600} mt={4}>
            {row.count} {row.count === 1 ? "activity" : "activities"}, net{" "}
            {money.format(row.inCents + row.outCents, { signed: true })}
          </Text>
        </>
      )}
    </Paper>
  );
}
