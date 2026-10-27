import { describe, expect, test } from "vitest";
import { ApiError, apiError, isUnauthenticated } from "../src/api.ts";
import { cardNetwork, expiryLabel } from "../src/components/CardFace.tsx";
import {
  cardLabel,
  formatMoney,
  formatRate,
  isoToLocalDate,
  localDateToIso,
  localDayStart,
  timeAgo,
  toBps,
  toCents,
} from "../src/lib/format.ts";
import {
  activitiesParams,
  parseActivitySearch,
  parseFindingsSearch,
  parseInsightsSearch,
  positiveInt,
  safeRedirect,
} from "../src/lib/search.ts";

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

describe("rates", () => {
  test("show basis points as a percentage", () => {
    expect(formatRate(650)).toBe("6.5%");
    expect(formatRate(600)).toBe("6%");
    expect(formatRate(1)).toBe("0.01%");
  });

  test("read a typed percentage as basis points, exactly", () => {
    expect(toBps("6.5")).toBe(650);
    expect(toBps(" 6.5% ")).toBe(650);
    expect(toBps("0.07")).toBe(7);
    expect(toBps("100")).toBe(10_000);
    expect(toBps("100.01")).toBeUndefined();
    expect(toBps("6.555")).toBeUndefined();
    expect(toBps("-1")).toBeUndefined();
    expect(toBps("")).toBeUndefined();
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
    expect(localDayStart("2026-02-30")).toBeUndefined();
  });

  test("starts a local day, or a later one", () => {
    const start = new Date(localDayStart("2026-10-26") ?? "");
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      2026, 9, 26, 0,
    ]);
    // Across a month's end.
    const next = new Date(localDayStart("2026-10-31", 1) ?? "");
    expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([10, 1, 0]);
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

  test("keeps only well-formed activity filters", () => {
    expect(parseActivitySearch({})).toEqual({});
    expect(
      parseActivitySearch({
        card: "2",
        kind: "purchase,nope,fee,purchase",
        status: "pending",
        from: "2026-10-01",
        to: "2026-02-30",
        q: "  cafe ",
        stale: true,
        hideFees: "true",
        finding: 9,
        activity: "41",
      }),
    ).toEqual({
      card: 2,
      kind: "purchase,fee",
      status: "pending",
      from: "2026-10-01",
      q: "cafe",
      stale: true,
      hideFees: true,
      finding: 9,
      activity: 41,
    });
    // The router reads a numeric search as a number.
    expect(parseActivitySearch({ q: 1234, kind: "nope", stale: false })).toEqual({ q: "1234" });
    expect(parseActivitySearch({ q: "   ", status: 3 })).toEqual({});
    // Only the offered page sizes, and the default stays out of the URL.
    expect(parseActivitySearch({ size: "20" })).toEqual({ size: 20 });
    expect(parseActivitySearch({ size: 10 })).toEqual({});
    expect(parseActivitySearch({ size: 30 })).toEqual({});
    // A page from 2 with its cursor, both or neither.
    expect(parseActivitySearch({ page: "3", cursor: "WyIyMDI2IiwxXQ" })).toEqual({
      page: 3,
      cursor: "WyIyMDI2IiwxXQ",
    });
    expect(parseActivitySearch({ page: 3 })).toEqual({});
    expect(parseActivitySearch({ cursor: "WyIyMDI2IiwxXQ" })).toEqual({});
    expect(parseActivitySearch({ page: 1, cursor: "WyIyMDI2IiwxXQ" })).toEqual({});
    expect(parseActivitySearch({ page: 2, cursor: "not a cursor!" })).toEqual({});
  });

  test("turns activity filters into the server's query, with an exclusive end", () => {
    // The default page size is sent too: the server's own differs.
    expect(activitiesParams(5, {})).toEqual({ logicalCardId: "5", limit: "10" });
    expect(
      activitiesParams(5, {
        kind: "fee",
        status: "pending,settled",
        from: "2026-10-01",
        to: "2026-10-26",
        q: "cafe",
        stale: true,
        hideFees: true,
        finding: 9,
        size: 100,
        activity: 41,
      }),
    ).toEqual({
      logicalCardId: "5",
      kind: "fee",
      status: "pending,settled",
      from: localDayStart("2026-10-01"),
      to: localDayStart("2026-10-27"),
      q: "cafe",
      stale: "true",
      excludeKind: "fee",
      findingId: "9",
      limit: "100",
    });
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
