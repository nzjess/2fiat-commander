import type { RawCardDetails, RawOrder, RawTransaction } from "@twofiat/client";
import { fakeFetch, json, sidCookie } from "@twofiat/client/fake-fetch";

/**
 * An in-memory stand-in for 2fiat's API, serving whatever its state holds. `balancesAfterRows` changes the
 * balances 2fiat reports between a sync's transaction fetch and its closing card listing, as if a row landed
 * mid-sync.
 */
export function fake2fiat(initial: {
  cards: RawCardDetails[];
  transactions?: RawTransaction[];
  orders?: RawOrder[];
}) {
  const state = {
    cards: initial.cards,
    transactions: initial.transactions ?? [],
    orders: initial.orders ?? [],
    sid: "sid-1",
    /** When set, the exchange rejects any other token. */
    validTokens: undefined as string[] | undefined,
    balancesAfterRows: undefined as Record<string, number> | undefined,
  };
  let rowsFetched = false;

  const { fetch, calls } = fakeFetch((call) => {
    const path = call.url.pathname.replace(/^\/api\/v1\//, "");
    const q = call.url.searchParams;
    if (call.method === "POST" && path === "auth/exchange") {
      const token = (call.body as { token?: string } | undefined)?.token ?? "";
      if (state.validTokens && !state.validTokens.includes(token)) {
        return json({ error: "Invalid token" }, { status: 401 });
      }
      return json({ ok: true, redirectPath: "/wallet/my-cards" }, { headers: sidCookie(state.sid) });
    }
    if (call.headers.cookie !== `sid=${state.sid}`) return json({ error: "Unauthorized" }, { status: 401 });

    const balance = (c: RawCardDetails) =>
      (rowsFetched ? state.balancesAfterRows?.[c.id] : undefined) ?? c.balance;
    if (path === "cards") {
      const listing = state.cards.map((c) => ({
        id: c.id,
        alias: c.alias,
        balance: balance(c),
        cardNumber: c.cardNumber,
        currency: c.currency,
        expirationDate: "06/29",
        paymentType: "mastercard",
        cardProduct: c.cardProduct,
      }));
      // A listing after the rows ends a sync's view of 2fiat.
      rowsFetched = false;
      return json(listing);
    }
    if (path.startsWith("prepaid-cards/details/")) {
      const card = state.cards.find((c) => c.id === decodeURIComponent(path.split("/").pop() ?? ""));
      return card ? json({ ...card, balance: balance(card) }) : json({ error: "Not found" }, { status: 404 });
    }
    if (path === "vccTransactions") {
      rowsFetched = true;
      const from = `${q.get("dateFrom")}T00:00:00.000Z`;
      const to = `${q.get("dateTo")}T23:59:59.999Z`;
      const cardId = q.get("cardId");
      const rows = state.transactions
        .filter((t) => t.createdAt >= from && t.createdAt <= to && (!cardId || t.cardId === cardId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const skip = Number(q.get("skip") ?? 0);
      return json({ data: rows.slice(skip, skip + Number(q.get("take"))), totalCount: rows.length });
    }
    if (path === "orders") {
      const limit = 10;
      const skip = (Number(q.get("page")) - 1) * limit;
      const orders = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ limit, skip, totalCount: orders.length, orders: orders.slice(skip, skip + limit) });
    }
    throw new Error(`fake 2fiat has no route for ${call.method} ${path}`);
  });
  return { state, fetch, calls };
}
