import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, gte, inArray, notExists, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { balanceSnapshots, cards, evaluations, logicalCards, openingBalances } from "../db/schema.ts";
import { reevaluate } from "../reevaluate.ts";
import { type AccountEnv, type AppDeps, idParam, invalid, notFound } from "./common.ts";

type CardRow = typeof cards.$inferSelect;

/** Each card's latest balance snapshot, with when it was evaluated. */
function latestSnapshots(db: Db, cardIds: number[]) {
  if (cardIds.length === 0) return new Map<number, ReturnType<typeof snapshotDto>>();
  const rows = db
    .select({ snapshot: balanceSnapshots, asOf: evaluations.asOf })
    .from(balanceSnapshots)
    .innerJoin(evaluations, eq(evaluations.id, balanceSnapshots.evaluationId))
    .where(
      and(
        inArray(balanceSnapshots.cardId, cardIds),
        eq(
          balanceSnapshots.evaluationId,
          sql`(SELECT max(s2.evaluation_id) FROM balance_snapshots s2 WHERE s2.card_id = ${balanceSnapshots.cardId})`,
        ),
      ),
    )
    .all();
  return new Map(rows.map((r) => [r.snapshot.cardId, snapshotDto(r)]));
}

function snapshotDto(r: { snapshot: typeof balanceSnapshots.$inferSelect; asOf: string }) {
  return {
    cardId: r.snapshot.cardId,
    evaluationId: r.snapshot.evaluationId,
    asOf: r.asOf,
    reportedCents: r.snapshot.reportedCents,
    ledgerCents: r.snapshot.ledgerCents,
    holdsCents: r.snapshot.holdsCents,
    gapCents: r.snapshot.gapCents,
    transient: r.snapshot.transient,
  };
}

function cardDtos(db: Db, rows: CardRow[]) {
  const ids = rows.map((c) => c.id);
  const balances = latestSnapshots(db, ids);
  const openings = new Map(
    ids.length === 0
      ? []
      : db
          .select()
          .from(openingBalances)
          .where(inArray(openingBalances.cardId, ids))
          .all()
          .map((o) => [o.cardId, { cents: o.cents, source: o.source, setAt: o.setAt }]),
  );
  return rows.map((c) => ({
    id: c.id,
    logicalCardId: c.logicalCardId,
    twofiatId: c.twofiatId,
    alias: c.alias,
    maskedNumber: c.maskedNumber,
    currency: c.currency,
    product: c.product,
    status: c.status,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    firstSeenAt: c.firstSeenAt,
    /** As of the latest evaluation that saw the card; null before its first. */
    balance: balances.get(c.id) ?? null,
    openingBalance: openings.get(c.id) ?? null,
  }));
}

function accountCards(db: Db, accountId: number) {
  return db.select().from(cards).where(eq(cards.accountId, accountId)).orderBy(asc(cards.id)).all();
}

function cardOf(db: Db, accountId: number, id: number): CardRow {
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.id, id), eq(cards.accountId, accountId)))
    .get();
  if (!card) throw notFound("card");
  return card;
}

const cardDto = (db: Db, card: CardRow) => cardDtos(db, [card])[0];

function logicalCardDtos(db: Db, accountId: number) {
  const members = cardDtos(db, accountCards(db, accountId));
  return db
    .select()
    .from(logicalCards)
    .where(eq(logicalCards.accountId, accountId))
    .orderBy(asc(logicalCards.id))
    .all()
    .map((l) => {
      const own = members.filter((c) => c.logicalCardId === l.id);
      const known = own.flatMap((c) => (c.balance ? [c.balance] : []));
      const sum = (field: "reportedCents" | "ledgerCents" | "holdsCents" | "gapCents") =>
        known.reduce((total, b) => total + b[field], 0);
      return {
        id: l.id,
        name: l.name,
        createdAt: l.createdAt,
        cardIds: own.map((c) => c.id),
        /** The sum over its physical cards' latest balances; null while none has one. */
        balance:
          known.length === 0
            ? null
            : {
                reportedCents: sum("reportedCents"),
                ledgerCents: sum("ledgerCents"),
                holdsCents: sum("holdsCents"),
                gapCents: sum("gapCents"),
                transient: known.some((b) => b.transient),
              },
      };
    });
}

/** Routes under `/accounts/:accountId` for physical cards, logical cards and balances. */
export function cardRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<AccountEnv>()
      .get("/cards", (c) => c.json(cardDtos(db, accountCards(db, c.var.account.id))))
      .get("/cards/:cardId", (c) =>
        c.json(cardDto(db, cardOf(db, c.var.account.id, idParam(c, "cardId", "card")))),
      )
      // Moves a physical card into another logical card (e.g. a replacement into its predecessor's), or with
      // null into a logical card of its own. A logical card left empty is deleted.
      .patch(
        "/cards/:cardId",
        zValidator("json", z.object({ logicalCardId: z.number().int().positive().nullable() }), invalid),
        (c) => {
          const accountId = c.var.account.id;
          const card = cardOf(db, accountId, idParam(c, "cardId", "card"));
          const { logicalCardId } = c.req.valid("json");
          db.transaction((q) => {
            let target = logicalCardId;
            if (target === null) {
              target = q
                .insert(logicalCards)
                .values({ accountId, name: card.alias })
                .returning({ id: logicalCards.id })
                .get().id;
            } else {
              const exists = q
                .select({ id: logicalCards.id })
                .from(logicalCards)
                .where(and(eq(logicalCards.id, target), eq(logicalCards.accountId, accountId)))
                .get();
              if (!exists) throw notFound("logical card");
            }
            q.update(cards).set({ logicalCardId: target }).where(eq(cards.id, card.id)).run();
            q.delete(logicalCards)
              .where(
                and(
                  eq(logicalCards.accountId, accountId),
                  notExists(q.select().from(cards).where(eq(cards.logicalCardId, logicalCards.id))),
                ),
              )
              .run();
          });
          return c.json(cardDto(db, cardOf(db, accountId, card.id)));
        },
      )
      // Enters a card's opening balance and re-evaluates, without a sync.
      .put(
        "/cards/:cardId/opening-balance",
        zValidator("json", z.object({ cents: z.number().int().safe() }), invalid),
        (c) => {
          const accountId = c.var.account.id;
          const card = cardOf(db, accountId, idParam(c, "cardId", "card"));
          const entered = {
            cents: c.req.valid("json").cents,
            source: "entered" as const,
            setAt: now().toISOString(),
            setByEvaluationId: null,
          };
          db.insert(openingBalances)
            .values({ cardId: card.id, ...entered })
            .onConflictDoUpdate({ target: openingBalances.cardId, set: entered })
            .run();
          reevaluate(db, accountId, now());
          return c.json(cardDto(db, card));
        },
      )
      // Drops a card's opening balance and re-evaluates, which infers it again if its history is incomplete.
      .delete("/cards/:cardId/opening-balance", (c) => {
        const accountId = c.var.account.id;
        const card = cardOf(db, accountId, idParam(c, "cardId", "card"));
        db.delete(openingBalances).where(eq(openingBalances.cardId, card.id)).run();
        reevaluate(db, accountId, now());
        return c.json(cardDto(db, card));
      })
      .get("/logical-cards", (c) => c.json(logicalCardDtos(db, c.var.account.id)))
      .patch(
        "/logical-cards/:logicalCardId",
        zValidator("json", z.object({ name: z.string().trim().min(1).max(100) }), invalid),
        (c) => {
          const accountId = c.var.account.id;
          const id = idParam(c, "logicalCardId", "logical card");
          const changed = db
            .update(logicalCards)
            .set({ name: c.req.valid("json").name })
            .where(and(eq(logicalCards.id, id), eq(logicalCards.accountId, accountId)))
            .run().changes;
          if (changed === 0) throw notFound("logical card");
          return c.json(logicalCardDtos(db, accountId).find((l) => l.id === id));
        },
      )
      // Each card's balances at every evaluation, oldest first: when a gap appeared, and how it moved.
      .get(
        "/snapshots",
        zValidator(
          "query",
          z.object({
            cardId: z.coerce.number().int().positive().optional(),
            from: z.iso.datetime().optional(),
          }),
          invalid,
        ),
        (c) => {
          const { cardId, from } = c.req.valid("query");
          const rows = db
            .select({ snapshot: balanceSnapshots, asOf: evaluations.asOf })
            .from(balanceSnapshots)
            .innerJoin(evaluations, eq(evaluations.id, balanceSnapshots.evaluationId))
            .where(
              and(
                eq(evaluations.accountId, c.var.account.id),
                cardId === undefined ? undefined : eq(balanceSnapshots.cardId, cardId),
                from === undefined ? undefined : gte(evaluations.asOf, from),
              ),
            )
            .orderBy(asc(balanceSnapshots.evaluationId), asc(balanceSnapshots.cardId))
            .all();
          return c.json(rows.map(snapshotDto));
        },
      )
  );
}
