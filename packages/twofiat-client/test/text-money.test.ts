import { describe, expect, test } from "vitest";
import { descriptionSimilarity, merchantKey, parseCents } from "../src/index.ts";

describe("parseCents", () => {
  test.each([
    ["+250.00", 25000],
    ["-0.50", -50],
    ["200", 20000],
    ["-61.250000", -6125],
    ["0.00", 0],
    ["-81.450000", -8145],
    ["0.29", 29],
    ["1.005", 101],
  ])("%s → %d", (input, cents) => {
    expect(parseCents(input)).toBe(cents);
  });

  test("rejects non-decimals", () => {
    expect(() => parseCents("12,50")).toThrow();
  });
});

describe("descriptionSimilarity", () => {
  test.each([
    ["SP SOME SHOP", "SP SOME SHOP SPRINGFIELD USA", 1],
    ["BIGSTORE* QX7R20LM4", "BIGSTORE.CO.EX SPRINGFIELD USA", 0.5],
    ["RIDEAPP   *TRIP", "RDA* PENDING.RIDEAPP.COM Springfield USA", 0.5],
    ["FAM*CAB JONES TRANSP", "CAB JONES TRANSPOR SPRINGFIELD ILL USA", 0.75],
    ["GREEN AND WELLS", "12345678AND WELLS SPRINGFIELD USA", 0.5],
    ["CAFE CORNER", "FUELSTOP SPRINGFIELD USA", 0],
  ])("%s ~ %s", (posted, authorized, expected) => {
    expect(descriptionSimilarity(posted, authorized)).toBeCloseTo(expected, 2);
  });
});

describe("merchantKey", () => {
  test.each([
    ["SP SOME SHOP SPRINGFIELD USA", "sp some shop springfield"],
    ["BIGSTORE* QX7R20LM4", "bigstore"],
    ["RIDEAPP   *TRIP", "rideapp trip"],
    ["BIGSTORE.CO.EX SPRINGFIELD USA", "bigstore co ex springfield"],
    ["GROCER STORES 4821 SPRINGFIELD USA", "grocer stores springfield"],
    ["GBR", "gbr"],
    ["12345", ""],
  ])("%s → %s", (description, key) => {
    expect(merchantKey(description)).toBe(key);
  });
});
