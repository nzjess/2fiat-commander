import { describe, expect, test } from "vitest";
import { Money, rateOn } from "../src/lib/fx.ts";

// Times are noon UTC, so their local day is the same in any time zone the tests might run in.
const RATES = [
  { day: "2026-10-22", rate: 0.75 },
  { day: "2026-10-23", rate: 0.8 },
  { day: "2026-10-26", rate: 0.5 },
];

describe("rateOn", () => {
  test("takes the latest rate on or before the day, as the ECB skips weekends", () => {
    expect(rateOn(RATES, "2026-10-23")).toEqual({ day: "2026-10-23", rate: 0.8 });
    expect(rateOn(RATES, "2026-10-25")).toEqual({ day: "2026-10-23", rate: 0.8 });
    expect(rateOn(RATES, "2026-12-01")).toEqual({ day: "2026-10-26", rate: 0.5 });
  });

  test("uses the first rate before any, and nothing without rates", () => {
    expect(rateOn(RATES, "2023-06-01")).toEqual({ day: "2026-10-22", rate: 0.75 });
    expect(rateOn([], "2026-10-23")).toBeUndefined();
  });
});

describe("Money", () => {
  test("converts at the day's rate, or the latest for a balance", () => {
    const money = new Money("GBP", RATES);
    expect(money.converts).toBe(true);
    expect(money.convert(1000, "2026-10-24T12:00:00.000Z")).toEqual({
      cents: 800,
      usdCents: 1000,
      rate: { day: "2026-10-23", rate: 0.8 },
    });
    expect(money.convert(1000, null).cents).toBe(500);
    expect(money.show(-1250, "2026-10-22T12:00:00.000Z", { signed: true })).toBe("-£9.38");
  });

  test("formats other dollars distinctly, and yen without decimals", () => {
    expect(new Money("NZD", RATES).format(984)).toBe("NZ$9.84");
    expect(new Money("EUR", RATES).format(984, { signed: true })).toBe("+€9.84");
    expect(new Money("JPY", [{ day: "2026-10-26", rate: 157.45 }]).show(1250, null)).toBe("¥1,968");
  });

  test("describes where a converted amount came from", () => {
    const money = new Money("GBP", [{ day: "2026-10-03", rate: 0.787012 }]);
    expect(money.describe(money.convert(1250, "2026-10-03T12:00:00.000Z"))).toBe(
      "$12.50 at 0.78701 on 3 Oct 2026",
    );
  });

  test("stays in USD for USD, or when there are no rates", () => {
    for (const money of [new Money("USD", RATES), new Money("GBP", [])]) {
      expect(money.converts).toBe(false);
      expect(money.currency).toBe("USD");
      expect(money.convert(1250, "2026-10-23T12:00:00.000Z")).toEqual({ cents: 1250, usdCents: 1250 });
      expect(money.show(1250, null)).toBe("$12.50");
      expect(money.describe(money.convert(1250, null))).toBeUndefined();
    }
  });
});
