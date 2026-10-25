import { z } from "zod";

// Raw response schemas. They declare only the fields we rely on and keep every other field, so stored raw rows
// can be re-normalised later. Embedded copies of the user profile (PII) and of the card are dropped. Value sets
// such as `type` and `status` stay open strings here; the normaliser decides what unknown values mean.

const isoDateTime = z.iso.datetime({ offset: true });
// Seen: "+250.00", "-0.50", "200", "-71.350000", "0.00".
const decimalString = z.string().regex(/^[+-]?\d+(\.\d+)?$/);

export const RawCardProduct = z.looseObject({
  id: z.string(),
  title: z.string(),
});

export const RawCard = z.looseObject({
  id: z.string(),
  alias: z.string(),
  balance: z.number(),
  cardNumber: z.string(),
  currency: z.string(),
  expirationDate: z.string(),
  paymentType: z.string(),
  cardProduct: RawCardProduct,
});
export type RawCard = z.infer<typeof RawCard>;

export const RawCardDetails = z.looseObject({
  id: z.string(),
  alias: z.string(),
  balance: z.number(),
  cardNumber: z.string(),
  currency: z.string(),
  status: z.string(),
  createdAt: isoDateTime,
  expireDate: isoDateTime,
  cardProduct: RawCardProduct,
});
export type RawCardDetails = z.infer<typeof RawCardDetails>;

export const RawTransaction = z
  .looseObject({
    id: z.string(),
    cardId: z.string(),
    createdAt: isoDateTime,
    amount: decimalString,
    currency: z.string(),
    description: z.string(),
    type: z.string(),
    kind: z.string().nullable(),
    op_type: z.number().nullable(),
    status: z.string(),
    user: z.unknown().optional(),
  })
  .transform(({ user, ...rest }) => rest);
export type RawTransaction = z.infer<typeof RawTransaction>;

export const RawTransactionPage = z.object({
  data: z.array(RawTransaction),
  totalCount: z.number(),
});

export const RawInvoice = z.looseObject({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  amount: decimalString,
  // In the payment currency, which the response doesn't name. Kept for reference only.
  paid: z.number().nullable(),
});

export const RawOrder = z
  .looseObject({
    id: z.string(),
    cardId: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    orderType: z.string(),
    status: z.string(),
    amount: z.number(),
    credited_usd: decimalString.nullable(),
    currency: z.string(),
    invoice: RawInvoice.nullable(),
    user: z.unknown().optional(),
    card: z.unknown().optional(),
  })
  .transform(({ user, card, ...rest }) => rest);
export type RawOrder = z.infer<typeof RawOrder>;

export const RawOrderPage = z.object({
  limit: z.number(),
  skip: z.number(),
  totalCount: z.number(),
  orders: z.array(RawOrder),
});
