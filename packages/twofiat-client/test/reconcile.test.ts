import { describe, expect, test } from "vitest";
import {
  type Activity,
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

  test("without an issue order or opening balance the gap isn't meaningful", () => {
    const r = reconcileOne(61.25, [], []);
    expect(r).toMatchObject({ historyComplete: false, openingBalanceCents: undefined });
    expect(kinds(r.findings)).toEqual(["history-incomplete"]);
  });

  test("an inherited card reconciles from its opening balance", () => {
    const rows = [
      authorization({
        at: "2026-10-22T10:00:00.000Z",
        amount: "-30.00",
        description: "SHOP SPRINGFIELD USA",
      }),
    ];
    const cards = [card({ balance: 970 })];
    const activities = normalize({ transactions: rows, orders: [], cards });
    const asOf = "2026-10-25T00:00:00.000Z";

    const [balanced] = reconcile({
      cards,
      transactions: rows,
      activities,
      asOf,
      openingBalances: { [cards[0]?.id ?? ""]: 100000 },
    });
    expect(balanced).toMatchObject({
      openingBalanceCents: 100000,
      ledgerBalanceCents: 97000,
      gapCents: 0,
      findings: [],
    });

    const [drifted] = reconcile({
      cards,
      transactions: rows,
      activities,
      asOf,
      openingBalances: { [cards[0]?.id ?? ""]: 101000 },
    });
    expect(drifted?.findings).toEqual([expect.objectContaining({ kind: "balance-gap", cents: -1000 })]);
  });

  test("an opening balance is ignored for a card whose issue is known", () => {
    const cards = [card({ balance: 20 })];
    const activities = normalize({ transactions: [], orders: [issue], cards });
    const [r] = reconcile({
      cards,
      transactions: [],
      activities,
      openingBalances: { [cards[0]?.id ?? ""]: 5000 },
    });
    expect(r).toMatchObject({ openingBalanceCents: undefined, gapCents: 0 });
  });

  test("an adjustment counts in the ledger, and nowhere else", () => {
    // A top-up paid short, so 2fiat credited a cent, then support credited the rest by hand with no row.
    const shortTopup = order({ at: "2026-10-20T10:00:00.000Z", amount: 400, credited: "0.01" });
    const cards = [card({ balance: 420 })];
    const activities = normalize({ transactions: [], orders: [issue, shortTopup], cards });
    const credit: Activity = {
      key: "adjustment:1",
      cardId: cards[0]?.id ?? "",
      kind: "adjustment",
      status: "settled",
      amountCents: 39_999,
      currency: "USD",
      occurredAt: "2026-10-21T00:00:00.000Z",
      description: "Support credited the short top-up",
      sources: { transactionIds: [], orderIds: [] },
      flags: [],
    };
    const before = reconcile({ cards, transactions: [], activities });
    const [r] = reconcile({ cards, transactions: [], activities: [...activities, credit] });

    expect(r).toMatchObject({
      ledgerBalanceCents: 42_000,
      gapCents: 0,
      totalsByKind: { adjustment: 39_999 },
    });
    expect(r?.costs).toEqual(before[0]?.costs);
    // The order really was credited short: that stays a finding, for the user to explain.
    expect(kinds(r?.findings ?? [])).toEqual(["credit-shortfall"]);
    expect(kinds(before[0]?.findings ?? [])).toEqual(["balance-gap", "credit-shortfall"]);
  });

  test("an adjustment for an order makes up its credit", () => {
    const shortTopup = order({ at: "2026-10-20T10:00:00.000Z", amount: 400, credited: "0.01" });
    const cards = [card({ balance: 420 })];
    const activities = normalize({ transactions: [], orders: [issue, shortTopup], cards });
    const credit = (amountCents: number, orderId?: string): Activity => ({
      key: `adjustment:${amountCents}`,
      cardId: cards[0]?.id ?? "",
      kind: "adjustment",
      status: "settled",
      amountCents,
      currency: "USD",
      occurredAt: "2026-10-21T00:00:00.000Z",
      description: "Support credited the short top-up",
      orderId,
      sources: { transactionIds: [], orderIds: [] },
      flags: [],
    });
    const findingsWith = (...extra: Activity[]) =>
      reconcile({ cards, transactions: [], activities: [...activities, ...extra] })[0]?.findings ?? [];

    // Linked to the order, one adjustment settles both the gap and the shortfall.
    expect(findingsWith(credit(39_999, shortTopup.id))).toEqual([]);
    // Short of what was missing, the rest of the shortfall stays, and so does a gap for it.
    expect(findingsWith(credit(39_000, shortTopup.id))).toEqual([
      expect.objectContaining({ kind: "balance-gap", cents: 999 }),
      expect.objectContaining({
        kind: "credit-shortfall",
        cents: -999,
        message:
          "A top-up for $400.00 was paid but only $0.01 was credited, and $390.00 made up by adjustment.",
      }),
    ]);
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
