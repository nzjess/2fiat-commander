import { describe, expect, test } from "vitest";
import { activityRows, dailyRows, type HistoryPoint, rangeStart, timeTicks } from "../src/lib/balance.ts";

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
  expect(rangeStart("7d", now)).toBe(now - 7 * 86_400_000);
  expect(rangeStart("30d", now)).toBe(now - 30 * 86_400_000);
  expect(rangeStart("all", now)).toBeUndefined();
});

describe("time axis ticks", () => {
  const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
  const ticks = (from: number, to: number) =>
    timeTicks(from, to).ticks.map((t) => new Date(t).toDateString());

  test("a week: every midnight inside the span", () => {
    expect(ticks(local(2026, 10, 20, 12), local(2026, 10, 27, 12))).toEqual(
      [21, 22, 23, 24, 25, 26, 27].map((d) => new Date(2026, 9, d).toDateString()),
    );
  });

  test("a month: every Monday", () => {
    // 27 Sept 2026 is a Sunday.
    expect(ticks(local(2026, 9, 27, 12), local(2026, 10, 27, 12))).toEqual(
      [28, 35, 42, 49, 56].map((d) => new Date(2026, 8, d).toDateString()),
    );
  });

  test("90 days: the 1st and 15th", () => {
    expect(ticks(local(2026, 7, 29, 12), local(2026, 10, 27, 12))).toEqual(
      [
        [8, 1],
        [8, 15],
        [9, 1],
        [9, 15],
        [10, 1],
        [10, 15],
      ].map(([m, d]) => new Date(2026, (m as number) - 1, d).toDateString()),
    );
  });

  test("a year: each month, labelled with its year", () => {
    const axis = timeTicks(local(2025, 10, 27, 12), local(2026, 10, 27, 12));
    expect(axis.ticks).toHaveLength(12);
    expect(new Date(axis.ticks[0] as number).toDateString()).toBe(new Date(2025, 10, 1).toDateString());
    expect(axis.format(axis.ticks[0] as number)).toMatch(/2025/);
  });

  test("two years: quarters; longer: years", () => {
    const quarters = timeTicks(local(2024, 10, 27), local(2026, 10, 27)).ticks.map((t) =>
      new Date(t).getMonth(),
    );
    expect(new Set(quarters)).toEqual(new Set([0, 3, 6, 9]));
    const years = timeTicks(local(2021, 6, 1), local(2026, 10, 27));
    expect(years.ticks.map((t) => new Date(t).getFullYear())).toEqual([2022, 2023, 2024, 2025, 2026]);
    expect(years.format(years.ticks[0] as number)).toBe("2022");
  });

  test("ticks stay on midnight across a daylight saving change", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/London"; // Clocks went back on 25 Oct 2026.
    try {
      const axis = timeTicks(local(2026, 10, 22, 12), local(2026, 10, 28, 12));
      expect(axis.ticks.map((t) => [new Date(t).getDate(), new Date(t).getHours()])).toEqual(
        [23, 24, 25, 26, 27, 28].map((d) => [d, 0]),
      );
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
