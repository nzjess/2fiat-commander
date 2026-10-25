import type {
  ActivityFlag,
  ActivityKind,
  ActivityStatus,
  FindingKind,
  RawCard,
  RawCardDetails,
  RawOrder,
  RawTransaction,
} from "@twofiat/client";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// Conventions: our own integer primary keys everywhere, 2fiat's ids in `twofiat_id` columns (unique per account).
// Times are ISO-8601 UTC text from `toISOString()` (raw rows' `created_at` too), so they sort and compare as
// strings. Money is integer cents. Accounts are hard boundaries: nothing references across two accounts.

const now = () => new Date().toISOString();
const createdAt = () =>
  text("created_at")
    .notNull()
    .$defaultFn(() => now());

export const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the cookie token, so a leaked database can't be replayed. */
    id: text().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/** One 2fiat secret token. */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text().notNull(),
    tokenEnc: text("token_enc").notNull(),
    /** HMAC of the token: encryption uses a random IV, so this is what detects a token added twice. */
    tokenHash: text("token_hash").notNull(),
    sidEnc: text("sid_enc"),
    sidExpiresAt: text("sid_expires_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("accounts_user_token").on(t.userId, t.tokenHash)],
);

/** What the user thinks of as "my card": one or more physical cards, e.g. a card and its replacement. */
export const logicalCards = sqliteTable(
  "logical_cards",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  // The target of cards' composite foreign key, which keeps a card and its logical card in the same account.
  (t) => [unique("logical_cards_id_account").on(t.id, t.accountId)],
);

/** A physical card: one 2fiat card. Balances, rows and reconciliation all live at this level. */
export const cards = sqliteTable(
  "cards",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    logicalCardId: integer("logical_card_id").notNull(),
    twofiatId: text("twofiat_id").notNull(),
    alias: text().notNull(),
    maskedNumber: text("masked_number").notNull(),
    currency: text().notNull(),
    product: text().notNull(),
    /** Only the card details endpoint reports these. */
    status: text(),
    issuedAt: text("issued_at"),
    expiresAt: text("expires_at"),
    raw: text({ mode: "json" }).$type<RawCard | RawCardDetails>().notNull(),
    firstSeenAt: text("first_seen_at")
      .notNull()
      .$defaultFn(() => now()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => now()),
  },
  (t) => [
    unique("cards_account_twofiat").on(t.accountId, t.twofiatId),
    foreignKey({
      columns: [t.logicalCardId, t.accountId],
      foreignColumns: [logicalCards.id, logicalCards.accountId],
    }),
    index("cards_logical_card").on(t.logicalCardId),
  ],
);

/** 2fiat's transaction rows, untouched apart from dropped PII. */
export const rawTransactions = sqliteTable(
  "raw_transactions",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    twofiatId: text("twofiat_id").notNull(),
    createdAt: text("created_at").notNull(),
    raw: text({ mode: "json" }).$type<RawTransaction>().notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [
    unique("raw_transactions_account_twofiat").on(t.accountId, t.twofiatId),
    index("raw_transactions_account_created").on(t.accountId, t.createdAt),
    index("raw_transactions_card_created").on(t.cardId, t.createdAt),
  ],
);

/** 2fiat's orders (top-ups and card issues), untouched apart from dropped PII. */
export const rawOrders = sqliteTable(
  "raw_orders",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    cardId: integer("card_id").references(() => cards.id, { onDelete: "cascade" }),
    twofiatId: text("twofiat_id").notNull(),
    createdAt: text("created_at").notNull(),
    raw: text({ mode: "json" }).$type<RawOrder>().notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [
    unique("raw_orders_account_twofiat").on(t.accountId, t.twofiatId),
    index("raw_orders_account_created").on(t.accountId, t.createdAt),
  ],
);

/** The normalised ledger. Ids are stable across re-normalisation: see `ledger.ts`. */
export const activities = sqliteTable(
  "activities",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    /** The normaliser's `<kind>:<anchor id>`. It can change when re-matching picks another anchor; the id doesn't. */
    key: text().notNull(),
    kind: text().$type<ActivityKind>().notNull(),
    status: text().$type<ActivityStatus>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    authorizedAmountCents: integer("authorized_amount_cents"),
    attemptedAmountCents: integer("attempted_amount_cents"),
    requestedAmountCents: integer("requested_amount_cents"),
    feeCents: integer("fee_cents"),
    currency: text().notNull(),
    occurredAt: text("occurred_at").notNull(),
    settledAt: text("settled_at"),
    description: text().notNull(),
    postedDescription: text("posted_description"),
    orderTwofiatId: text("order_twofiat_id"),
    transferId: text("transfer_id"),
    counterpartCardId: integer("counterpart_card_id").references(() => cards.id, { onDelete: "set null" }),
    flags: text({ mode: "json" }).$type<ActivityFlag[]>().notNull(),
    normalizerVersion: integer("normalizer_version").notNull(),
  },
  (t) => [
    unique("activities_account_key").on(t.accountId, t.key),
    index("activities_account_occurred").on(t.accountId, t.occurredAt),
    index("activities_card_occurred").on(t.cardId, t.occurredAt),
    index("activities_account_kind_occurred").on(t.accountId, t.kind, t.occurredAt),
  ],
);

/** Which raw rows make up each activity. Every raw row belongs to exactly one activity. */
export const activitySources = sqliteTable(
  "activity_sources",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    rawTransactionId: integer("raw_transaction_id")
      .unique()
      .references(() => rawTransactions.id, { onDelete: "cascade" }),
    rawOrderId: integer("raw_order_id")
      .unique()
      .references(() => rawOrders.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("activity_sources_activity").on(t.activityId),
    check("activity_sources_one_source", sql`(${t.rawTransactionId} IS NULL) <> (${t.rawOrderId} IS NULL)`),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    color: text(),
    createdAt: createdAt(),
  },
  (t) => [unique("categories_user_name").on(t.userId, t.name)],
);

/** The user's own fields on an activity. Kept apart from `activities`, so re-normalisation never touches them. */
export const activityAnnotations = sqliteTable(
  "activity_annotations",
  {
    activityId: integer("activity_id")
      .primaryKey()
      .references(() => activities.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    note: text(),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => now()),
  },
  (t) => [index("activity_annotations_category").on(t.categoryId)],
);

export const syncs = sqliteTable(
  "syncs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    trigger: text().$type<"manual" | "scheduled">().notNull(),
    startedAt: text("started_at")
      .notNull()
      .$defaultFn(() => now()),
    finishedAt: text("finished_at"),
    status: text().$type<"running" | "ok" | "failed">().notNull(),
    error: text(),
    rowsNew: integer("rows_new").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    /** The transaction window pulled from 2fiat (UTC days, inclusive). */
    windowFrom: text("window_from"),
    windowTo: text("window_to"),
    /** Where re-normalisation started from. */
    normalizedFrom: text("normalized_from"),
  },
  (t) => [index("syncs_account_started").on(t.accountId, t.startedAt)],
);

/** Each card's reported and ledger balance at every sync, for charting when a gap appeared. */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    syncId: integer("sync_id")
      .notNull()
      .references(() => syncs.id, { onDelete: "cascade" }),
    reportedCents: integer("reported_cents").notNull(),
    ledgerCents: integer("ledger_cents").notNull(),
    holdsCents: integer("holds_cents").notNull(),
    gapCents: integer("gap_cents").notNull(),
    takenAt: text("taken_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.syncId] })],
);

/** A card's balance before its first visible row, for cards whose history starts mid-life. */
export const openingBalances = sqliteTable("opening_balances", {
  cardId: integer("card_id")
    .primaryKey()
    .references(() => cards.id, { onDelete: "cascade" }),
  cents: integer().notNull(),
  source: text().$type<"inferred" | "entered">().notNull(),
  setAt: text("set_at")
    .notNull()
    .$defaultFn(() => now()),
  setBySyncId: integer("set_by_sync_id").references(() => syncs.id, { onDelete: "set null" }),
});

/** One row per finding identity, tracked across syncs: see `findings.ts`. */
export const findings = sqliteTable(
  "findings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    kind: text().$type<FindingKind>().notNull(),
    fingerprint: text().notNull(),
    /** As of the last sync that saw it. */
    cents: integer(),
    message: text().notNull(),
    activityIds: text("activity_ids", { mode: "json" }).$type<number[]>().notNull(),
    firstSeenSyncId: integer("first_seen_sync_id")
      .notNull()
      .references(() => syncs.id, { onDelete: "cascade" }),
    lastSeenSyncId: integer("last_seen_sync_id")
      .notNull()
      .references(() => syncs.id, { onDelete: "cascade" }),
    /** The first sync that no longer saw it; cleared if it comes back. */
    resolvedSyncId: integer("resolved_sync_id").references(() => syncs.id, { onDelete: "set null" }),
    explainedAt: text("explained_at"),
    explanation: text(),
  },
  (t) => [unique("findings_card_fingerprint").on(t.cardId, t.fingerprint)],
);
