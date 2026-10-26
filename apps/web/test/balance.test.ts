import { describe, expect, test } from "vitest";
import { activityRows, dailyRows, type HistoryPoint, rangeStart } from "../src/lib/balance.ts";

// Local times, so days split where the user's do.
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
const t = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();

const points: HistoryPoint[] = [
  { at: at(1, 9), cents: 2000, activity: { description: "Card issued", amountCents: 2000 } },
  { at: at(3, 10), cents: 1500, activity: { description: "COFFEE", amountCents: -500 } },
  { at: at(3, 18), cents: 1450, activity: { description: "Fee", amountCents: -50 } },
  { at: at(5, 8), cents: 11_450, activity: null },
];
const reported = [{ at: at(4, 12), cents: 1450 }];
const now = t(6, 12);

describe("per activity", () => {
  test("a step per change, the reported balances, and the latest balance carried to now", () => {
    expect(activityRows(points, reported, undefined, now)).toEqual([
      { t: t(1, 9), balance: 2000, label: "Card issued", changeCents: 2000 },
      { t: t(3, 10), balance: 1500, label: "COFFEE", changeCents: -500 },
      { t: t(3, 18), balance: 1450, label: "Fee", changeCents: -50 },
      { t: t(4, 12), reported: 1450 },
      { t: t(5, 8), balance: 11_450, label: "Opening balance", changeCents: undefined },
      { t: now, balance: 11_450 },
    ]);
  });

  test("a range opens with the balance carried into it", () => {
    const rows = activityRows(points, reported, t(3, 12), now);
    expect(rows[0]).toEqual({ t: t(3, 12), balance: 1500 });
    expect(rows.map((r) => r.label).filter(Boolean)).toEqual(["Fee", "Opening balance"]);
  });
});

describe("per day", () => {
  test("each day's closing balance, net change and reported balance, carried over quiet days", () => {
    expect(dailyRows(points, reported, undefined, now)).toEqual([
      { t: t(1, 0), balance: 2000, changes: 1, changeCents: 2000 },
      { t: t(2, 0), balance: 2000 },
      { t: t(3, 0), balance: 1450, changes: 2, changeCents: -550 },
      { t: t(4, 0), balance: 1450, reported: 1450 },
      { t: t(5, 0), balance: 11_450, changes: 1, changeCents: 10_000 },
      { t: t(6, 0), balance: 11_450 },
    ]);
  });

  test("a range starts on its first day, with the balance carried into it", () => {
    const rows = dailyRows(points, reported, t(4, 15), now);
    expect(rows.map((r) => [new Date(r.t).getDate(), r.balance])).toEqual([
      [4, 1450],
      [5, 11_450],
      [6, 11_450],
    ]);
  });

  test("nothing to chart without history", () => {
    expect(dailyRows([], [], undefined, now)).toEqual([]);
  });
});

test("ranges count back from now", () => {
  expect(rangeStart("30d", now)).toBe(now - 30 * 86_400_000);
  expect(rangeStart("all", now)).toBeUndefined();
});
