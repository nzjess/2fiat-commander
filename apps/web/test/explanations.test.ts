import { describe, expect, test } from "vitest";
import { monthLabel, suggestExplanation } from "../src/lib/explanations.ts";

describe("suggested explanations", () => {
  test("a month's fees charged less than accepted", () => {
    expect(suggestExplanation({ kind: "transaction-fees-off-schedule", cents: 200, scope: "2026-10" })).toBe(
      "2fiat charged $2.00 less in fees in October 2026 than the accepted schedule: a few fees were never charged. In my favour.",
    );
  });

  test("nothing for fees charged more than accepted", () => {
    expect(
      suggestExplanation({ kind: "transaction-fees-off-schedule", cents: -200, scope: "2026-10" }),
    ).toBeUndefined();
    expect(suggestExplanation({ kind: "topup-fee-off-schedule", cents: -100, scope: null })).toBeUndefined();
  });

  test("a top-up charged less than the accepted rate", () => {
    expect(suggestExplanation({ kind: "topup-fee-off-schedule", cents: 125, scope: null })).toBe(
      "2fiat charged $1.25 less than the accepted rate on this top-up. In my favour.",
    );
  });

  test("kinds with a likely reason, and none for the rest", () => {
    expect(suggestExplanation({ kind: "history-incomplete", cents: null, scope: null })).toMatch(
      /earlier token/,
    );
    expect(suggestExplanation({ kind: "stale-authorization", cents: -1500, scope: null })).toBe(
      "A hold the merchant never collected.",
    );
    expect(suggestExplanation({ kind: "fees-above-advertised", cents: -6050, scope: null })).toBe(
      "2fiat charges more than it advertises.",
    );
    expect(suggestExplanation({ kind: "balance-gap", cents: 8500, scope: null })).toBeUndefined();
    expect(suggestExplanation({ kind: "credit-shortfall", cents: -9999, scope: null })).toBeUndefined();
  });

  test("names a month scope", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel(null)).toBeUndefined();
    expect(monthLabel("nope")).toBeUndefined();
  });
});
