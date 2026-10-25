import type { RawCard, RawCardDetails } from "../raw/schemas.ts";
import { dollarsToCents } from "./money.ts";

export interface ProductTerms {
  /** Credited to a new card, in dollars. */
  startingDeposit: number | undefined;
  /** The rate actually configured, e.g. 0.065. */
  topupFeeRate: number | undefined;
  /** The rate the product description advertises, e.g. 0.06 for "Top-up fee: 6%". */
  advertisedTopupFeeRate: number | undefined;
  /** "Per transaction authorization (success, reversal, or decline): $0.50" → 50. */
  advertisedAuthorizationFeeCents: number | undefined;
}

/** Pricing from a card's product: metadata, plus the rates its description advertises. */
export function productTerms(card: RawCard | RawCardDetails): ProductTerms {
  const product = card.cardProduct as {
    metadata?: Record<string, unknown>;
    description?: unknown;
    cardDescription?: unknown;
  };
  const meta = product.metadata ?? {};
  const text = [product.description, product.cardDescription].filter((t) => typeof t === "string").join("\n");
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const advertisedTopup = /top-up fee:\s*([\d.]+)\s*%/i.exec(text)?.[1];
  const advertisedAuth = /authori[sz]ation[^$\n]*\$\s*([\d.]+)/i.exec(text)?.[1];
  return {
    startingDeposit: num(meta.starting_deposit),
    topupFeeRate: num(meta.topup_fee),
    advertisedTopupFeeRate: advertisedTopup ? Number(advertisedTopup) / 100 : undefined,
    advertisedAuthorizationFeeCents: advertisedAuth ? dollarsToCents(Number(advertisedAuth)) : undefined,
  };
}
