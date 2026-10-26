# 2fiat backend API (reverse engineered)

Captured 2026-10-25 from the logged-in web app (a Next.js app at https://2fiat.com). Merchant names below are
illustrative, not real captures.

Our app is **read-only**. The site's two user operations, **top-up** (paid in crypto; we only care about the USD
amount) and **transfer** (between the account's own cards), show up in the data but are never invoked by us.

## Auth

- An account's login link is `https://2fiat.com/wallet/<token>/<rest>`, where `<token>` matches `/^token1[a-z0-9]+$/i`
  (the `token1` prefix is part of the token).
- The login page's JS calls `POST /api/v1/auth/exchange` with JSON `{ "token": "<token>", "nextPath": "/wallet/my-cards" }`.
  It returns `200 {"ok":true,"redirectPath":"/wallet/my-cards"}` and sets `sid` (`HttpOnly; Secure; SameSite=Lax;
  Max-Age=1209600`, i.e. 14 days). Verified from Node 2026-10-25.
- Every other call authenticates with the `sid` cookie only (no `Authorization` header). Without it, the response is
  `401 {"error":"Unauthorized"}`. On a 401, re-run the exchange.
- Send a browser-like `user-agent`. A bare Node fetch had its connection dropped once.

## Endpoints (all `GET`, base `https://2fiat.com/api/v1/`)

| Path                                                                                                  | Returns                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `user`                                                                                                | the account's user profile                                                                                             |
| `cards`                                                                                               | `Card[]`: id, alias, balance (number), cardNumber (masked), currency, expirationDate `MM/YY`, paymentType, cardProduct |
| `prepaid-cards/details/:cardId`                                                                       | the card plus status (`"1"` = active), createdAt, expireDate (ISO), cardBal, userId, full cardProduct                  |
| `vccTransactions?skip&take&dateFrom&dateTo[&cardId]`                                                  | `{ data: Tx[], totalCount }`. Leave out `cardId` to get all cards                                                      |
| `orders?page=N`                                                                                       | `{ limit: 10, skip, totalCount, orders: Order[] }`, newest first                                                       |
| `auth/login-link`, `kyc/status`, `alerts/active`, `btc-currencies`, `livechat/chat-id`, `auth/logout` | not needed                                                                                                             |

### `vccTransactions`

- `dateFrom` and `dateTo` are `YYYY-MM-DD` UTC days, both inclusive. Results are sorted by `createdAt` descending.
- `take` is capped at **500** (an account-wide query with more rows than that returned only 500), so the sync must page.
- **Offset paging drops rows.** Rows that share a `createdAt` (fee batches often do) come back in a different order on
  every request, so consecutive pages can both repeat and skip rows. Two full pagings of the same account returned different numbers of unique rows. `TwoFiatClient.fetchTransactions` therefore never offset-pages a multi-day window: a window with
  `totalCount <= take` is one request, and a larger one is split in half by date. Only a single day with more than 500
  rows would be offset-paged, and then it's re-paged until all `totalCount` ids have been seen.
- Each row embeds the full `user` object (PII). Drop it before storing.

`Tx`: `id` (uuid), `cardId`, `createdAt` (ISO), `amount` (**string**), `currency`, `description`, `type`, `kind`,
`op_type`, `status`.

| type            | kind    | op_type | meaning                                                                                                  |
| --------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `AUTHORIZATION` | null    | null    | card purchase or refund. status `COMPLETED` / `PENDING` / `FAILED`                                       |
| `INTERNAL`      | `topup` | 3       | top-up credited to card, `"+250.00"`, description "Top up card"                                          |
| `INTERNAL`      | `fee`   | 8       | `"-0.50"` per-authorization fee, description "Fee"                                                       |
| `TRANSACTION`   | null    | 8       | "Withdraw card": outgoing side of a transfer. Amount is **unsigned** (`"200"`) but money leaves the card |
| `TRANSACTION`   | null    | 4       | "Refund" (unsigned, seen once). A `+` "Top up card" row of the same amount followed ~15 h later          |

Amount formats seen: `"+250.00"`, `"-0.50"`, `"200"`, `"-61.250000"`, `"0.00"`. Parse to integer cents.

### `orders`

`Order`: id, cardId, createdAt, `orderType` (`issue` = card purchase, `topup`), `status` (`paid_fully`,
`credited_fully`, `credited_partially`, `expired`), `amount` (number, requested USD), `credited_usd` (string, what
actually landed), `metadata.topup_fee` (0.065), and an embedded `card`, `user` and `invoice`.

`invoice`: `type` (`order` / `topUp`), `status` (`paid_fully`, `Settled`, `expired`), `amount` (USD string, gross of
fee), `paid` (number in the **payment currency**: BTC for older orders, ~USD for newer ones, with no currency field),
`additionalStatus` (`PaidOver`, `None`), `metadata.balance_before/after`, `checkoutLink`.

## Data quirks for normalisation

1. **Authorisation and posting.** 2fiat's statuses are misleading. Each card payment shows up as two
   `AUTHORIZATION` rows:
   - `COMPLETED`: the **authorisation** at purchase time. Its description is long (`"SP SOME SHOP SPRINGFIELD USA"`, i.e.
     merchant + city + country).
   - `PENDING`: the later **posting**, a median of ~12 h after (seen from −21 h to +77 h). Its description is shorter
     and often a prefix of the long one, but sometimes a different name for the same merchant
     (`"BIGSTORE* QX7R20LM4"` vs `"BIGSTORE.CO.EX SPRINGFIELD USA"`, `"RIDEAPP *TRIP"` vs `"RDA* PENDING.RIDEAPP.COM Springfield USA"`).
     The **posting carries the final amount**: tips added (up to ~25%), final fares (ride apps), holds netted (hotels). So the ledger takes the posted amount, and an authorisation that hasn't been posted yet is pending.
     Pairing is scored on amount (exact, or within 35% when names match well), word overlap and time. Every posting paired in the real capture.
2. **Holds and releases.** A hold reversed in full (an authorisation of `-X`, then `+X` from the same merchant shortly
   after) means the payment was voided. A partial release (`+75.00` after a `-400.19` hotel hold) is already netted in
   that purchase's posting (`-325.20`), so it is folded in, not counted again. Authorised minus released can differ
   from the posting by FX rounding (a few cents).
3. **Exact duplicates.** Identical posting rows <1 s apart with no authorisation of their own are double
   notifications (`"+5.25"` twice, 0.3 s apart). But identical postings that each have an authorisation are real
   repeat charges, so duplicates are only collapsed after pairing.
4. **$0.00 verification auths**: `"PAYMENT CHECK SPRINGFIELD USA"`. No partner rows.
5. **Declines**: `FAILED` auths, sometimes retried seconds apart. They still incur fees.
6. **Fees** are $0.50 each, posted in batches on even hours (`HH:00:0x`). The terms say per authorisation, but
   postings are charged too (see Fees and terms below). Store them as a distinct kind, **unlinked**: they're a reporting use case (fees paid
   over time), not something to attach to purchases.
7. **Transfers** are a pair: `TRANSACTION op 8 "Withdraw card"` (unsigned amount) on the source card and
   `INTERNAL topup "Top up card"` (`+amount`) on the destination card, **exactly 1 s later**. Every transfer in the account matched this way. A "Top up card" row is therefore either a transfer-in or an order-funded top-up.
8. **Top-ups exist in two sources**: an `orders` row (createdAt = when the invoice was created; `credited_usd` is the
   USD that landed) and an `INTERNAL topup` tx a few minutes after crediting. Top-up txs were introduced recently;
   older top-ups exist **only** as orders. The issue order's $20 starting balance has no tx row either.
9. **Split credits.** Occasionally an order is credited in parts: a small amount at top-up time and the remainder later.
   Seen twice, for example 250 = 10.00 + 240.00, with the remainder a couple of hours later, both with order status
   `credited_fully`. Match an order to its card's top-up rows (excluding transfer-ins) after `order.createdAt` until
   they sum to `credited_usd`. That accounted for every order-funded top-up row in the account.
10. **Refund credit.** A `TRANSACTION op 4 "Refund"` of 11.20 was followed ~15 h later by a "Top up card" `+11.20` on the
    same card. This was the only top-up row not explained by an order or a transfer. One sample, so treat the pairing as
    tentative.

## Fees and terms (for reconciliation)

The Regular product's description advertises: card $50 including a $20 starting balance,
"Per transaction authorization (success, reversal, or decline): $0.50", and "Top-up fee: 6%".
`cardProduct.metadata` has `starting_deposit: 20` and `topup_fee: 0.065`; the issue order itself carries no starting
balance. Observed in a real capture:

- **Fee rows start in mid-September 2026.** There are none before, on any card.
- **Postings are charged too.** Since then, fee rows ≈ authorisations + postings + declines (exactly on some cards, a few short on others). So a purchase costs $1.00 in fees, not the advertised $0.50.
- **Some fees are simply never charged.** The small shortfalls above aren't batches still to post: they were still missing weeks later. So fee rows can fall a few short of
  the events, in the card holder's favour. Fees post in batches on even hours, a median of ~1.3 h after the event.
- **Top-ups are charged 6.5%** (`invoice.amount = 1.065 × amount` on every order), against the 6% in the description.
  The site's product tiles say 6.5% for other products.
- **Balances don't reconcile exactly** from the card's issue onwards: most are a few dollars out, and one was out by nearly a whole order, next to an order credited only $0.01. `reconcile()` surfaces these as findings rather than explaining them away.
- **Inherited cards.** A card can be moved over from an earlier token: it keeps its balance but none of the history behind it (no issue order, and rows only from the move on). Such a card can only be reconciled from an opening balance, the
  balance just before its first visible row. `reconcile()` accepts one per card; inferring it as the gap at the first
  sync means later gaps measure drift from then on.
