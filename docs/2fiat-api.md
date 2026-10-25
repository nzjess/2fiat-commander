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

| Path | Returns |
| --- | --- |
| `user` | the account's user profile |
| `cards` | `Card[]`: id, alias, balance (number), cardNumber (masked), currency, expirationDate `MM/YY`, paymentType, cardProduct |
| `prepaid-cards/details/:cardId` | the card plus status (`"1"` = active), createdAt, expireDate (ISO), cardBal, userId, full cardProduct |
| `vccTransactions?skip&take&dateFrom&dateTo[&cardId]` | `{ data: Tx[], totalCount }`. Leave out `cardId` to get all cards |
| `orders?page=N` | `{ limit: 10, skip, totalCount, orders: Order[] }`, newest first |
| `auth/login-link`, `kyc/status`, `alerts/active`, `btc-currencies`, `livechat/chat-id`, `auth/logout` | not needed |

### `vccTransactions`

- `dateFrom` and `dateTo` are `YYYY-MM-DD` UTC days, both inclusive. Results are sorted by `createdAt` descending.
- `take` is capped at **500** (an account-wide query with more rows than that returned only 500), so the sync must page.
- Offset paging is not stable: paging all the rows gave one unique id too few, because new rows shift the offsets. The sync
  dedupes by `id` and should page within bounded date windows.
- Each row embeds the full `user` object (PII). Drop it before storing.

`Tx`: `id` (uuid), `cardId`, `createdAt` (ISO), `amount` (**string**), `currency`, `description`, `type`, `kind`,
`op_type`, `status`.

| type | kind | op_type | meaning |
| --- | --- | --- | --- |
| `AUTHORIZATION` | null | null | card purchase or refund. status `COMPLETED` / `PENDING` / `FAILED` |
| `INTERNAL` | `topup` | 3 | top-up credited to card, `"+250.00"`, description "Top up card" |
| `INTERNAL` | `fee` | 8 | `"-0.50"` per-authorization fee, description "Fee" |
| `TRANSACTION` | null | 8 | "Withdraw card": outgoing side of a transfer. Amount is **unsigned** (`"200"`) but money leaves the card |
| `TRANSACTION` | null | 4 | "Refund" (unsigned, seen once). A `+` "Top up card" row of the same amount followed ~15 h later |

Amount formats seen: `"+250.00"`, `"-0.50"`, `"200"`, `"-61.250000"`, `"0.00"`. Parse to integer cents.

### `orders`

`Order`: id, cardId, createdAt, `orderType` (`issue` = card purchase, `topup`), `status` (`paid_fully`,
`credited_fully`, `credited_partially`, `expired`), `amount` (number, requested USD), `credited_usd` (string, what
actually landed), `metadata.topup_fee` (0.065), and an embedded `card`, `user` and `invoice`.

`invoice`: `type` (`order` / `topUp`), `status` (`paid_fully`, `Settled`, `expired`), `amount` (USD string, gross of
fee), `paid` (number in the **payment currency**: BTC for older orders, ~USD for newer ones, with no currency field),
`additionalStatus` (`PaidOver`, `None`), `metadata.balance_before/after`, `checkoutLink`.

## Data quirks for normalisation

1. **Purchase pairs.** Each purchase shows up as two `AUTHORIZATION` rows with the same amount:
   - `COMPLETED`, with a long description (`"SP SOME SHOP SPRINGFIELD USA"`, i.e. merchant + city + country), and
   - `PENDING`, with a short description that is a **prefix** of the long one (`"SP SOME SHOP"`).
   The PENDING row came anywhere from −3 h to +20 h relative to the COMPLETED one (usually *after* it). 12 of 12 pairs in
   one card's history matched on amount + prefix + nearest time. A purchase may also have PENDING only, if it isn't
   settled yet.
2. **Exact duplicates.** Two refund rows (`PENDING`, `"+5.25"`, same short description) 0.3 s apart, with different ids.
3. **$0.00 verification auths**: `"PAYMENT CHECK SPRINGFIELD USA"`. No partner rows.
4. **Declines**: `FAILED` auths, sometimes retried seconds apart. They still incur fees.
5. **Fees** are $0.50 per authorization (success, reversal or decline, per the product description), posted in
   hourly batches (`HH:00:0x`). Store them as a distinct kind, **unlinked**: they're a reporting use case (fees paid
   over time), not something to attach to purchases.
6. **Transfers** are a pair: `TRANSACTION op 8 "Withdraw card"` (unsigned amount) on the source card and
   `INTERNAL topup "Top up card"` (`+amount`) on the destination card, **exactly 1 s later**. Every transfer in the account matched this way. A "Top up card" row is therefore either a transfer-in or an order-funded top-up.
7. **Top-ups exist in two sources**: an `orders` row (createdAt = when the invoice was created; `credited_usd` is the
   USD that landed) and an `INTERNAL topup` tx a few minutes after crediting. Top-up txs were introduced recently;
   older top-ups exist **only** as orders. The issue order's $20 starting balance has no tx row either.
8. **Split credits.** Occasionally an order is credited in parts: a small amount at top-up time and the remainder later.
   Seen twice, for example 250 = 10.00 + 240.00, with the remainder a couple of hours later, both with order status
   `credited_fully`. Match an order to its card's top-up rows (excluding transfer-ins) after `order.createdAt` until
   they sum to `credited_usd`. That accounted for every order-funded top-up row in the account.
9. **Refund credit.** A `TRANSACTION op 4 "Refund"` of 11.20 was followed ~15 h later by a "Top up card" `+11.20` on the
   same card. This was the only top-up row not explained by an order or a transfer. One sample, so treat the pairing as
   tentative.
