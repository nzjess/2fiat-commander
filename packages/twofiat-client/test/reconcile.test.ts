import { describe, expect, test } from "vitest";
import {
  type Finding,
  normalize,
  productTerms,
  type RawOrder,
  type RawTransaction,
  reconcile,
} from "../src/index.ts";
import { authorization, card, declined, fee, order, posting, topupRow } from "./fixtures.ts";

const issue = order({
  at: "2026-06-15T10:20:00.000Z",
  amount: 50,
  credited: "0",
  orderType: "issue",
  status: "paid_fully",
});

function reconcileOne(
  balance: number,
  transactions: RawTransaction[],
  orders: RawOrder[],
  asOf = "2026-10-25T00:00:00.000Z",
) {
  const cards = [card({ balance })];
  const activities = normalize({ transactions, orders, cards });
  const [r] = reconcile({ cards, transactions, activities, asOf });
  if (!r) throw new Error("no reconciliation");
  return r;
}

const kinds = (findings: Finding[]) => findings.map((f) => f.kind);

test("product terms come from metadata and the advertised description", () => {
  expect(productTerms(card({ balance: 0 }))).toEqual({
    startingDeposit: 20,
    topupFeeRate: 0.065,
    advertisedTopupFeeRate: 0.06,
    advertisedAuthorizationFeeCents: 50,
  });
});

describe("balance", () => {
  test("a ledger that adds up to the reported balance has no gap", () => {
    const rows = [
      topupRow({ at: "2026-10-20T10:05:00.000Z", amount: "+100.00" }),
      authorization({
        at: "2026-10-22T10:00:00.000Z",
        amount: "-30.00",
        description: "SHOP SPRINGFIELD USA",
      }),
    ];
    const r = reconcileOne(90, rows, [issue, order({ at: "2026-10-20T10:00:00.000Z", amount: 100 })]);
    expect(r).toMatchObject({
      reportedBalanceCents: 9000,
      ledgerBalanceCents: 9000,
      holdsCents: -3000,
      gapCents: 0,
      historyComplete: true,
      totalsByKind: { card_issue: 2000, topup: 10000, purchase: -3000 },
    });
    expect(r.findings).toEqual([]);
  });

  test("a reported balance the rows don't explain is a gap", () => {
    const r = reconcileOne(520, [], [issue]);
    expect(r.findings).toEqual([expect.objectContaining({ kind: "balance-gap", cents: 50000 })]);
  });

  test("without an issue order the gap isn't meaningful", () => {
    const r = reconcileOne(61.25, [], []);
    expect(kinds(r.findings)).toEqual(["history-incomplete"]);
  });
});

test("a top-up paid but only partly credited is a shortfall", () => {
  const partial = order({
    at: "2026-07-03T12:00:00.000Z",
    amount: 400,
    credited: "0.01",
    status: "credited_partially",
  });
  const r = reconcileOne(20.01, [], [issue, partial]);
  expect(r.findings).toEqual([expect.objectContaining({ kind: "credit-shortfall", cents: -39999 })]);
});

test("an authorisation never posted after a week is stale", () => {
  const old = authorization({
    at: "2026-10-01T10:00:00.000Z",
    amount: "-12.00",
    description: "SHOP SPRINGFIELD USA",
  });
  const recent = authorization({
    at: "2026-10-24T10:00:00.000Z",
    amount: "-5.00",
    description: "CAFE SPRINGFIELD USA",
  });
  const r = reconcileOne(3, [old, recent], [issue]);
  expect(r.findings).toEqual([expect.objectContaining({ kind: "stale-authorization", cents: -1200 })]);
});

test("fees charged for postings as well as authorisations exceed the advertised fee", () => {
  const rows = [
    authorization({ at: "2026-10-01T10:00:00.000Z", amount: "-10.00", description: "SHOP SPRINGFIELD USA" }),
    posting({ at: "2026-10-01T20:00:00.000Z", amount: "-10.00", description: "SHOP" }),
    declined({ at: "2026-10-02T10:00:00.000Z", amount: "-99.00", description: "SHOP SPRINGFIELD USA" }),
    fee({ at: "2026-10-01T12:00:00.000Z" }),
    fee({ at: "2026-10-01T22:00:00.000Z" }),
    fee({ at: "2026-10-02T12:00:00.000Z" }),
  ];
  const r = reconcileOne(8.5, rows, [issue]);
  expect(r.fees).toEqual({
    since: "2026-10-01T12:00:00.000Z",
    chargedCount: 3,
    chargedCents: -150,
    authorizationCount: 2,
    postingCount: 1,
    advertisedCents: 100,
  });
  expect(r.findings).toEqual([expect.objectContaining({ kind: "fees-above-advertised", cents: -50 })]);
  expect(r.costs.transactionFeesCents).toBe(150);
});

test("top-up fees above the advertised rate are flagged, and costs add up", () => {
  const topups = [
    order({ at: "2026-10-01T10:00:00.000Z", amount: 250, invoiceAmount: "266.25" }),
    order({ at: "2026-10-10T10:00:00.000Z", amount: 250, invoiceAmount: "266.25" }),
  ];
  const r = reconcileOne(520, [], [issue, ...topups]);
  expect(r.findings).toEqual([expect.objectContaining({ kind: "topup-fee-above-advertised", cents: -250 })]);
  expect(r.costs).toEqual({
    cardCents: 3000,
    topupFeesCents: 3250,
    transactionFeesCents: 0,
    totalCents: 6250,
  });
});
