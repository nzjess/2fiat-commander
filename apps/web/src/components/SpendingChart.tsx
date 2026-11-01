import { BarChart, DonutChart } from "@mantine/charts";
import {
  CheckIcon,
  ColorSwatch,
  Group,
  MultiSelect,
  Pill,
  SegmentedControl,
  Stack,
  Table,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { RANGES, type Range, rangeStart } from "../lib/balance.ts";
import { BUCKETS } from "../lib/cashflow.ts";
import { categoryHex, NEUTRALS } from "../lib/categories.ts";
import {
  chosenFlows,
  defaultSpendingBucket,
  MAX_CATEGORIES,
  type SeriesKey,
  type SpendingBucket,
  seriesName,
  seriesTotal,
  spendingRows,
  spendingSeries,
  spendingTotals,
} from "../lib/spending.ts";
import { cashFlowQuery, categoriesQuery } from "../queries.ts";
import { periodLabel } from "./CashFlowChart.tsx";
import { useMoney } from "./Money.tsx";

const SPENDING_BUCKETS = BUCKETS.filter((b) => b.value !== "none");
/** The categories with their own slice on the card page. */
const COMPACT_CATEGORIES = 4;

/**
 * What a logical card's money went on, by category: each category's share of the range as a donut, with a table
 * of the totals (which is also the legend), and the same stacked by period over time. Refunds count back against
 * their category; fees and uncategorised spending are their own series.
 */
export function SpendingChart({
  accountId,
  logicalCardId,
  compact = false,
}: {
  accountId: string;
  logicalCardId: number;
  /**
   * Only the donut and the totals, for the top four categories (the rest as Other), without the bars over time or
   * the category filter (as on the card page).
   */
  compact?: boolean;
}) {
  const { data } = useSuspenseQuery(cashFlowQuery(accountId, logicalCardId));
  const { data: categories } = useSuspenseQuery(categoriesQuery(accountId));
  const scheme = useComputedColorScheme("light");
  const [range, setRange] = useState<Range>("90d");
  const [bucket, setBucket] = useState<SpendingBucket>(defaultSpendingBucket(90));
  // The series chosen in the filter, as `seriesName`s; none means all.
  const [chosen, setChosen] = useState<string[]>([]);
  const money = useMoney();
  // Each activity in the display currency at its own day's rate, before anything is summed.
  const converted = useMemo(
    () => data.activities.map((f) => ({ ...f, amountCents: money.convert(f.amountCents, f.at).cents })),
    [data, money],
  );
  const flows = chosenFlows(converted, chosen);

  const now = Date.now();
  const from = rangeStart(range, now);
  const totals = spendingTotals(flows, from, now);
  const { keys, fold } = spendingSeries(totals, compact ? COMPACT_CATEGORIES : MAX_CATEGORIES);
  const rows = spendingRows(flows, bucket, fold, from, now);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const describe = (key: SeriesKey) => {
    if (typeof key !== "number") return { label: NEUTRALS[key].label, color: NEUTRALS[key][scheme] };
    const category = byId.get(key);
    return {
      label: category?.name ?? "Deleted category",
      color: category ? categoryHex(category.color, scheme) : NEUTRALS.other[scheme],
    };
  };
  const colorOf = (name: string) =>
    name === "fees" || name === "uncategorised"
      ? NEUTRALS[name][scheme]
      : describe(Number(name.slice(1))).color;
  const series = keys.map((key) => ({ key, ...describe(key), cents: seriesTotal(totals, fold, key) }));
  const spent = series.reduce((sum, s) => sum + s.cents, 0);

  return (
    <Stack gap="xs">
      <Group justify={compact ? "flex-end" : "space-between"}>
        {!compact && (
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Group by
            </Text>
            <SegmentedControl
              size="xs"
              value={bucket}
              onChange={(v) => setBucket(v as SpendingBucket)}
              data={SPENDING_BUCKETS.map((b) => ({ value: b.value, label: b.label }))}
            />
          </Group>
        )}
        <Group gap="xs">
          {!compact && (
            <MultiSelect
              size="xs"
              w={260}
              aria-label="Categories"
              placeholder={chosen.length ? undefined : "All categories"}
              data={[
                ...categories.map((c) => ({ value: seriesName(c.id), label: c.name })),
                { value: "uncategorised", label: NEUTRALS.uncategorised.label },
                { value: "fees", label: NEUTRALS.fees.label },
              ]}
              value={chosen}
              onChange={setChosen}
              renderOption={({ option, checked }) => (
                <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
                  <ColorSwatch color={colorOf(option.value)} size={8} withShadow={false} />
                  <Text size="xs" style={{ flex: 1 }}>
                    {option.label}
                  </Text>
                  {checked && <CheckIcon size={10} />}
                </Group>
              )}
              renderPill={({ option, onRemove, disabled }) => (
                <Pill withRemoveButton onRemove={onRemove} disabled={disabled}>
                  <Group gap={6} wrap="nowrap" component="span">
                    {option && (
                      <ColorSwatch color={colorOf(String(option.value))} size={8} withShadow={false} />
                    )}
                    {option?.label}
                  </Group>
                </Pill>
              )}
              clearable
            />
          )}
          <SegmentedControl
            size="xs"
            value={range}
            onChange={(v) => {
              setRange(v as Range);
              setBucket(defaultSpendingBucket(RANGES.find((r) => r.value === v)?.days));
            }}
            data={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </Group>
      </Group>
      {series.length === 0 ? (
        <Text c="dimmed" size="sm">
          {chosen.length ? "No spending in these categories in this range." : "No spending in this range."}
        </Text>
      ) : (
        <>
          <Group align="center" gap="xl" wrap="wrap">
            <DonutChart
              size={200}
              thickness={32}
              // A 2px gap of the surface between segments.
              strokeWidth={2}
              tooltipDataSource="segment"
              valueFormatter={(cents) => money.format(cents)}
              chartLabel={money.format(spent)}
              // A share needs something spent: a category that nets to a refund has no segment.
              data={series
                .filter((s) => s.cents > 0)
                .map((s) => ({ name: s.label, value: s.cents, color: s.color }))}
            />
            <Table w="auto" miw={300} verticalSpacing={4} fz="sm" style={{ flex: 1, maxWidth: 480 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Category</Table.Th>
                  <Table.Th ta="right">Spent</Table.Th>
                  <Table.Th ta="right">Share</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {series.map((s) => (
                  <Table.Tr key={s.key}>
                    <Table.Td>
                      <Group gap={8} wrap="nowrap">
                        <ColorSwatch color={s.color} size={10} withShadow={false} />
                        {s.label}
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {money.format(s.cents)}
                    </Table.Td>
                    <Table.Td ta="right" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {spent > 0 && s.cents > 0 ? `${Math.round((s.cents / spent) * 100)}%` : ""}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
              <Table.Tfoot>
                <Table.Tr>
                  <Table.Th>Total</Table.Th>
                  <Table.Th ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {money.format(spent)}
                  </Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Tfoot>
            </Table>
          </Group>
          {!compact && (
            <BarChart
              mt="xl"
              h={240}
              data={rows}
              dataKey="t"
              type="stacked"
              series={series.map((s) => ({ name: seriesName(s.key), label: s.label, color: s.color }))}
              barChartProps={{ stackOffset: "sign" }}
              maxBarWidth={36}
              xAxisProps={{ minTickGap: 16, tickFormatter: (t: number) => periodLabel(t, bucket) }}
              valueFormatter={(cents) => money.format(cents)}
              tooltipProps={{
                labelFormatter: (t) => periodLabel(Number(t), bucket),
              }}
            />
          )}
        </>
      )}
    </Stack>
  );
}
