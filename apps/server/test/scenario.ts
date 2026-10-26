import { authorization, CARD_A, CARD_B, fee, order, posting } from "@twofiat/client/fixtures";

/**
 * Card A has its whole history: issued with $20, then a $5 purchase and its fee, leaving $14.50.
 * Card B was inherited: $100 reported, with only a $20 purchase visible, so its opening balance must be $120.
 */
export function scenario() {
  const issue = order({
    card: CARD_A,
    at: "2026-08-19T01:30:00.000Z",
    amount: 50,
    orderType: "issue",
    status: "paid_fully",
  });
  const authA = authorization({
    card: CARD_A,
    at: "2026-10-10T08:00:00.000Z",
    amount: "-5.00",
    description: "SHOP SPRINGFIELD USA",
  });
  const feeA = fee({ card: CARD_A, at: "2026-10-10T08:00:01.000Z" });
  const postA = posting({
    card: CARD_A,
    at: "2026-10-10T22:00:00.000Z",
    amount: "-5.00",
    description: "SHOP",
  });
  const authB = authorization({
    card: CARD_B,
    at: "2026-10-12T08:00:00.000Z",
    amount: "-20.00",
    description: "CAFE SPRINGFIELD USA",
  });
  const postB = posting({
    card: CARD_B,
    at: "2026-10-12T20:00:00.000Z",
    amount: "-20.00",
    description: "CAFE",
  });
  return { issue, authA, feeA, postA, authB, postB };
}
