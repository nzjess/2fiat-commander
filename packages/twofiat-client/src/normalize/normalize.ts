import type { RawCard, RawCardDetails, RawOrder, RawTransaction } from "../raw/schemas.ts";
import { dollarsToCents, parseCents } from "./money.ts";
import { productTerms } from "./terms.ts";
import { descriptionSimilarity } from "./text.ts";
import type { Activity, ActivityFlag, ActivityKind, ActivityStatus } from "./types.ts";

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

/** A transfer's top-up row lands about a second after its withdraw row. */
const TRANSFER_WINDOW = 10 * SECOND;
/** Order credits, including the remainder of a split credit, land within this long of the order. */
const ORDER_CREDIT_WINDOW = 3 * DAY;
/** A refund's credit row and the merchant's posting are within this long of the refund row. */
const REFUND_WINDOW = 3 * DAY;
/** Postings were seen from 21 h before to 77 h after their authorisation. */
const PAIR_POSTED_BEFORE = 2 * DAY;
const PAIR_POSTED_AFTER = 4 * DAY;
/** Tips, final fares and partial hold releases change the posted amount by up to this share. */
const PAIR_MAX_AMOUNT_CHANGE = 0.35;
const PAIR_MIN_SIMILARITY = 0.3;
const PAIR_MIN_SIMILARITY_AMOUNT_CHANGED = 0.5;
/** A hold's full or partial release follows its authorisation within this long. */
const REVERSAL_WINDOW = 3 * DAY;
/** Authorised minus released can differ from the posting by FX rounding: up to 0.1% of the authorised amount. */
const reversalTolerance = (authorizedCents: number) => Math.max(2, Math.abs(authorizedCents) / 1000);
/** Identical posting rows this close together are double notifications. */
const DUPLICATE_WINDOW = 2 * SECOND;

export interface NormalizeInput {
  /** Raw transactions for any set of the account's cards, typically a time slice. */
  transactions: RawTransaction[];
  /**
   * Raw orders created in the same slice. An order whose credit rows fall outside the slice comes out flagged
   * `order-only`, so slices should start at least LOOKBACK_DAYS before the newest rows.
   */
  orders: RawOrder[];
  /** The account's cards; their product terms give each card issue's starting balance. */
  cards?: (RawCard | RawCardDetails)[];
}

interface Row {
  raw: RawTransaction;
  ts: number;
  cents: number;
}

/**
 * Turns raw 2fiat rows into one activity ledger. Pure and deterministic: the same input always yields the same
 * activities with the same keys, and every input transaction ends up in exactly one activity.
 */
export function normalize(input: NormalizeInput): Activity[] {
  const rows: Row[] = input.transactions
    .map((raw) => ({ raw, ts: Date.parse(raw.createdAt), cents: parseCents(raw.amount) }))
    .sort((a, b) => a.ts - b.ts || a.raw.id.localeCompare(b.raw.id));
  const claimed = new Set<string>();
  const out: Activity[] = [];
  const unclaimed = (pred: (r: Row) => boolean) => rows.filter((r) => !claimed.has(r.raw.id) && pred(r));
  const claim = (...rs: Row[]) => {
    for (const r of rs) claimed.add(r.raw.id);
  };

  const isWithdraw = (r: Row) => r.raw.type === "TRANSACTION" && r.raw.description === "Withdraw card";
  const isTopupRow = (r: Row) => r.raw.type === "INTERNAL" && r.raw.kind === "topup";
  const isRefundRow = (r: Row) => r.raw.type === "TRANSACTION" && r.raw.op_type === 4;
  const isAuth = (r: Row) => r.raw.type === "AUTHORIZATION";

  // Fees: one activity each, deliberately not linked to the authorisation they were charged for.
  for (const r of unclaimed((r) => r.raw.type === "INTERNAL" && r.raw.kind === "fee")) {
    claim(r);
    out.push(fromRow(r, "fee", "settled", r.cents));
  }

  // Transfers: "Withdraw card" (unsigned amount) on the source card, "Top up card" on the destination ~1 s later.
  for (const w of unclaimed(isWithdraw)) {
    const amount = Math.abs(w.cents);
    const t = nearest(
      unclaimed((r) => isTopupRow(r) && r.raw.cardId !== w.raw.cardId && r.cents === amount),
      w.ts,
      (r) => r.ts - w.ts >= 0 && r.ts - w.ts <= TRANSFER_WINDOW,
    );
    claim(w);
    const outAct = fromRow(w, "transfer_out", "settled", -amount);
    outAct.transferId = w.raw.id;
    if (t) {
      claim(t);
      const inAct = fromRow(t, "transfer_in", "settled", amount);
      inAct.transferId = w.raw.id;
      inAct.counterpartCardId = w.raw.cardId;
      outAct.counterpartCardId = t.raw.cardId;
      out.push(outAct, inAct);
    } else {
      outAct.flags.push("unmatched-transfer");
      out.push(outAct);
    }
  }

  // Refunds credited by 2fiat: a "Refund" row, then a top-up row for the same amount, often after a positive
  // posting from the merchant. All three are one refund, described by the merchant's row when there is one.
  for (const f of unclaimed(isRefundRow)) {
    const amount = Math.abs(f.cents);
    const credit = nearest(
      unclaimed((r) => isTopupRow(r) && r.raw.cardId === f.raw.cardId && r.cents === amount),
      f.ts,
      (r) => r.ts >= f.ts && r.ts - f.ts <= REFUND_WINDOW,
    );
    const auth = nearest(
      unclaimed(
        (r) => isAuth(r) && r.raw.status === "PENDING" && r.raw.cardId === f.raw.cardId && r.cents === amount,
      ),
      f.ts,
      (r) => r.ts <= f.ts && f.ts - r.ts <= REFUND_WINDOW,
    );
    const parts = [auth, f, credit].filter((r): r is Row => r !== undefined);
    claim(...parts);
    const act = fromRow(parts[0] ?? f, "refund", "settled", amount);
    act.sources.transactionIds = parts.map((p) => p.raw.id);
    act.settledAt = (credit ?? f).raw.createdAt;
    out.push(act);
  }

  // Orders: card issues carry the starting balance; credited top-ups claim their card's credit rows.
  const startingDeposit = new Map(
    (input.cards ?? []).map((c) => [c.id, dollarsToCents(productTerms(c).startingDeposit ?? 0)]),
  );
  const orders = [...input.orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const o of orders) {
    if (!o.cardId) continue;
    if (o.orderType === "issue" && o.status === "paid_fully") {
      const starting = startingDeposit.get(o.cardId) ?? 0;
      const act = fromOrder(o, "card_issue", starting);
      act.feeCents = dollarsToCents(o.amount) - starting;
      out.push(act);
      continue;
    }
    const credited = o.credited_usd ? parseCents(o.credited_usd) : 0;
    if (o.orderType !== "topup" || credited <= 0) continue;

    const start = Date.parse(o.createdAt);
    const parts: Row[] = [];
    let sum = 0;
    for (const r of unclaimed(
      (r) =>
        isTopupRow(r) && r.raw.cardId === o.cardId && r.ts >= start && r.ts - start <= ORDER_CREDIT_WINDOW,
    )) {
      if (sum >= credited) break;
      if (sum + r.cents > credited) continue;
      parts.push(r);
      sum += r.cents;
    }
    claim(...parts);

    const act = fromOrder(o, "topup", credited);
    act.requestedAmountCents = dollarsToCents(o.amount);
    if (o.invoice) act.feeCents = parseCents(o.invoice.amount) - act.requestedAmountCents;
    act.sources.transactionIds = parts.map((p) => p.raw.id);
    if (o.status === "credited_partially") act.flags.push("partial-credit");
    if (parts.length === 0) {
      act.flags.push("order-only");
      act.settledAt = o.updatedAt;
    } else {
      act.settledAt = parts.at(-1)?.raw.createdAt;
      if (parts.length > 1) act.flags.push("split-credit");
      if (sum < credited) {
        act.flags.push("credit-incomplete");
        act.status = "pending";
      }
    }
    out.push(act);
  }

  for (const r of unclaimed(isTopupRow)) {
    claim(r);
    const act = fromRow(r, "topup", "settled", r.cents);
    act.flags.push("unattributed-credit");
    out.push(act);
  }

  // Authorisations.
  for (const r of unclaimed((r) => isAuth(r) && r.cents === 0)) {
    claim(r);
    out.push(fromRow(r, "verification", r.raw.status === "FAILED" ? "failed" : "settled", 0));
  }
  for (const r of unclaimed((r) => isAuth(r) && r.raw.status === "FAILED")) {
    claim(r);
    const act = fromRow(r, "declined", "failed", 0);
    act.attemptedAmountCents = r.cents;
    out.push(act);
  }
  const postings = unclaimed((r) => isAuth(r) && r.raw.status === "PENDING");
  const authorizations = unclaimed((r) => isAuth(r) && r.raw.status === "COMPLETED");
  claim(...postings, ...authorizations);
  out.push(...cardPayments(authorizations, postings));

  for (const r of unclaimed(() => true)) {
    claim(r);
    const act = fromRow(r, "other", "settled", r.cents);
    act.flags.push("unknown-row");
    out.push(act);
  }

  return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.key.localeCompare(b.key));
}

/**
 * Card payments from authorisation rows (COMPLETED) and posting rows (PENDING):
 *  1. pair each authorisation with its posting, scored on amount, description and time, best score first;
 *  2. pair leftover authorisations with their full reversal (same amount, opposite sign) as voided;
 *  3. fold leftover partial releases into the purchase whose posting nets them;
 *  4. what's left is authorised-not-posted (pending) or posted-without-authorisation (settled).
 */
function cardPayments(authorizations: Row[], postings: Row[]): Activity[] {
  const used = new Set<string>();
  const out: Activity[] = [];

  const candidates: { a: Row; p: Row; score: number }[] = [];
  for (const p of postings) {
    for (const a of authorizations) {
      if (p.raw.cardId !== a.raw.cardId || Math.sign(p.cents) !== Math.sign(a.cents)) continue;
      const dt = p.ts - a.ts;
      if (dt < -PAIR_POSTED_BEFORE || dt > PAIR_POSTED_AFTER) continue;
      const change = Math.abs(p.cents - a.cents) / Math.max(Math.abs(p.cents), Math.abs(a.cents));
      if (change > PAIR_MAX_AMOUNT_CHANGE) continue;
      const sim = descriptionSimilarity(p.raw.description, a.raw.description);
      if (sim < (change === 0 ? PAIR_MIN_SIMILARITY : PAIR_MIN_SIMILARITY_AMOUNT_CHANGED)) continue;
      const closeness = 1 - Math.abs(dt) / PAIR_POSTED_AFTER;
      candidates.push({ a, p, score: (change === 0 ? 2 : 0.8) + sim + closeness * 0.5 });
    }
  }
  candidates.sort(
    (x, y) =>
      y.score - x.score || x.p.raw.id.localeCompare(y.p.raw.id) || x.a.raw.id.localeCompare(y.a.raw.id),
  );

  const byPosting = new Map<string, Activity>();
  const changed: { act: Activity; a: Row; p: Row }[] = [];
  for (const { a, p } of candidates) {
    if (used.has(p.raw.id) || used.has(a.raw.id)) continue;
    used.add(p.raw.id).add(a.raw.id);
    const act = fromRow(a.ts <= p.ts ? a : p, kindFor(p.cents), "settled", p.cents);
    act.sources.transactionIds = [a, p].sort((x, y) => x.ts - y.ts).map((r) => r.raw.id);
    act.description = a.raw.description;
    act.authorizedAmountCents = a.cents;
    act.settledAt = p.raw.createdAt;
    if (p.raw.description !== a.raw.description) act.postedDescription = p.raw.description;
    if (p.cents !== a.cents) {
      act.flags.push("amount-changed");
      changed.push({ act, a, p });
    }
    byPosting.set(p.raw.id, act);
    out.push(act);
  }

  const leftover = () => authorizations.filter((r) => !used.has(r.raw.id));
  for (const hold of leftover()) {
    if (used.has(hold.raw.id)) continue;
    const release = nearest(
      leftover().filter(
        (r) =>
          r !== hold &&
          r.raw.cardId === hold.raw.cardId &&
          r.cents === -hold.cents &&
          descriptionSimilarity(r.raw.description, hold.raw.description) >= PAIR_MIN_SIMILARITY,
      ),
      hold.ts,
      (r) => r.ts >= hold.ts && r.ts - hold.ts <= REVERSAL_WINDOW,
    );
    if (!release) continue;
    used.add(hold.raw.id).add(release.raw.id);
    const act = fromRow(hold, kindFor(hold.cents), "voided", 0);
    act.sources.transactionIds = [hold.raw.id, release.raw.id];
    act.authorizedAmountCents = hold.cents;
    act.settledAt = release.raw.createdAt;
    out.push(act);
  }

  for (const r of leftover().filter((r) => r.cents > 0)) {
    const into = changed.find(
      ({ act, a, p }) =>
        a.raw.cardId === r.raw.cardId &&
        r.ts >= a.ts &&
        r.ts - a.ts <= REVERSAL_WINDOW &&
        Math.abs(a.cents + r.cents - p.cents) <= reversalTolerance(a.cents) &&
        !act.flags.includes("partial-reversal") &&
        descriptionSimilarity(r.raw.description, a.raw.description) >= PAIR_MIN_SIMILARITY,
    );
    if (!into) continue;
    used.add(r.raw.id);
    into.act.sources.transactionIds.push(r.raw.id);
    into.act.flags.push("partial-reversal");
  }

  for (const a of leftover()) {
    const act = fromRow(a, kindFor(a.cents), "pending", a.cents);
    act.authorizedAmountCents = a.cents;
    out.push(act);
  }

  for (const p of postings.filter((r) => !used.has(r.raw.id))) {
    const twin = postings.find(
      (q) =>
        q !== p &&
        byPosting.has(q.raw.id) &&
        q.raw.cardId === p.raw.cardId &&
        q.cents === p.cents &&
        q.raw.description === p.raw.description &&
        Math.abs(q.ts - p.ts) <= DUPLICATE_WINDOW,
    );
    const into = twin && byPosting.get(twin.raw.id);
    if (into) {
      into.sources.transactionIds.push(p.raw.id);
      if (!into.flags.includes("duplicate-posting")) into.flags.push("duplicate-posting");
      continue;
    }
    const act = fromRow(p, kindFor(p.cents), "settled", p.cents);
    byPosting.set(p.raw.id, act);
    out.push(act);
  }
  return out;
}

const kindFor = (cents: number): ActivityKind => (cents < 0 ? "purchase" : "refund");

function fromRow(r: Row, kind: ActivityKind, status: ActivityStatus, amountCents: number): Activity {
  return {
    key: `${kind}:${r.raw.id}`,
    cardId: r.raw.cardId,
    kind,
    status,
    amountCents,
    currency: r.raw.currency,
    occurredAt: r.raw.createdAt,
    ...(status === "settled" ? { settledAt: r.raw.createdAt } : {}),
    description: r.raw.description,
    sources: { transactionIds: [r.raw.id], orderIds: [] },
    flags: [] as ActivityFlag[],
  };
}

function fromOrder(o: RawOrder, kind: ActivityKind, amountCents: number): Activity {
  return {
    key: `${kind}:${o.id}`,
    cardId: o.cardId ?? "",
    kind,
    status: "settled",
    amountCents,
    currency: o.currency,
    occurredAt: o.createdAt,
    settledAt: o.updatedAt,
    description: kind === "card_issue" ? "Card issued" : "Top-up",
    orderId: o.id,
    sources: { transactionIds: [], orderIds: [o.id] },
    flags: [],
  };
}

function nearest(rows: Row[], ts: number, within: (r: Row) => boolean): Row | undefined {
  let best: Row | undefined;
  for (const r of rows) if (within(r) && (!best || Math.abs(r.ts - ts) < Math.abs(best.ts - ts))) best = r;
  return best;
}
