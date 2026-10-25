// Synthetic raw rows mirroring the shapes and quirks seen in real 2fiat data (see docs/2fiat-api.md).
import type { RawCardDetails, RawOrder, RawTransaction } from "../src/index.ts";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, "0")}`;

export const CARD_A = "card-a";
export const CARD_B = "card-b";

interface TxOpts {
  id?: string;
  card?: string;
  at: string;
  amount: string;
  description?: string;
}

const tx = (
  o: TxOpts & Pick<RawTransaction, "type" | "kind" | "op_type" | "status">,
  prefix: string,
): RawTransaction => ({
  id: o.id ?? nextId(prefix),
  cardId: o.card ?? CARD_A,
  createdAt: o.at,
  amount: o.amount,
  currency: "USD",
  description: o.description ?? "",
  type: o.type,
  kind: o.kind,
  op_type: o.op_type,
  status: o.status,
});

/** The approval at purchase time: 2fiat's COMPLETED authorisation, with city and country in the description. */
export const authorization = (o: TxOpts) =>
  tx({ ...o, type: "AUTHORIZATION", kind: null, op_type: null, status: "COMPLETED" }, "auth");

/** The later posting with the final amount: 2fiat's PENDING authorisation, usually a shorter description. */
export const posting = (o: TxOpts) =>
  tx({ ...o, type: "AUTHORIZATION", kind: null, op_type: null, status: "PENDING" }, "post");

export const declined = (o: TxOpts) =>
  tx({ ...o, type: "AUTHORIZATION", kind: null, op_type: null, status: "FAILED" }, "fail");

export const fee = (o: Omit<TxOpts, "amount" | "description">) =>
  tx(
    {
      ...o,
      amount: "-0.50",
      description: "Fee",
      type: "INTERNAL",
      kind: "fee",
      op_type: 8,
      status: "COMPLETED",
    },
    "fee",
  );

export const topupRow = (o: Omit<TxOpts, "description">) =>
  tx(
    { ...o, description: "Top up card", type: "INTERNAL", kind: "topup", op_type: 3, status: "COMPLETED" },
    "top",
  );

/** The outgoing side of a transfer. The amount is unsigned even though money leaves the card. */
export const withdraw = (o: Omit<TxOpts, "description">) =>
  tx(
    { ...o, description: "Withdraw card", type: "TRANSACTION", kind: null, op_type: 8, status: "COMPLETED" },
    "wd",
  );

export const refundRow = (o: Omit<TxOpts, "description">) =>
  tx({ ...o, description: "Refund", type: "TRANSACTION", kind: null, op_type: 4, status: "COMPLETED" }, "rf");

interface OrderOpts {
  id?: string;
  card?: string;
  at: string;
  updatedAt?: string;
  amount: number;
  credited?: string | null;
  status?: string;
  orderType?: string;
  invoiceAmount?: string;
}

export const order = (o: OrderOpts): RawOrder => ({
  id: o.id ?? nextId("ord"),
  cardId: o.card ?? CARD_A,
  createdAt: o.at,
  updatedAt: o.updatedAt ?? o.at,
  orderType: o.orderType ?? "topup",
  status: o.status ?? "credited_fully",
  amount: o.amount,
  credited_usd: o.credited === undefined ? String(o.amount) : o.credited,
  currency: "USD",
  invoice: o.invoiceAmount
    ? { id: `inv-${o.at}`, type: "topUp", status: "paid_fully", amount: o.invoiceAmount, paid: null }
    : null,
});

/** The Regular product's real terms text, which advertises a 6% top-up fee while charging 6.5%. */
export const REGULAR_TERMS = `## Mastercard Regular
Pricing:
* Card issuance fee: $50, includes
    * starting balance of $20
* Per transaction authorization (success, reversal, or decline): $0.50
* Top-up fee: 6%`;

export const card = (o: { id?: string; balance: number }): RawCardDetails => ({
  id: o.id ?? CARD_A,
  alias: "Test",
  balance: o.balance,
  cardNumber: "5257 **** **** 0000",
  currency: "USD",
  status: "1",
  createdAt: "2026-06-15T10:30:00.000Z",
  expireDate: "2029-06-01T00:00:00.000Z",
  cardProduct: {
    id: "p-regular",
    title: "Regular",
    description: REGULAR_TERMS,
    metadata: { starting_deposit: 20, topup_fee: 0.065 },
  },
});
