import { describe, expect, test } from "vitest";
import { TwoFiatClient, TwoFiatSchemaError, TwoFiatSession } from "../src/index.ts";
import { fakeFetch, json, routes } from "./fake-fetch.ts";

const tx = (id: string, createdAt = "2026-10-23T07:00:00.000Z") => ({
  id,
  cardId: "card-1",
  createdAt,
  amount: "-0.50",
  currency: "USD",
  description: "Fee",
  type: "INTERNAL",
  kind: "fee",
  op_type: 8,
  status: "COMPLETED",
  userId: "u1",
  user: { email: "someone@example.com", firstName: "Some" },
});

const order = (id: string, createdAt: string) => ({
  id,
  cardId: "card-1",
  createdAt,
  updatedAt: createdAt,
  orderType: "topup",
  status: "credited_fully",
  amount: 250,
  credited_usd: "250",
  currency: "USD",
  invoice: { id: `inv-${id}`, type: "topUp", status: "paid_fully", amount: "266.25", paid: 266.25 },
  user: { email: "someone@example.com" },
  card: { alias: "Travel", balance: 1 },
});

const clientFor = (handlers: Parameters<typeof routes>[0]) => {
  const { fetch, calls } = fakeFetch(routes(handlers));
  return { client: new TwoFiatClient(new TwoFiatSession({ token: "token1t", sid: "s", fetch })), calls };
};

/**
 * Mimics the real endpoint: filters by inclusive UTC day, and orders rows sharing a timestamp differently on every
 * request, which is what makes offset paging drop rows.
 */
const vccServer = (rows: ReturnType<typeof tx>[]) => {
  let seed = 1;
  const nextKey = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  const shuffledTies = (list: typeof rows) =>
    list
      .map((r) => ({ r, k: nextKey() }))
      .sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt) || a.k - b.k)
      .map((x) => x.r);
  return (c: { url: URL }) => {
    const p = c.url.searchParams;
    const from = p.get("dateFrom") ?? "";
    const to = p.get("dateTo") ?? "";
    const skip = Number(p.get("skip"));
    const take = Number(p.get("take"));
    const hits = rows.filter((r) => r.createdAt.slice(0, 10) >= from && r.createdAt.slice(0, 10) <= to);
    return json({ data: shuffledTies(hits).slice(skip, skip + take), totalCount: hits.length });
  };
};

// Ten rows over five days, all sharing one timestamp per day.
const rows = Array.from({ length: 10 }, (_, i) => tx(`t${i}`, `2026-10-0${1 + (i % 5)}T10:00:00.000Z`));

describe("fetchTransactions", () => {
  test("fetches a window that fits in one page with one request", async () => {
    const { client, calls } = clientFor({ "GET vccTransactions": vccServer(rows) });
    const got = await client.fetchTransactions({ from: "2026-10-01", to: "2026-10-31", cardId: "card-1" });

    expect(got.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      skip: "0",
      take: "500",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      cardId: "card-1",
    });
  });

  test("splits a window by date until each half fits in a page", async () => {
    const { client, calls } = clientFor({ "GET vccTransactions": vccServer(rows) });
    const got = await client.fetchTransactions({ from: "2026-10-01", to: "2026-10-05", pageSize: 4 });

    expect(got.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(calls.every((c) => c.url.searchParams.get("skip") === "0")).toBe(true);
    expect(
      calls.map((c) => `${c.url.searchParams.get("dateFrom")}..${c.url.searchParams.get("dateTo")}`),
    ).toEqual([
      "2026-10-01..2026-10-05",
      "2026-10-01..2026-10-03",
      "2026-10-01..2026-10-02",
      "2026-10-03..2026-10-03",
      "2026-10-04..2026-10-05",
    ]);
  });

  test("re-pages a single day with more rows than a page until every row is seen", async () => {
    const busy = Array.from({ length: 7 }, (_, i) => tx(`b${i}`, "2026-10-01T10:00:00.000Z"));
    const { client } = clientFor({ "GET vccTransactions": vccServer(busy) });
    const got = await client.fetchTransactions({ from: "2026-10-01", to: "2026-10-01", pageSize: 3 });
    expect(got.map((r) => r.id).sort()).toEqual(busy.map((r) => r.id).sort());
  });

  test("caps the page size at 500", async () => {
    const { client, calls } = clientFor({ "GET vccTransactions": () => json({ data: [], totalCount: 0 }) });
    await client.fetchTransactions({ from: "2026-10-01", to: "2026-10-31", pageSize: 5000 });
    expect(calls[0]?.url.searchParams.get("take")).toBe("500");
  });

  test("drops the embedded user and keeps unknown fields", async () => {
    const { client } = clientFor({
      "GET vccTransactions": () => json({ data: [{ ...tx("t1"), newField: 42 }], totalCount: 1 }),
    });
    const [row] = await client.fetchTransactions({ from: "2026-10-01", to: "2026-10-31" });
    expect(row).not.toHaveProperty("user");
    expect(row).toMatchObject({ id: "t1", userId: "u1", newField: 42 });
  });

  test("a row missing a field we rely on is a schema error", async () => {
    const { amount, ...broken } = tx("t1");
    const { client } = clientFor({ "GET vccTransactions": () => json({ data: [broken], totalCount: 1 }) });
    await expect(client.fetchTransactions({ from: "2026-10-01", to: "2026-10-31" })).rejects.toBeInstanceOf(
      TwoFiatSchemaError,
    );
  });
});

describe("fetchOrders", () => {
  const all = [
    order("o5", "2026-10-25T11:00:00.000Z"),
    order("o4", "2026-10-23T08:00:00.000Z"),
    order("o3", "2026-10-19T06:00:00.000Z"),
    order("o2", "2026-09-30T15:00:00.000Z"),
    order("o1", "2026-08-19T01:00:00.000Z"),
  ];
  const paged = (limit: number) => ({
    "GET orders": (c: { url: URL }) => {
      const page = Number(c.url.searchParams.get("page"));
      return json({
        limit,
        skip: (page - 1) * limit,
        totalCount: all.length,
        orders: all.slice((page - 1) * limit, page * limit),
      });
    },
  });

  test("pages through every order and drops embedded user and card", async () => {
    const { client, calls } = clientFor(paged(2));
    const orders = await client.fetchOrders();
    expect(orders.map((o) => o.id)).toEqual(["o5", "o4", "o3", "o2", "o1"]);
    expect(calls).toHaveLength(3);
    expect(orders[0]).not.toHaveProperty("user");
    expect(orders[0]).not.toHaveProperty("card");
  });

  test("stops at the first page reaching past `since`", async () => {
    const { client, calls } = clientFor(paged(2));
    const orders = await client.fetchOrders({ since: "2026-10-01T00:00:00.000Z" });
    expect(orders.map((o) => o.id)).toEqual(["o5", "o4", "o3"]);
    expect(calls).toHaveLength(2);
  });
});

describe("cards", () => {
  test("lists cards and fetches details", async () => {
    const card = {
      id: "card-1",
      alias: "Travel",
      balance: 120.5,
      cardNumber: "5257 **** **** 0042",
      currency: "USD",
      expirationDate: "06/29",
      paymentType: "mc",
      cardProduct: { id: "p1", title: "Regular" },
    };
    const { client, calls } = clientFor({
      "GET cards": () => json([card]),
      "GET prepaid-cards/details/card-1": () =>
        json({
          ...card,
          status: "1",
          createdAt: "2026-06-15T10:30:00.000Z",
          expireDate: "2029-06-01T00:00:00.000Z",
        }),
    });

    expect(await client.listCards()).toEqual([card]);
    expect(await client.getCardDetails("card-1")).toMatchObject({ status: "1" });
    expect(calls).toHaveLength(2);
  });
});
