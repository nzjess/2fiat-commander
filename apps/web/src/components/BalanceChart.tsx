import { LineChart } from "@mantine/charts";
import { Group, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { activityRows, type ChartRow, dailyRows, RANGES, type Range, rangeStart } from "../lib/balance.ts";
import { formatMoney } from "../lib/format.ts";
import { balanceHistoryQuery } from "../queries.ts";

type Mode = "activity" | "day";

/**
 * A logical card's running ledger balance over real time, either as a step per activity or as one closing balance
 * per day, with the balances 2fiat reported as dots. Where the dots leave the line, a gap opened.
 */
export function BalanceChart({ accountId, logicalCardId }: { accountId: string; logicalCardId: number }) {
  const { data } = useSuspenseQuery(balanceHistoryQuery(accountId, logicalCardId));
  const [mode, setMode] = useState<Mode>("activity");
  const [range, setRange] = useState<Range>("90d");

  if (data.points.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No activity yet.
      </Text>
    );
  }
  const now = Date.now();
  const from = rangeStart(range, now);
  const rows =
    mode === "activity"
      ? activityRows(data.points, data.reported, from, now)
      : dailyRows(data.points, data.reported, from, now);
  const money = (cents: number) => formatMoney(cents);

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          data={[
            { value: "activity", label: "Per activity" },
            { value: "day", label: "Per day" },
          ]}
        />
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(v) => setRange(v as Range)}
          data={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </Group>
      <LineChart
        h={280}
        data={rows}
        dataKey="t"
        curveType={mode === "activity" ? "stepAfter" : "linear"}
        connectNulls
        withLegend
        withDots={false}
        series={[
          { name: "balance", label: "Ledger balance", color: "teal.6" },
          { name: "reported", label: "Reported by 2fiat", color: "blue.5" },
        ]}
        lineProps={(series) =>
          series.name === "reported"
            ? { strokeWidth: 0, dot: { r: 3, strokeWidth: 0 }, activeDot: { r: 4 } }
            : { dot: false }
        }
        xAxisProps={{
          type: "number",
          scale: "time",
          minTickGap: 40,
          domain: ["dataMin", "dataMax"],
          tickFormatter: (t: number) =>
            new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        }}
        valueFormatter={money}
        tooltipProps={{
          content: ({ active, payload }) => {
            const row = payload?.[0]?.payload as ChartRow | undefined;
            return active && row ? <Tip row={row} mode={mode} money={money} /> : null;
          },
        }}
      />
    </Stack>
  );
}

function Tip({ row, mode, money }: { row: ChartRow; mode: Mode; money: (cents: number) => string }) {
  const when = new Date(row.t).toLocaleString(
    undefined,
    mode === "day" ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" },
  );
  const signed = (cents: number) => (cents > 0 ? "+" : "") + money(cents);
  return (
    <Paper withBorder shadow="md" p="xs" radius="md" maw={300}>
      <Text size="xs" c="dimmed">
        {when}
      </Text>
      {row.balance !== undefined && (
        <Text size="sm" fw={600}>
          {money(row.balance)}
        </Text>
      )}
      {mode === "activity" && row.label && (
        <Text size="xs">
          {row.label}
          {row.changeCents !== undefined && `: ${signed(row.changeCents)}`}
        </Text>
      )}
      {mode === "day" && row.changes !== undefined && (
        <Text size="xs">
          {row.changes} {row.changes === 1 ? "change" : "changes"}, net {signed(row.changeCents ?? 0)}
        </Text>
      )}
      {row.reported !== undefined && (
        <Text size="xs" c="blue">
          2fiat reported {money(row.reported)}
        </Text>
      )}
    </Paper>
  );
}
