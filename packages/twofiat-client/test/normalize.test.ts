import { describe, expect, test } from "vitest";
import {
  type Activity,
  type NormalizeInput,
  normalize,
  type RawOrder,
  type RawTransaction,
} from "../src/index.ts";
import {
  authorization,
  CARD_A,
  CARD_B,
  card,
  declined,
  fee,
  order,
  posting,
  refundRow,
  topupRow,
  withdraw,
} from "./fixtures.ts";

/** Normalises and checks the core invariant: every input row ends up in exactly one activity. */
function run(transactions: RawTransaction[], orders: RawOrder[] = []): Activity[] {
  const input: NormalizeInput = { transactions, orders };
  const activities = normalize(input);
  const seen = activities.flatMap((a) => a.sources.transactionIds).sort();
  expect(seen).toEqual(transactions.map((t) => t.id).sort());
  expect(new Set(activities.map((a) => a.key)).size).toBe(activities.length);
  return activities;
}

const only = (activities: Activity[]) => {
  expect(activities).toHaveLength(1);
  return activities[0] as Activity;
};

describe("card payments", () => {
  test("an authorisation and its later posting are one settled purchase", () => {
    const a = authorization({
      at: "2026-08-12T17:54:13.224Z",
      amount: "-42.50",
      description: "SP SOME SHOP SPRINGFIELD USA",
    });
    const p = posting({ at: "2026-08-13T09:10:09.138Z", amount: "-42.50", description: "SP SOME SHOP" });

    expect(only(run([p, a]))).toEqual({
      key: `purchase:${a.id}`,
      cardId: CARD_A,
      kind: "purchase",
      status: "settled",
      amountCents: -4250,
      authorizedAmountCents: -4250,
      currency: "USD",
      occurredAt: a.createdAt,
      settledAt: p.createdAt,
      description: "SP SOME SHOP SPRINGFIELD USA",
      postedDescription: "SP SOME SHOP",
      sources: { transactionIds: [a.id, p.id], orderIds: [] },
      flags: [],
    });
  });

  test("a posting may arrive before its authorisation", () => {
    const p = posting({
      at: "2026-07-02T01:46:53.000Z",
      amount: "-31.20",
      description: "VIDEOPLUS* VIDEOPLUS",
    });
    const a = authorization({
      at: "2026-07-02T03:46:53.000Z",
      amount: "-31.20",
      description: "VIDEOPLUS* VIDEOPLUS SPRINGFIELD USA",
    });
    const act = only(run([a, p]));
    expect(act).toMatchObject({ status: "settled", occurredAt: p.createdAt, settledAt: p.createdAt });
  });

  test("pairs when the two rows name the merchant differently", () => {
    const acts = run([
      authorization({
        at: "2026-05-06T14:06:53.000Z",
        amount: "-64.10",
        description: "BIGSTORE.CO.EX SPRINGFIELD USA",
      }),
      posting({ at: "2026-05-06T21:14:53.000Z", amount: "-64.10", description: "BIGSTORE* QX7R20LM4" }),
      authorization({
        at: "2026-05-20T10:51:53.000Z",
        amount: "-18.70",
        description: "RDA* PENDING.RIDEAPP.COM Springfield USA",
      }),
      posting({ at: "2026-05-20T23:16:53.000Z", amount: "-18.70", description: "RIDEAPP   *TRIP" }),
    ]);
    expect(acts.map((a) => [a.status, a.amountCents])).toEqual([
      ["settled", -6410],
      ["settled", -1870],
    ]);
  });

  test("the posted amount is final when it differs from the authorisation (a tip)", () => {
    const act = only(
      run([
        authorization({
          at: "2026-06-09T07:21:53.000Z",
          amount: "-120.00",
          description: "TST*CORNER BISTRO Shelbyville USA",
        }),
        posting({ at: "2026-06-09T20:18:53.000Z", amount: "-140.00", description: "TST*CORNER BISTRO" }),
      ]),
    );
    expect(act).toMatchObject({
      amountCents: -14000,
      authorizedAmountCents: -12000,
      flags: ["amount-changed"],
    });
  });

  test("repeat purchases of the same amount pair by nearest time", () => {
    const a1 = authorization({
      at: "2026-08-21T11:49:53.000Z",
      amount: "-15.25",
      description: "FITCLUB* ADDITIONAL SPRINGFIELD USA",
    });
    const a2 = authorization({
      at: "2026-08-23T17:16:53.000Z",
      amount: "-15.25",
      description: "FITCLUB* ADDITIONAL SPRINGFIELD USA",
    });
    const p1 = posting({
      at: "2026-08-21T20:44:53.000Z",
      amount: "-15.25",
      description: "FITCLUB* ADDITIONAL_",
    });
    const p2 = posting({
      at: "2026-08-24T03:48:53.000Z",
      amount: "-15.25",
      description: "FITCLUB* ADDITIONAL_",
    });
    const acts = run([a1, a2, p1, p2]);
    expect(acts.map((a) => a.sources.transactionIds)).toEqual([
      [a1.id, p1.id],
      [a2.id, p2.id],
    ]);
  });

  test("an authorisation without a posting yet is pending", () => {
    const act = only(
      run([
        authorization({
          at: "2026-08-25T07:37:53.000Z",
          amount: "-55.40",
          description: "GROCER STORES SPRINGFIELD USA",
        }),
      ]),
    );
    expect(act).toMatchObject({
      kind: "purchase",
      status: "pending",
      amountCents: -5540,
      authorizedAmountCents: -5540,
    });
    expect(act.settledAt).toBeUndefined();
  });

  test("a positive posting without an authorisation is a settled refund", () => {
    const act = only(
      run([posting({ at: "2026-07-09T21:31:53.000Z", amount: "+9.30", description: "Rail Tickets" })]),
    );
    expect(act).toMatchObject({ kind: "refund", status: "settled", amountCents: 930 });
  });

  test("a hold reversed in full is voided", () => {
    const hold = authorization({
      at: "2026-06-09T04:23:53.000Z",
      amount: "-21.60",
      description: "ROBOCAB SHELBYVILLE USA",
    });
    const release = authorization({
      at: "2026-06-09T04:24:53.000Z",
      amount: "+21.60",
      description: "ROBOCAB SHELBYVILLE USA",
    });
    expect(only(run([hold, release]))).toMatchObject({
      kind: "purchase",
      status: "voided",
      amountCents: 0,
      authorizedAmountCents: -2160,
      sources: { transactionIds: [hold.id, release.id] },
    });
  });

  test("a partial release is folded into the purchase whose posting nets it", () => {
    const hold = authorization({
      at: "2026-06-01T23:02:53.000Z",
      amount: "-400.19",
      description: "The Grand Hotel Springfield USA",
    });
    const release = authorization({
      at: "2026-06-02T11:54:53.000Z",
      amount: "+75.00",
      description: "The Grand Hotel Springfield USA",
    });
    const p = posting({
      at: "2026-06-02T07:18:53.000Z",
      amount: "-325.20",
      description: "The Grand Hotel",
    });
    expect(only(run([hold, release, p]))).toMatchObject({
      status: "settled",
      amountCents: -32520,
      authorizedAmountCents: -40019,
      flags: ["amount-changed", "partial-reversal"],
    });
  });

  test("a second identical posting a moment later is a double notification", () => {
    const a = authorization({
      at: "2026-08-13T02:46:53.000Z",
      amount: "-6.35",
      description: "Burger Place Main St Springfield USA",
    });
    const p1 = posting({
      at: "2026-08-13T09:15:16.100Z",
      amount: "-6.35",
      description: "Burger Place Main St",
    });
    const p2 = posting({
      at: "2026-08-13T09:15:16.486Z",
      amount: "-6.35",
      description: "Burger Place Main St",
    });
    const act = only(run([a, p1, p2]));
    expect(act.flags).toEqual(["duplicate-posting"]);
    expect(act.sources.transactionIds).toHaveLength(3);
    expect(act.amountCents).toBe(-635);
  });

  test("identical postings with an authorisation each are two real charges", () => {
    const acts = run([
      authorization({
        at: "2026-08-21T11:49:53.000Z",
        amount: "-15.25",
        description: "FITCLUB* ADDITIONAL SPRINGFIELD USA",
      }),
      authorization({
        at: "2026-08-21T11:50:30.000Z",
        amount: "-15.25",
        description: "FITCLUB* ADDITIONAL SPRINGFIELD USA",
      }),
      posting({ at: "2026-08-21T20:45:34.000Z", amount: "-15.25", description: "FITCLUB* ADDITIONAL_" }),
      posting({ at: "2026-08-21T20:45:34.396Z", amount: "-15.25", description: "FITCLUB* ADDITIONAL_" }),
    ]);
    expect(acts.map((a) => [a.status, a.amountCents, a.flags])).toEqual([
      ["settled", -1525, []],
      ["settled", -1525, []],
    ]);
  });

  test("unrelated rows with the same amount don't pair", () => {
    const acts = run([
      authorization({
        at: "2026-08-01T04:46:53.000Z",
        amount: "-20.00",
        description: "FUELSTOP SPRINGFIELD USA",
      }),
      posting({ at: "2026-08-01T14:46:53.000Z", amount: "-20.00", description: "CAFE CORNER" }),
    ]);
    expect(acts.map((a) => a.status).sort()).toEqual(["pending", "settled"]);
  });

  test("declines and $0 verifications move no money", () => {
    const acts = run([
      declined({
        at: "2026-08-03T15:19:52.767Z",
        amount: "-80.75",
        description: "ACME WIDGETS LTD SPRINGFIELD USA",
      }),
      declined({
        at: "2026-08-03T15:19:55.435Z",
        amount: "-80.75",
        description: "ACME WIDGETS LTD SPRINGFIELD USA",
      }),
      authorization({
        at: "2026-06-28T04:02:15.163Z",
        amount: "0.00",
        description: "PAYMENT CHECK SPRINGFIELD USA",
      }),
    ]);
    expect(acts.map((a) => [a.kind, a.status, a.amountCents, a.attemptedAmountCents])).toEqual([
      ["verification", "settled", 0, undefined],
      ["declined", "failed", 0, -8075],
      ["declined", "failed", 0, -8075],
    ]);
  });
});

describe("fees", () => {
  test("each fee row is its own activity, linked to nothing", () => {
    const acts = run([fee({ at: "2026-07-17T04:46:55.000Z" }), fee({ at: "2026-07-17T04:46:55.000Z" })]);
    expect(acts.map((a) => [a.kind, a.status, a.amountCents])).toEqual([
      ["fee", "settled", -50],
      ["fee", "settled", -50],
    ]);
  });
});

describe("transfers", () => {
  test("a withdraw and the other card's top-up a second later are one transfer", () => {
    const w = withdraw({ card: CARD_A, at: "2026-08-23T01:44:11.000Z", amount: "200" });
    const t = topupRow({ card: CARD_B, at: "2026-08-23T01:44:12.000Z", amount: "+200.00" });
    const [out, inn] = run([t, w]);
    expect(out).toMatchObject({
      kind: "transfer_out",
      cardId: CARD_A,
      amountCents: -20000,
      transferId: w.id,
      counterpartCardId: CARD_B,
    });
    expect(inn).toMatchObject({
      kind: "transfer_in",
      cardId: CARD_B,
      amountCents: 20000,
      transferId: w.id,
      counterpartCardId: CARD_A,
    });
  });

  test("a withdraw without its other side is flagged", () => {
    const act = only(run([withdraw({ at: "2026-08-23T01:44:11.000Z", amount: "200" })]));
    expect(act).toMatchObject({ kind: "transfer_out", amountCents: -20000, flags: ["unmatched-transfer"] });
  });
});

describe("orders", () => {
  test("an order and its top-up row are one top-up", () => {
    const o = order({ at: "2026-08-23T01:45:12.557Z", updatedAt: "2026-08-23T01:51:01.224Z", amount: 250 });
    const t = topupRow({ at: "2026-08-23T01:51:02.000Z", amount: "+250.00" });
    expect(only(run([t], [o]))).toMatchObject({
      key: `topup:${o.id}`,
      kind: "topup",
      status: "settled",
      amountCents: 25000,
      requestedAmountCents: 25000,
      occurredAt: o.createdAt,
      settledAt: t.createdAt,
      orderId: o.id,
      sources: { transactionIds: [t.id], orderIds: [o.id] },
      flags: [],
    });
  });

  test("a split credit claims both rows", () => {
    const o = order({ at: "2026-08-19T00:48:24.302Z", amount: 250 });
    const small = topupRow({ at: "2026-08-19T00:51:54.000Z", amount: "+10.00" });
    const rest = topupRow({ at: "2026-08-19T02:45:53.000Z", amount: "+240.00" });
    expect(only(run([rest, small], [o]))).toMatchObject({
      amountCents: 25000,
      status: "settled",
      settledAt: rest.createdAt,
      sources: { transactionIds: [small.id, rest.id] },
      flags: ["split-credit"],
    });
  });

  test("a split credit whose remainder hasn't arrived is pending", () => {
    const o = order({ at: "2026-08-19T00:48:24.302Z", amount: 250 });
    const small = topupRow({ at: "2026-08-19T00:51:54.000Z", amount: "+10.00" });
    expect(only(run([small], [o]))).toMatchObject({
      amountCents: 25000,
      status: "pending",
      flags: ["credit-incomplete"],
    });
  });

  test("a transfer-in isn't mistaken for an order's credit", () => {
    const o = order({ card: CARD_B, at: "2026-08-23T01:41:53.000Z", amount: 200 });
    const w = withdraw({ card: CARD_A, at: "2026-08-23T01:44:11.000Z", amount: "200" });
    const t = topupRow({ card: CARD_B, at: "2026-08-23T01:44:12.000Z", amount: "+200.00" });
    const acts = run([w, t], [o]);
    expect(acts.map((a) => [a.kind, a.flags])).toEqual([
      ["topup", ["order-only"]],
      ["transfer_out", []],
      ["transfer_in", []],
    ]);
  });

  test("orders from before top-up rows existed stand alone", () => {
    const o = order({ at: "2026-06-18T20:19:35.526Z", updatedAt: "2026-06-18T20:26:53.000Z", amount: 250 });
    expect(only(run([], [o]))).toMatchObject({
      amountCents: 25000,
      settledAt: o.updatedAt,
      flags: ["order-only"],
    });
  });

  test("a partly credited order counts what was credited", () => {
    const o = order({
      at: "2026-07-04T14:19:43.712Z",
      amount: 400,
      credited: "0.01",
      status: "credited_partially",
    });
    expect(only(run([], [o]))).toMatchObject({
      amountCents: 1,
      requestedAmountCents: 40000,
      flags: ["partial-credit", "order-only"],
    });
  });

  test("a card issue credits the product's starting balance; the rest of its price is a fee", () => {
    const acts = normalize({
      transactions: [],
      orders: [
        order({
          at: "2026-06-18T20:04:40.664Z",
          amount: 50,
          credited: "0",
          orderType: "issue",
          status: "paid_fully",
        }),
        order({ at: "2026-07-01T18:46:53.000Z", amount: 250, credited: null, status: "expired" }),
      ],
      cards: [card({ balance: 20 })],
    });
    expect(only(acts)).toMatchObject({ kind: "card_issue", amountCents: 2000, feeCents: 3000 });
  });

  test("a top-up's fee is what the invoice charged on top of the requested amount", () => {
    const o = order({ at: "2026-08-23T01:45:12.557Z", amount: 250, invoiceAmount: "266.25" });
    expect(only(run([], [o]))).toMatchObject({ amountCents: 25000, feeCents: 1625 });
  });
});

describe("refunds credited by 2fiat", () => {
  test("a merchant posting, a Refund row and its credit are one refund", () => {
    const p = posting({
      at: "2026-08-19T23:26:53.000Z",
      amount: "+11.20",
      description: "ONLINESHOP.EXAMPLE",
    });
    const r = refundRow({ at: "2026-08-20T11:37:27.000Z", amount: "11.20" });
    const credit = topupRow({ at: "2026-08-21T02:29:53.000Z", amount: "+11.20" });
    expect(only(run([credit, r, p]))).toMatchObject({
      kind: "refund",
      status: "settled",
      amountCents: 1120,
      description: "ONLINESHOP.EXAMPLE",
      settledAt: credit.createdAt,
      sources: { transactionIds: [p.id, r.id, credit.id] },
    });
  });

  test("a top-up row explained by nothing is an unattributed credit", () => {
    const act = only(run([topupRow({ at: "2026-08-21T02:29:53.000Z", amount: "+3.00" })]));
    expect(act).toMatchObject({ kind: "topup", amountCents: 300, flags: ["unattributed-credit"] });
  });
});

test("unknown rows are kept as other", () => {
  const odd: RawTransaction = {
    ...fee({ at: "2026-07-31T18:46:53.000Z" }),
    type: "SOMETHING_NEW",
    kind: null,
  };
  expect(only(run([odd]))).toMatchObject({ kind: "other", amountCents: -50, flags: ["unknown-row"] });
});

test("output doesn't depend on input order", () => {
  const rows = [
    authorization({
      at: "2026-08-12T17:54:13.224Z",
      amount: "-42.50",
      description: "SP SOME SHOP SPRINGFIELD USA",
    }),
    posting({ at: "2026-08-13T09:10:09.138Z", amount: "-42.50", description: "SP SOME SHOP" }),
    fee({ at: "2026-08-12T18:46:55.000Z" }),
    withdraw({ at: "2026-08-23T01:44:11.000Z", amount: "200" }),
    topupRow({ card: CARD_B, at: "2026-08-23T01:44:12.000Z", amount: "+200.00" }),
    topupRow({ at: "2026-08-23T01:51:02.000Z", amount: "+250.00" }),
  ];
  const orders = [order({ at: "2026-08-23T01:45:12.557Z", amount: 250 })];
  expect(normalize({ transactions: [...rows].reverse(), orders })).toEqual(
    normalize({ transactions: rows, orders }),
  );
});
