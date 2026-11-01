import { describe, expect, test, vi } from "vitest";
import { ApiError, apiError, isUnauthenticated } from "../src/api.ts";
import { cardNetwork, expiryLabel } from "../src/components/CardFace.tsx";
import { accessLabel, accessOf, inviteLink, linkGains, roleLabel, roleOptions } from "../src/lib/access.ts";
import {
  cardLabel,
  cardStatusLabel,
  formatMoney,
  formatRate,
  isoToLocalDate,
  localDateToIso,
  localDayStart,
  logicalCardLabel,
  timeAgo,
  toBps,
  toCents,
} from "../src/lib/format.ts";
import {
  activitiesParams,
  datePresets,
  parseActivitySearch,
  parseFindingsSearch,
  positiveInt,
  safeRedirect,
} from "../src/lib/search.ts";
import { defaultCard, getLastCard, setLastCard } from "../src/lib/storage.ts";

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

  test("names an inactive card's status: 2 as inactive (assumed), others as they are", () => {
    expect(cardStatusLabel({ status: "1" })).toBeUndefined();
    expect(cardStatusLabel({ status: null })).toBeUndefined();
    expect(cardStatusLabel({ status: "2" })).toBe("Inactive");
    expect(cardStatusLabel({ status: "3" })).toBe("Status 3");
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
    expect(parseFindingsSearch({ status: "resolved", kind: "balance-gap" })).toEqual({
      status: "resolved",
      kind: "balance-gap",
    });
    // "open" is the default, so it stays out of the URL; the card is in the path, not the search.
    expect(parseFindingsSearch({ status: "open", card: "7" })).toEqual({});
    expect(parseFindingsSearch({ status: "nope", kind: "x;y" })).toEqual({});
    expect(parseFindingsSearch({ status: "explained" })).toEqual({ status: "explained" });
  });

  test("keeps only well-formed activity filters", () => {
    expect(parseActivitySearch({})).toEqual({});
    expect(
      parseActivitySearch({
        card: "2",
        kind: "purchase,nope,fee,purchase",
        status: "stale,nope,pending",
        from: "2026-10-01",
        to: "2026-02-30",
        q: "  cafe ",
        hideFees: "true",
        finding: 9,
        activity: "41",
      }),
    ).toEqual({
      kind: "purchase,fee",
      status: "stale,pending",
      from: "2026-10-01",
      q: "cafe",
      hideFees: true,
      finding: 9,
      activity: 41,
    });
    // The router reads a numeric search as a number.
    expect(parseActivitySearch({ q: 1234, kind: "nope" })).toEqual({ q: "1234" });
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
    // Category ids and "none", deduplicated; a lone id may arrive as a number.
    expect(parseActivitySearch({ category: "3,none,x,0,3" })).toEqual({ category: "3,none" });
    expect(parseActivitySearch({ category: 7 })).toEqual({ category: "7" });
    expect(parseActivitySearch({ category: "x" })).toEqual({});
  });

  test("offers date range quick picks up to today, as local dates", () => {
    const ranges = (now: Date) => Object.fromEntries(datePresets(now).map((p) => [p.label, p.value]));
    expect(ranges(new Date(2026, 9, 27, 15))).toEqual({
      "Last 7 days": ["2026-10-21", "2026-10-27"],
      "Last 30 days": ["2026-09-28", "2026-10-27"],
      "This month": ["2026-10-01", "2026-10-27"],
      "Last month": ["2026-09-01", "2026-09-30"],
      "This year": ["2026-01-01", "2026-10-27"],
    });
    // Early in January, the last month and the last days are last year's.
    expect(ranges(new Date(2027, 0, 3, 9))).toMatchObject({
      "Last 7 days": ["2026-12-28", "2027-01-03"],
      "Last month": ["2026-12-01", "2026-12-31"],
      "This year": ["2027-01-01", "2027-01-03"],
    });
  });

  test("turns activity filters into the server's query, with an exclusive end", () => {
    // The default page size is sent too: the server's own differs.
    expect(activitiesParams(5, {})).toEqual({ logicalCardId: "5", limit: "10" });
    expect(activitiesParams(5, { category: "3,none" })).toMatchObject({ category: "3,none" });
    expect(
      activitiesParams(5, {
        kind: "fee",
        status: "stale,settled",
        from: "2026-10-01",
        to: "2026-10-26",
        q: "cafe",
        hideFees: true,
        finding: 9,
        size: 100,
        activity: 41,
      }),
    ).toEqual({
      logicalCardId: "5",
      kind: "fee",
      status: "stale,settled",
      from: localDayStart("2026-10-01"),
      to: localDayStart("2026-10-27"),
      q: "cafe",
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

describe("the remembered card", () => {
  test("is the default while it exists, else the first card; without storage, the first", () => {
    const cards = [{ id: 4 }, { id: 7 }];
    expect(defaultCard("1", cards)).toBe(4);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    try {
      setLastCard("1", 7);
      expect(getLastCard("1")).toBe(7);
      expect(defaultCard("1", cards)).toBe(7);
      // Per account.
      expect(defaultCard("2", cards)).toBe(4);
      // A card that's gone (e.g. linked into another).
      expect(defaultCard("1", [{ id: 4 }])).toBe(4);
      expect(defaultCard("1", [])).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("access", () => {
  const none = { accountRole: null, account: [], everyCard: [], cards: [] };

  test("a whole-account grant applies to every card, and a card grant to its card", () => {
    const whole = accessOf({
      ...none,
      accountRole: "member",
      account: ["account.view"],
      everyCard: ["card.view"],
    });
    expect(whole.can("account.view")).toBe(true);
    expect(whole.can("fees.edit")).toBe(false);
    expect(whole.canOnCard("card.view", 9)).toBe(true);
    expect(whole.canOnCard("card.adjust", 9)).toBe(false);

    const card = accessOf({
      ...none,
      cards: [{ logicalCardId: 1, role: "manager", permissions: ["card.view", "card.sync"] }],
    });
    expect(card.can("account.view")).toBe(false);
    expect(card.canOnCard("card.sync", 1)).toBe(true);
    expect(card.canOnCard("card.view", 2)).toBe(false);
    expect(card.canOnAnyCard("card.sync")).toBe(true);
    expect(card.canOnAnyCard("card.adjust")).toBe(false);
  });

  test("grants add up", () => {
    const both = accessOf({
      ...none,
      accountRole: "member",
      account: ["account.view"],
      everyCard: ["card.view"],
      cards: [{ logicalCardId: 1, role: "manager", permissions: ["card.view", "card.adjust"] }],
    });
    expect(both.canOnCard("card.adjust", 1)).toBe(true);
    expect(both.canOnCard("card.adjust", 2)).toBe(false);
    expect(both.canOnCard("card.view", 2)).toBe(true);
  });

  test("names roles as the UI does: a manager of a card is its card owner", () => {
    expect(roleLabel("owner", false)).toBe("Account owner");
    expect(roleLabel("manager", false)).toBe("Account manager");
    expect(roleLabel("member", false)).toBe("Account member");
    expect(roleLabel("manager", true)).toBe("Card owner");
    expect(roleLabel("member", true)).toBe("Card member");
  });

  test("offers owner only on the whole account", () => {
    expect(roleOptions(false).map((o) => o.value)).toEqual(["owner", "manager", "member"]);
    expect(roleOptions(true)).toEqual([
      { value: "manager", label: "Card owner" },
      { value: "member", label: "Card member" },
    ]);
  });

  test("describes a user's own access", () => {
    expect(accessLabel({ ...none, accountRole: "owner" })).toBe("Account owner");
    const card = (logicalCardId: number, role: "manager" | "member") => ({
      logicalCardId,
      role,
      permissions: [],
    });
    expect(accessLabel({ ...none, cards: [card(1, "manager"), card(2, "manager")] })).toBe("Card owner");
    expect(accessLabel({ ...none, cards: [card(1, "manager"), card(2, "member")] })).toBe(
      "Card owner, Card member",
    );
    expect(accessLabel({ ...none, accountRole: "member", cards: [card(1, "manager")] })).toBe(
      "Account member",
    );
  });

  test("a link shows more to those with a grant on just one of the two cards", () => {
    const grants = [
      { username: "owner", logicalCardId: null },
      { username: "owner", logicalCardId: 1 },
      { username: "zoe", logicalCardId: 1 },
      { username: "amy", logicalCardId: 2 },
      { username: "both", logicalCardId: 1 },
      { username: "both", logicalCardId: 2 },
      { username: "elsewhere", logicalCardId: 3 },
    ];
    expect(linkGains(grants, 1, 2)).toEqual(["amy", "zoe"]);
    expect(linkGains([], 1, 2)).toEqual([]);
  });
});

describe("logicalCardLabel", () => {
  const cards = [
    { id: 1, maskedNumber: "5257 **** **** 1111" },
    { id: 2, maskedNumber: "5257 **** **** 2222" },
  ];

  test("names the current card's last four digits", () => {
    expect(logicalCardLabel({ name: "Everyday", cardIds: [1, 2], currentCardId: 2 }, cards)).toBe(
      "Everyday ·· 2222",
    );
  });

  test("falls back to its first card, or just the name", () => {
    expect(logicalCardLabel({ name: "Everyday", cardIds: [1, 2], currentCardId: null }, cards)).toBe(
      "Everyday ·· 1111",
    );
    expect(logicalCardLabel({ name: "New", cardIds: [], currentCardId: null }, cards)).toBe("New");
  });
});

describe("inviteLink", () => {
  test("puts the token in the fragment, on this page's origin", () => {
    expect(inviteLink("http://127.0.0.1:3000", "abc")).toBe("http://127.0.0.1:3000/invite#abc");
  });
});
