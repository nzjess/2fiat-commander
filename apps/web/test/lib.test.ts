import { describe, expect, test } from "vitest";
import { ApiError, apiError, isUnauthenticated } from "../src/api.ts";
import { cardNetwork, expiryLabel } from "../src/components/CardFace.tsx";
import {
  cardLabel,
  formatMoney,
  isoToLocalDate,
  localDateToIso,
  timeAgo,
  toCents,
} from "../src/lib/format.ts";
import { parseFindingsSearch, parseInsightsSearch, positiveInt, safeRedirect } from "../src/lib/search.ts";

describe("money", () => {
  test("formats cents as US dollars, in any locale", () => {
    expect(formatMoney(1250)).toBe("$12.50");
    expect(formatMoney(-3450)).toBe("-$34.50");
    expect(formatMoney(123_456_78)).toBe("$123,456.78");
    expect(formatMoney(0)).toBe("$0.00");
  });

  test("signs gaps on request", () => {
    expect(formatMoney(1000, { signed: true })).toBe("+$10.00");
    expect(formatMoney(-1200, { signed: true })).toBe("-$12.00");
    expect(formatMoney(0, { signed: true })).toBe("$0.00");
  });

  test("reads typed dollars as cents, exactly", () => {
    expect(toCents("120.5")).toBe(12_050);
    expect(toCents(" 0.07 ")).toBe(7);
    expect(toCents("-34.50")).toBe(-3450);
    expect(toCents("1.005")).toBeUndefined();
    expect(toCents("12,50")).toBeUndefined();
    expect(toCents("")).toBeUndefined();
  });
});

describe("cards", () => {
  test("labels a card by alias and last four digits", () => {
    expect(cardLabel({ alias: "Everyday", maskedNumber: "5257 **** **** 1234" })).toBe("Everyday ·· 1234");
  });

  test("reads the network and expiry", () => {
    expect(cardNetwork("5257 **** **** 0000")).toBe("mastercard");
    expect(cardNetwork("4111 **** **** 0000")).toBe("visa");
    expect(cardNetwork("**** 0000")).toBeUndefined();
    expect(expiryLabel("2029-06-01T00:00:00.000Z")).toBe("06/29");
    expect(expiryLabel(null)).toBe("--/--");
  });

  test("says how long ago", () => {
    const now = Date.parse("2026-10-26T12:00:00.000Z");
    const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    expect(timeAgo("2026-10-26T11:59:30.000Z", now, format)).toBe("just now");
    expect(timeAgo("2026-10-26T11:55:00.000Z", now, format)).toBe("5 minutes ago");
    expect(timeAgo("2026-10-25T12:00:00.000Z", now, format)).toBe("yesterday");
  });
});

describe("dates", () => {
  test("a date input's day survives the round trip through an ISO time", () => {
    const iso = localDateToIso("2026-09-03");
    expect(iso).toBeDefined();
    expect(isoToLocalDate(iso ?? "")).toBe("2026-09-03");
    expect(new Date(iso ?? "").getHours()).toBe(12);
  });

  test("rejects what isn't a real date", () => {
    expect(localDateToIso("2026-02-30")).toBeUndefined();
    expect(localDateToIso("2026-13-01")).toBeUndefined();
    expect(localDateToIso("")).toBeUndefined();
  });
});

describe("search params", () => {
  test("keeps only well-formed findings filters", () => {
    expect(parseFindingsSearch({})).toEqual({});
    expect(parseFindingsSearch({ status: "resolved", card: 3, kind: "balance-gap" })).toEqual({
      status: "resolved",
      card: 3,
      kind: "balance-gap",
    });
    // "open" is the default, so it stays out of the URL.
    expect(parseFindingsSearch({ status: "open", card: "7" })).toEqual({ card: 7 });
    expect(parseFindingsSearch({ status: "nope", card: -1, kind: "x;y" })).toEqual({});
    expect(parseFindingsSearch({ status: "explained" })).toEqual({ status: "explained" });
  });

  test("keeps only a well-formed insights card", () => {
    expect(parseInsightsSearch({ card: "4" })).toEqual({ card: 4 });
    expect(parseInsightsSearch({ card: "x" })).toEqual({});
  });

  test("reads positive integers", () => {
    expect(positiveInt(4)).toBe(4);
    expect(positiveInt("12")).toBe(12);
    expect(positiveInt("1.5")).toBeUndefined();
    expect(positiveInt(0)).toBeUndefined();
    expect(positiveInt("abc")).toBeUndefined();
  });

  test("only redirects within the site after login", () => {
    expect(safeRedirect("/a/1/findings?status=all")).toBe("/a/1/findings?status=all");
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect("/\\evil.example")).toBeUndefined();
    expect(safeRedirect("/login?redirect=/")).toBeUndefined();
    expect(safeRedirect(undefined)).toBeUndefined();
  });
});

describe("API errors", () => {
  test("reads our error body", () => {
    const error = apiError(409, { error: "sync_running", message: "a sync is already running" });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "sync_running", message: "a sync is already running" });
  });

  test("falls back to the status without one", () => {
    expect(apiError(502, undefined, "Bad Gateway")).toMatchObject({
      code: "http_error",
      message: "502 Bad Gateway",
    });
    expect(apiError(500, { oops: true })).toMatchObject({ code: "http_error", message: "HTTP 500" });
  });

  test("spots an expired session, but not wrong credentials", () => {
    expect(isUnauthenticated(apiError(401, { error: "unauthenticated", message: "log in" }))).toBe(true);
    expect(isUnauthenticated(apiError(401, { error: "invalid_credentials", message: "wrong" }))).toBe(false);
    expect(isUnauthenticated(new Error("x"))).toBe(false);
  });
});
