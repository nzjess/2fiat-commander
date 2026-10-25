// Invariants checked against the latest real capture in captures/ (gitignored). Skipped when there is none.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalize, parseCents, RawCardDetails, RawOrder, RawTransaction, reconcile } from "../src/index.ts";

const root = join(import.meta.dirname, "../../../captures");
const latest = existsSync(root) ? readdirSync(root).sort().at(-1) : undefined;
const load = (name: string): unknown => JSON.parse(readFileSync(join(root, latest ?? "", name), "utf8"));

describe.skipIf(!latest)(`real capture ${latest ?? ""}`, () => {
  const transactions = latest ? RawTransaction.array().parse(load("transactions.json")) : [];
  const orders = latest ? RawOrder.array().parse(load("orders.json")) : [];
  const cards = latest ? RawCardDetails.array().parse(load("card-details.json")) : [];
  const activities = normalize({ transactions, orders, cards });

  test("every transaction is in exactly one activity, and keys are unique", () => {
    const seen = activities.flatMap((a) => a.sources.transactionIds);
    expect(seen.length).toBe(transactions.length);
    expect(new Set(seen).size).toBe(transactions.length);
    expect(new Set(activities.map((a) => a.key)).size).toBe(activities.length);
  });

  test("no unknown rows, and every transfer has both sides", () => {
    expect(activities.filter((a) => a.flags.includes("unknown-row"))).toEqual([]);
    expect(activities.filter((a) => a.flags.includes("unmatched-transfer"))).toEqual([]);
    const outs = activities.filter((a) => a.kind === "transfer_out").map((a) => a.transferId);
    const ins = activities.filter((a) => a.kind === "transfer_in").map((a) => a.transferId);
    expect(ins.sort()).toEqual(outs.sort());
  });

  test("order-funded top-ups add up to what the order credited", () => {
    const byId = new Map(transactions.map((t) => [t.id, t]));
    for (const a of activities.filter(
      (a) => a.kind === "topup" && a.orderId && a.sources.transactionIds.length > 0,
    )) {
      if (a.flags.includes("credit-incomplete")) continue;
      const sum = a.sources.transactionIds.reduce((s, id) => s + parseCents(byId.get(id)?.amount ?? "0"), 0);
      expect(sum, a.key).toBe(a.amountCents);
    }
  });

  test("almost every authorisation older than a week has been posted, voided or declined", () => {
    const weekAgo = new Date(Date.parse(latest?.slice(0, 10) ?? "") - 7 * 86_400_000).toISOString();
    const old = activities.filter(
      (a) => (a.kind === "purchase" || a.kind === "refund") && a.occurredAt < weekAgo,
    );
    const stale = old.filter((a) => a.status === "pending");
    expect(stale.length / old.length).toBeLessThan(0.01);
  });

  test("reconciliation covers every card and finds the known top-up fee discrepancy", () => {
    const results = reconcile({ cards, transactions, activities, asOf: latest?.slice(0, 10) });
    expect(results.map((r) => r.cardId).sort()).toEqual(cards.map((c) => c.id).sort());
    for (const r of results) expect(r.findings.map((f) => f.kind)).toContain("topup-fee-above-advertised");
  });
});
