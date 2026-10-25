// Normalises the latest capture and prints diagnostics: counts, flags, unpaired authorisations and per-card
// balance reconciliation. Usage: pnpm report
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Activity,
  normalize,
  RawCardDetails,
  RawOrder,
  RawTransaction,
  reconcile,
} from "../src/index.ts";

const root = join(import.meta.dirname, "../../../captures");
const latest = (await readdir(root)).sort().at(-1);
if (!latest) throw new Error("no captures; run pnpm capture");
const load = async (name: string) => JSON.parse(await readFile(join(root, latest, name), "utf8"));
const cards = RawCardDetails.array().parse(await load("card-details.json"));
const transactions = RawTransaction.array().parse(await load("transactions.json"));
const orders = RawOrder.array().parse(await load("orders.json"));

const activities = normalize({ transactions, orders, cards });
const alias = new Map(cards.map((c) => [c.id, c.alias]));
const $ = (cents: number) => (cents / 100).toFixed(2);
const tally = (f: (a: Activity) => string | string[]) => {
  const m: Record<string, number> = {};
  for (const a of activities) for (const k of [f(a)].flat()) m[k] = (m[k] ?? 0) + 1;
  return m;
};

console.log(
  `capture ${latest}: ${transactions.length} transactions, ${orders.length} orders -> ${activities.length} activities`,
);
console.log(
  "kind/status:",
  tally((a) => `${a.kind}/${a.status}`),
);
console.log(
  "flags:",
  tally((a) => a.flags),
);

const seen = new Map<string, number>();
for (const a of activities) for (const id of a.sources.transactionIds) seen.set(id, (seen.get(id) ?? 0) + 1);
const missing = transactions.filter((t) => !seen.has(t.id)).length;
const multi = [...seen.values()].filter((n) => n > 1).length;
console.log(`transactions in no activity: ${missing}, in several: ${multi}`);

const isPayment = (a: Activity) => a.kind === "purchase" || a.kind === "refund";
const postedOnly = activities.filter(
  (a) => isPayment(a) && a.status === "settled" && a.authorizedAmountCents === undefined,
);
const notPosted = activities.filter((a) => isPayment(a) && a.status === "pending");
const voided = activities.filter((a) => a.status === "voided");
console.log(
  `posted with no authorisation: ${postedOnly.length}; authorised, not yet posted: ${notPosted.length}; voided: ${voided.length}`,
);
const show = (a: Activity) =>
  `  ${alias.get(a.cardId)} ${a.occurredAt.slice(0, 16)} ${a.kind}/${a.status} ${$(a.amountCents)} ${a.description}${a.flags.length ? ` [${a.flags.join(",")}]` : ""}`;
if (process.argv.includes("-v")) {
  console.log(`posted with no authorisation:\n${postedOnly.map(show).join("\n")}`);
  console.log(`authorised, not yet posted:\n${notPosted.map(show).join("\n")}`);
  console.log(`voided:\n${voided.map(show).join("\n")}`);
  console.log(
    "partial reversals:\n" +
      activities
        .filter((a) => a.flags.includes("partial-reversal"))
        .map(show)
        .join("\n"),
  );
}

const asOf = latest.slice(0, 10);
for (const r of reconcile({ cards, transactions, activities, asOf })) {
  console.log(
    `\n${alias.get(r.cardId)}: reported ${$(r.reportedBalanceCents)}, ledger ${$(r.ledgerBalanceCents)} (holds ${$(r.holdsCents)}), gap ${$(r.gapCents)}`,
  );
  console.log(
    `  costs: card ${$(r.costs.cardCents)}, top-up fees ${$(r.costs.topupFeesCents)}, transaction fees ${$(r.costs.transactionFeesCents)}, total ${$(r.costs.totalCents)}`,
  );
  if (r.fees)
    console.log(
      `  fees since ${r.fees.since.slice(0, 10)}: ${r.fees.chargedCount} charged; ${r.fees.authorizationCount} authorisations + ${r.fees.postingCount} postings`,
    );
  for (const f of r.findings)
    console.log(`  - ${f.kind}${f.cents === undefined ? "" : ` (${$(f.cents)})`}: ${f.message}`);
}
