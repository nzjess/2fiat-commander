import { describe, expect, test } from "vitest";
import {
  defaultBucket,
  FLOW_GROUPS,
  type Flow,
  type GroupKey,
  groupColor,
  groupOf,
  kindsByGroup,
  periodStart,
  presentGroups,
  spendingRows,
  totals,
} from "../src/lib/spending.ts";

// Local times: Monday 5 to Wednesday 21 October 2026.
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const t = (day: number, hour = 0) => new Date(2026, 9, day, hour).getTime();
let id = 0;
const flow = (day: number, kind: string, amountCents: number): Flow => ({
  id: ++id,
  cardId: 1,
  at: at(day),
  kind,
  amountCents,
  description: `${kind} ${day}`,
});

const flows = [
  flow(5, "topup", 10_000),
  flow(6, "purchase", -2000),
  flow(6, "fee", -50),
  flow(13, "transfer_out", -3000),
  flow(14, "transfer_in", 500),
  flow(21, "refund", 700),
];
const all = new Set<GroupKey>(FLOW_GROUPS.map((g) => g.key));
const now = t(21, 18);

test("kinds fall into groups, unknown ones into other", () => {
  expect(groupOf("card_issue")).toBe("topups");
  expect(groupOf("transfer_in")).toBe("transfers");
  expect(groupOf("something-new")).toBe("other");
});

test("lists kinds under their groups, in the chart's order, with the groups' colours", () => {
  expect(kindsByGroup(["declined", "fee", "card_issue", "purchase", "topup"])).toEqual([
    { group: "Purchases", kinds: ["purchase"] },
    { group: "Fees", kinds: ["fee"] },
    { group: "Top-ups", kinds: ["card_issue", "topup"] },
    { group: "Other", kinds: ["declined"] },
  ]);
  expect(groupColor("card_issue")).toBe("var(--mantine-color-green-6)");
  expect(groupColor("something-new")).toBe("var(--mantine-color-gray-6)");
});

test("only the groups with activity are offered", () => {
  expect(presentGroups(flows)).toEqual(["purchases", "refunds", "fees", "topups", "transfers"]);
});

test("periods start at local midnight, on Monday, and on the first", () => {
  expect(periodStart(t(7, 15), "day")).toBe(t(7));
  expect(periodStart(t(11, 9), "week")).toBe(t(5));
  expect(periodStart(t(5, 0), "week")).toBe(t(5));
  expect(periodStart(t(21, 9), "month")).toBe(t(1));
});

describe("rows", () => {
  test("ungrouped, a row per activity, in or out by its sign", () => {
    const rows = spendingRows(flows, "none", all, undefined, now);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toMatchObject({ label: "purchase 6", purchases_out: -2000, outCents: -2000, count: 1 });
    expect(rows[4]).toMatchObject({ transfers_in: 500, inCents: 500 });
  });

  test("by week, totals per group and direction, with empty weeks kept", () => {
    const rows = spendingRows(flows, "week", all, undefined, now);
    expect(rows.map((r) => r.t)).toEqual([t(5), t(12), t(19)]);
    expect(rows[0]).toMatchObject({
      topups_in: 10_000,
      purchases_out: -2000,
      fees_out: -50,
      inCents: 10_000,
      outCents: -2050,
      count: 3,
    });
    expect(rows[1]).toMatchObject({ transfers_out: -3000, transfers_in: 500 });
  });

  test("a range starts at its first period, and a hidden group drops out of rows and totals", () => {
    const rows = spendingRows(
      flows,
      "day",
      new Set<GroupKey>(["purchases", "fees", "refunds"]),
      t(6, 6),
      now,
    );
    expect(rows[0]?.t).toBe(t(6));
    expect(rows).toHaveLength(16);
    expect(totals(rows)).toEqual({ inCents: 700, outCents: -2050, netCents: -1350 });
  });

  test("nothing to chart without flows", () => {
    expect(spendingRows([], "month", all, undefined, now)).toEqual([]);
  });
});

test("ranges pick a sensible grouping", () => {
  expect(defaultBucket(7)).toBe("none");
  expect(defaultBucket(30)).toBe("day");
  expect(defaultBucket(90)).toBe("week");
  expect(defaultBucket(365)).toBe("month");
  expect(defaultBucket(undefined)).toBe("month");
});
