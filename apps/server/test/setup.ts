import type { RawCardDetails, RawOrder, RawTransaction } from "@twofiat/client";
import { CARD_A, CARD_B, card } from "@twofiat/client/fixtures";
import { asc, eq } from "drizzle-orm";
import { openDb } from "../src/db/db.ts";
import {
  accounts,
  activities,
  activitySources,
  cards,
  evaluations,
  grants,
  logicalCards,
  rawOrders,
  rawTransactions,
  users,
} from "../src/db/schema.ts";

/** A fresh in-memory database with one user, one account and cards A and B. */
export function setup() {
  const db = openDb(":memory:");
  const userId = db.insert(users).values({ username: "u", passwordHash: "x" }).returning().get().id;
  const addAccount = (label: string) => {
    const id = db.insert(accounts).values({ label, tokenEnc: "x", tokenHash: label }).returning().get().id;
    db.insert(grants).values({ accountId: id, userId, role: "owner" }).run();
    return id;
  };
  const accountId = addAccount("main");

  const addCard = (raw: RawCardDetails, account = accountId) => {
    const logicalCardId = db
      .insert(logicalCards)
      .values({ accountId: account, name: raw.alias })
      .returning()
      .get().id;
    return db
      .insert(cards)
      .values({
        accountId: account,
        logicalCardId,
        isCurrent: true,
        twofiatId: raw.id,
        alias: raw.alias,
        maskedNumber: raw.cardNumber,
        currency: raw.currency,
        product: raw.cardProduct.title,
        status: raw.status,
        issuedAt: raw.createdAt,
        expiresAt: raw.expireDate,
        raw,
      })
      .returning()
      .get();
  };
  addCard(card({ id: CARD_A, balance: 0 }));
  addCard(card({ id: CARD_B, balance: 0 }));
  const cardId = (twofiatId: string) =>
    db.select().from(cards).where(eq(cards.twofiatId, twofiatId)).get()?.id as number;

  const now = new Date().toISOString();
  const addRows = (transactions: RawTransaction[], orders: RawOrder[] = []) => {
    for (const raw of transactions) {
      db.insert(rawTransactions)
        .values({
          accountId,
          cardId: cardId(raw.cardId),
          twofiatId: raw.id,
          createdAt: new Date(raw.createdAt).toISOString(),
          raw,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();
    }
    for (const raw of orders) {
      db.insert(rawOrders)
        .values({
          accountId,
          cardId: raw.cardId === null ? null : cardId(raw.cardId),
          twofiatId: raw.id,
          createdAt: new Date(raw.createdAt).toISOString(),
          raw,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();
    }
  };

  /** Writes an activity directly, as an earlier normaliser might have left it. */
  const seedActivity = (key: string, transactionIds: string[]) => {
    const rows = transactionIds.map(
      (id) => db.select().from(rawTransactions).where(eq(rawTransactions.twofiatId, id)).get() as RawRow,
    );
    const first = rows[0] as RawRow;
    const id = db
      .insert(activities)
      .values({
        accountId,
        cardId: first.cardId,
        key,
        kind: "purchase",
        status: "pending",
        amountCents: 0,
        currency: "USD",
        occurredAt: first.createdAt,
        description: "seeded",
        flags: [],
        normalizerVersion: 0,
      })
      .returning()
      .get().id;
    for (const r of rows) db.insert(activitySources).values({ activityId: id, rawTransactionId: r.id }).run();
    return id;
  };

  /** Activities with their sources as 2fiat transaction ids, oldest first. */
  const ledger = () =>
    db
      .select()
      .from(activities)
      .orderBy(asc(activities.occurredAt), asc(activities.id))
      .all()
      .map((a) => ({
        ...a,
        sources: db
          .select({ twofiatId: rawTransactions.twofiatId })
          .from(activitySources)
          .innerJoin(rawTransactions, eq(rawTransactions.id, activitySources.rawTransactionId))
          .where(eq(activitySources.activityId, a.id))
          .all()
          .map((s) => s.twofiatId)
          .sort(),
      }));

  const addEvaluation = () =>
    db.insert(evaluations).values({ accountId, asOf: new Date().toISOString() }).returning().get().id;

  return { db, userId, accountId, addAccount, addCard, cardId, addRows, seedActivity, ledger, addEvaluation };
}

type RawRow = typeof rawTransactions.$inferSelect;
