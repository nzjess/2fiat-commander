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
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
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
    /** Null once the account is archived. */
    tokenEnc: text("token_enc"),
    /** HMAC of the token: encryption uses a random IV, so this is what detects a token added twice. */
    tokenHash: text("token_hash").notNull(),
    sidEnc: text("sid_enc"),
    sidExpiresAt: text("sid_expires_at"),
    /**
     * Raw rows from this time onwards may not be normalised yet: every raw row either belongs to an activity or is
     * at or after it. Null when the ledger is up to date, "" when the whole ledger needs rebuilding.
     */
    ledgerDirtyFrom: text("ledger_dirty_from"),
    /** An archived account stays viewable but never syncs again, e.g. after 2fiat replaced its token. */
    archivedAt: text("archived_at"),
    replacedByAccountId: integer("replaced_by_account_id").references((): AnySQLiteColumn => accounts.id, {
      onDelete: "set null",
    }),
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

/**
 * A physical card: one 2fiat card. Balances, rows and reconciliation all live at this level. Exactly one card of
 * each logical card is its current card (the index allows at most one; the API keeps one).
 */
export const cards = sqliteTable(
  "cards",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    logicalCardId: integer("logical_card_id").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull(),
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
    uniqueIndex("cards_one_current").on(t.logicalCardId).where(sql`is_current = 1`),
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

/** One pull from 2fiat, and the normalisation and evaluation that follow it. */
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
    /** Where a failed sync stopped. Raw rows are kept when only normalisation or evaluation failed. */
    failedStage: text("failed_stage").$type<SyncStage>(),
    error: text(),
    /** When the raw rows were written. */
    ingestedAt: text("ingested_at"),
    rowsNew: integer("rows_new").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    /** Stored rows inside the fetched windows that 2fiat no longer returned. They're kept. */
    rowsMissing: integer("rows_missing").notNull().default(0),
    /** The transaction window pulled from 2fiat (UTC days, inclusive). */
    windowFrom: text("window_from"),
    windowTo: text("window_to"),
    /** Orders were fetched back to this time; null when all were fetched. */
    ordersFrom: text("orders_from"),
    /** Where re-normalisation started from, when it ran. */
    normalizedFrom: text("normalized_from"),
  },
  (t) => [
    index("syncs_account_started").on(t.accountId, t.startedAt),
    // One running sync per account, across processes too.
    uniqueIndex("syncs_one_running").on(t.accountId).where(sql`status = 'running'`),
  ],
);

export type SyncStage = "fetch" | "ingest" | "normalize" | "evaluate";

/** Each card's balance as 2fiat reported it at a sync: raw data, written with the raw rows. */
export const balanceObservations = sqliteTable(
  "balance_observations",
  {
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    syncId: integer("sync_id")
      .notNull()
      .references(() => syncs.id, { onDelete: "cascade" }),
    reportedCents: integer("reported_cents").notNull(),
    observedAt: text("observed_at").notNull(),
    /** The balance changed while the sync was fetching, so it may not match the rows fetched with it. */
    transient: integer({ mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.syncId] })],
);

/** One run of reconciliation over an account's ledger: after a sync, or on its own (e.g. an opening balance edit). */
export const evaluations = sqliteTable(
  "evaluations",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    syncId: integer("sync_id").references(() => syncs.id, { onDelete: "set null" }),
    /** "Now" for the reconciliation, e.g. for staleness. */
    asOf: text("as_of").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("evaluations_account").on(t.accountId, t.id)],
);

/** Each card's reported and ledger balance at every evaluation, for charting when a gap appeared. */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    evaluationId: integer("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /** The sync whose balance observation this compares against. */
    observedSyncId: integer("observed_sync_id")
      .notNull()
      .references(() => syncs.id, { onDelete: "cascade" }),
    reportedCents: integer("reported_cents").notNull(),
    ledgerCents: integer("ledger_cents").notNull(),
    holdsCents: integer("holds_cents").notNull(),
    gapCents: integer("gap_cents").notNull(),
    /** Copied from the observation: the gap may be an artefact of the balance moving mid-sync. */
    transient: integer({ mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.evaluationId] })],
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
  setByEvaluationId: integer("set_by_evaluation_id").references(() => evaluations.id, {
    onDelete: "set null",
  }),
});

/** One row per finding identity, tracked across evaluations: see `findings.ts`. */
export const findings = sqliteTable(
  "findings",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    cardId: integer("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    kind: text().$type<FindingKind>().notNull(),
    fingerprint: text().notNull(),
    /** As of the last evaluation that saw it. */
    cents: integer(),
    message: text().notNull(),
    activityIds: text("activity_ids", { mode: "json" }).$type<number[]>().notNull(),
    firstSeenEvaluationId: integer("first_seen_evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    lastSeenEvaluationId: integer("last_seen_evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /** The first evaluation that no longer saw it; cleared if it comes back. */
    resolvedEvaluationId: integer("resolved_evaluation_id").references(() => evaluations.id, {
      onDelete: "set null",
    }),
    explainedAt: text("explained_at"),
    explanation: text(),
  },
  (t) => [unique("findings_card_fingerprint").on(t.cardId, t.fingerprint)],
);
