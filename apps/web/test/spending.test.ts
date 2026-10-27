import { describe, expect, test } from "vitest";
import { CATEGORY_COLORS, CATEGORY_PALETTE } from "../src/lib/categories.ts";
import {
  chosenFlows,
  defaultSpendingBucket,
  MAX_CATEGORIES,
  type SpendingFlow,
  seriesTotal,
  spendingRows,
  spendingSeries,
  spendingTotals,
} from "../src/lib/spending.ts";

// Local times in October 2026.
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const t = (day: number) => new Date(2026, 9, day).getTime();
const flow = (
  day: number,
  kind: string,
  amountCents: number,
  categoryId: number | null = null,
): SpendingFlow => ({
  at: at(day),
  kind,
  amountCents,
  categoryId,
});

const flows = [
  flow(5, "topup", 10_000),
  flow(5, "purchase", -1_000, 1),
  flow(5, "fee", -50),
  flow(6, "purchase", -2_500, 2),
  flow(6, "fee", -50),
  flow(7, "refund", 400, 1),
  flow(7, "purchase", -300),
  flow(8, "transfer_out", -500),
];

describe("spending", () => {
  test("totals per category net of refunds, with fees and uncategorised apart, and only spending", () => {
    const totals = spendingTotals(flows, undefined, t(30));
    expect(Object.fromEntries(totals)).toEqual({ 1: 600, 2: 2_500, fees: 100, uncategorised: 300 });
    expect(Object.fromEntries(spendingTotals(flows, t(6), t(30)))).toEqual({
      1: -400,
      2: 2_500,
      fees: 50,
      uncategorised: 300,
    });
  });

  test("orders the series by spend, and folds categories past the limit into other", () => {
    expect(spendingSeries(spendingTotals(flows, undefined, t(30))).keys).toEqual([
      2,
      1,
      "uncategorised",
      "fees",
    ]);
    const many = Array.from({ length: MAX_CATEGORIES + 2 }, (_, i) =>
      flow(5, "purchase", -(i + 1) * 100, i + 1),
    );
    const { keys, fold } = spendingSeries(spendingTotals(many, undefined, t(30)));
    expect(keys).toEqual([10, 9, 8, 7, 6, 5, 4, 3, "other"]);
    expect(fold(2)).toBe("other");
    expect(fold(10)).toBe(10);
    expect(fold("fees")).toBe("fees");
    const totals = spendingTotals(many, undefined, t(30));
    expect(seriesTotal(totals, fold, "other")).toBe(100 + 200);
    expect(seriesTotal(totals, fold, 10)).toBe(1_000);
    // Exactly the limit needs no "other".
    const eight = many.slice(0, MAX_CATEGORIES);
    expect(spendingSeries(spendingTotals(eight, undefined, t(30))).keys).toHaveLength(MAX_CATEGORIES);
    // A lower limit, as on the card page.
    expect(spendingSeries(totals, 4).keys).toEqual([10, 9, 8, 7, "other"]);
    expect(seriesTotal(totals, spendingSeries(totals, 4).fold, "other")).toBe(
      100 + 200 + 300 + 400 + 500 + 600,
    );
  });

  test("rows per period, empty ones included, from the range's start", () => {
    const { fold } = spendingSeries(spendingTotals(flows, undefined, t(30)));
    expect(spendingRows(flows, "day", fold, t(4), t(8))).toEqual([
      { t: t(4) },
      { t: t(5), c1: 1_000, fees: 50 },
      { t: t(6), c2: 2_500, fees: 50 },
      { t: t(7), c1: -400, uncategorised: 300 },
      { t: t(8) },
    ]);
    // Monday 5 October starts a week.
    expect(spendingRows(flows, "week", fold, undefined, t(13))).toEqual([
      { t: t(5), c1: 600, c2: 2_500, fees: 100, uncategorised: 300 },
      { t: t(12) },
    ]);
    expect(spendingRows([], "day", fold, undefined, t(8))).toEqual([]);
  });

  test("narrows to the chosen series, all of them when none are", () => {
    expect(chosenFlows(flows, [])).toBe(flows);
    expect(Object.fromEntries(spendingTotals(chosenFlows(flows, ["c1", "fees"]), undefined, t(30)))).toEqual({
      1: 600,
      fees: 100,
    });
    expect(
      Object.fromEntries(spendingTotals(chosenFlows(flows, ["uncategorised"]), undefined, t(30))),
    ).toEqual({
      uncategorised: 300,
    });
  });

  test("groups a range by day, week or month, never per activity", () => {
    expect(defaultSpendingBucket(7)).toBe("day");
    expect(defaultSpendingBucket(30)).toBe("day");
    expect(defaultSpendingBucket(90)).toBe("week");
    expect(defaultSpendingBucket(365)).toBe("month");
    expect(defaultSpendingBucket(undefined)).toBe("month");
  });

  test("the palette has a light and a dark step for every colour", () => {
    expect(CATEGORY_COLORS).toEqual([
      "blue",
      "orange",
      "aqua",
      "yellow",
      "magenta",
      "green",
      "violet",
      "red",
    ]);
    for (const c of Object.values(CATEGORY_PALETTE))
      expect([c.light, c.dark]).toEqual([
        expect.stringMatching(/^#[0-9a-f]{6}$/),
        expect.stringMatching(/^#[0-9a-f]{6}$/),
      ]);
  });
});
