import { describe, expect, test } from "vitest";
import { TwoFiatAuthError, TwoFiatError, TwoFiatSession } from "../src/index.ts";
import { fakeFetch, json, requireSid, routes, sidCookie } from "./fake-fetch.ts";

const TOKEN = "token1testtoken";
const noSleep = async () => {};

const exchangeIssuing = (...sids: string[]) => {
  let i = 0;
  return () =>
    json({ ok: true, redirectPath: "/wallet/my-cards" }, { headers: sidCookie(sids[i++] ?? "spent") });
};

describe("TwoFiatSession", () => {
  test("exchanges the token for a sid before the first request", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "POST auth/exchange": exchangeIssuing("s1"),
        "GET cards": requireSid("s1", () => json([])),
      }),
    );
    const issued: string[] = [];
    const session = new TwoFiatSession({ token: TOKEN, fetch, onSid: (s) => issued.push(s) });

    expect(await session.get("cards")).toEqual([]);
    expect(calls[0]?.body).toEqual({ token: TOKEN, nextPath: "/wallet/my-cards" });
    expect(calls[1]?.headers["user-agent"]).toMatch(/Mozilla/);
    expect(issued).toEqual(["s1"]);
  });

  test("reuses a given sid and re-exchanges once on 401", async () => {
    const { fetch, calls } = fakeFetch(
      routes({
        "POST auth/exchange": exchangeIssuing("fresh"),
        "GET cards": requireSid("fresh", () => json([])),
      }),
    );
    const session = new TwoFiatSession({ token: TOKEN, sid: "expired", fetch });

    await session.get("cards");
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /api/v1/cards",
      "POST /api/v1/auth/exchange",
      "GET /api/v1/cards",
    ]);
    expect(session.sid).toBe("fresh");
  });

  test("gives up when a fresh sid is still rejected", async () => {
    const { fetch } = fakeFetch(
      routes({
        "POST auth/exchange": exchangeIssuing("s1", "s2"),
        "GET cards": requireSid("never", () => json([])),
      }),
    );
    const session = new TwoFiatSession({ token: TOKEN, fetch });
    await expect(session.get("cards")).rejects.toMatchObject({ status: 401 });
  });

  test("a rejected token is an auth error", async () => {
    const { fetch } = fakeFetch(
      routes({ "POST auth/exchange": () => json({ error: "bad" }, { status: 400 }) }),
    );
    const session = new TwoFiatSession({ token: TOKEN, fetch });
    await expect(session.get("cards")).rejects.toBeInstanceOf(TwoFiatAuthError);
  });

  test("an exchange without a sid cookie is an auth error", async () => {
    const { fetch } = fakeFetch(routes({ "POST auth/exchange": () => json({ ok: true }) }));
    await expect(new TwoFiatSession({ token: TOKEN, fetch }).exchange()).rejects.toBeInstanceOf(
      TwoFiatAuthError,
    );
  });

  test("retries 5xx and network errors with backoff", async () => {
    let n = 0;
    const { fetch } = fakeFetch(
      routes({
        "GET cards": () => {
          n++;
          if (n === 1) throw new TypeError("fetch failed");
          if (n === 2) return json({}, { status: 503 });
          return json([]);
        },
      }),
    );
    const delays: number[] = [];
    const session = new TwoFiatSession({
      token: TOKEN,
      sid: "s",
      fetch,
      sleep: async (ms) => void delays.push(ms),
    });

    expect(await session.get("cards")).toEqual([]);
    expect(delays).toEqual([500, 1000]);
  });

  test("stops retrying after maxRetries", async () => {
    const { fetch, calls } = fakeFetch(routes({ "GET cards": () => json({}, { status: 503 }) }));
    const session = new TwoFiatSession({ token: TOKEN, sid: "s", fetch, sleep: noSleep, maxRetries: 2 });

    const result = session.get("cards");
    await expect(result).rejects.toBeInstanceOf(TwoFiatError);
    await expect(result).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });

  test("encodes query parameters and skips undefined ones", async () => {
    const { fetch, calls } = fakeFetch(routes({ "GET vccTransactions": () => json({}) }));
    const session = new TwoFiatSession({ token: TOKEN, sid: "s", fetch });

    await session.get("vccTransactions", { skip: 0, take: 500, cardId: undefined, dateFrom: "2026-10-01" });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      skip: "0",
      take: "500",
      dateFrom: "2026-10-01",
    });
  });
});
