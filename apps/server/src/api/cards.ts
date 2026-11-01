import { zValidator } from "@hono/zod-validator";
import { dollarsToCents } from "@twofiat/client";
import { and, asc, eq, gte, inArray, notExists, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { balanceHistory } from "../balanceHistory.ts";
import { cashFlow } from "../cashflow.ts";
import type { Db, Executor } from "../db/db.ts";
import {
  balanceObservations,
  balanceSnapshots,
  cards,
  evaluations,
  logicalCards,
  openingBalances,
} from "../db/schema.ts";
import { reevaluate } from "../reevaluate.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";
import { anyRole, assertOnCard, cardGuards, forbidden, requireAccount } from "./guards.ts";

type CardRow = typeof cards.$inferSelect;

/** Whether `a` was issued after `b`. A card with no issue date counts as the oldest. */
const issuedAfter = (a: CardRow, b: CardRow) => (a.issuedAt ?? "") > (b.issuedAt ?? "");

/** Gives a logical card without a current card its latest-issued card (on a tie, the newest row) as current. */
function electCurrent(q: Executor, logicalCardId: number) {
  const members = q
    .select()
    .from(cards)
    .where(eq(cards.logicalCardId, logicalCardId))
    .orderBy(asc(cards.id))
    .all();
  if (members.length === 0 || members.some((c) => c.isCurrent)) return;
  const latest = members.reduce((best, c) => (issuedAfter(best, c) ? best : c));
  q.update(cards).set({ isCurrent: true }).where(eq(cards.id, latest.id)).run();
}

function makeCurrent(q: Executor, card: CardRow) {
  q.update(cards)
    .set({ isCurrent: false })
    .where(and(eq(cards.logicalCardId, card.logicalCardId), eq(cards.isCurrent, true)))
    .run();
  q.update(cards).set({ isCurrent: true }).where(eq(cards.id, card.id)).run();
}

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

/** Each card's latest reported balance from a sync, with when it was observed. */
function latestObservations(db: Db, cardIds: number[]) {
  if (cardIds.length === 0) return new Map<number, { cents: number; asOf: string }>();
  return new Map(
    db
      .select({
        cardId: balanceObservations.cardId,
        cents: balanceObservations.reportedCents,
        asOf: balanceObservations.observedAt,
      })
      .from(balanceObservations)
      .where(
        and(
          inArray(balanceObservations.cardId, cardIds),
          eq(
            balanceObservations.syncId,
            sql`(SELECT max(o2.sync_id) FROM balance_observations o2 WHERE o2.card_id = ${balanceObservations.cardId})`,
          ),
        ),
      )
      .all()
      .map((o) => [o.cardId, { cents: o.cents, asOf: o.asOf }]),
  );
}

function cardDtos(db: Db, rows: CardRow[]) {
  const ids = rows.map((c) => c.id);
  const balances = latestSnapshots(db, ids);
  const observed = latestObservations(db, ids);
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
    isCurrent: c.isCurrent,
    twofiatId: c.twofiatId,
    alias: c.alias,
    maskedNumber: c.maskedNumber,
    currency: c.currency,
    product: c.product,
    status: c.status,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    firstSeenAt: c.firstSeenAt,
    /**
     * What 2fiat last reported the card holds, which is what it holds: from the latest sync, or before the first
     * one, from the card's details as fetched when the account was added.
     */
    reported: observed.get(c.id) ?? { cents: dollarsToCents(c.raw.balance), asOf: c.updatedAt },
    /** When 2fiat's card list first left the card out; null while it's listed. */
    missingSince: c.missingSince,
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
        currentCardId: own.find((c) => c.isCurrent)?.id ?? null,
        /** What 2fiat reports its listed physical cards hold, summed; a missing card's last balance isn't counted. */
        reportedCents: own
          .filter((c) => c.missingSince === null)
          .reduce((total, c) => total + c.reported.cents, 0),
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
  const { onCard, onLogicalCard } = cardGuards(db);

  return (
    new Hono<AccountEnv>()
      .get("/cards", anyRole, (c) => c.json(cardDtos(db, accountCards(db, c.var.account.id))))
      .get("/cards/:cardId", onCard("card.view"), (c) =>
        c.json(cardDto(db, cardOf(db, c.var.account.id, idParam(c, "cardId", "card")))),
      )
      // Moves a physical card into another logical card (e.g. a replacement into its predecessor's), or with
      // null into a logical card of its own. The moved card becomes current if it was issued after the target's
      // current card. A logical card that loses its current card gets its latest-issued one as current, and one
      // left empty is deleted.
      .patch(
        "/cards/:cardId",
        requireAccount("cards.link"),
        zValidator("json", z.object({ logicalCardId: z.number().int().positive().nullable() }), invalid),
        (c) => {
          const accountId = c.var.account.id;
          const card = cardOf(db, accountId, idParam(c, "cardId", "card"));
          const { logicalCardId } = c.req.valid("json");
          if (logicalCardId === card.logicalCardId) return c.json(cardDto(db, card));
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
            q.update(cards)
              .set({ logicalCardId: target, isCurrent: false })
              .where(eq(cards.id, card.id))
              .run();
            const current = q
              .select()
              .from(cards)
              .where(and(eq(cards.logicalCardId, target), eq(cards.isCurrent, true)))
              .get();
            if (current && issuedAfter(card, current)) makeCurrent(q, { ...card, logicalCardId: target });
            electCurrent(q, target);
            electCurrent(q, card.logicalCardId);
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
        onCard("card.openingBalance"),
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
      .delete("/cards/:cardId/opening-balance", onCard("card.openingBalance"), (c) => {
        const accountId = c.var.account.id;
        const card = cardOf(db, accountId, idParam(c, "cardId", "card"));
        db.delete(openingBalances).where(eq(openingBalances.cardId, card.id)).run();
        reevaluate(db, accountId, now());
        return c.json(cardDto(db, card));
      })
      .get("/logical-cards", anyRole, (c) => c.json(logicalCardDtos(db, c.var.account.id)))
      // Renames a logical card, or picks which of its physical cards is current.
      .patch(
        "/logical-cards/:logicalCardId",
        onLogicalCard("card.view"),
        zValidator(
          "json",
          z
            .object({ name: z.string().trim().min(1).max(100), currentCardId: z.number().int().positive() })
            .partial()
            .refine(
              (v) => v.name !== undefined || v.currentCardId !== undefined,
              "name or currentCardId is required",
            ),
          invalid,
        ),
        (c) => {
          const accountId = c.var.account.id;
          const id = idParam(c, "logicalCardId", "logical card");
          const { name, currentCardId } = c.req.valid("json");
          if (name !== undefined && !c.var.access.can("cards.rename")) throw forbidden();
          if (currentCardId !== undefined) assertOnCard(c.var.access, "card.setCurrent", id);
          db.transaction((q) => {
            const exists = q
              .select({ id: logicalCards.id })
              .from(logicalCards)
              .where(and(eq(logicalCards.id, id), eq(logicalCards.accountId, accountId)))
              .get();
            if (!exists) throw notFound("logical card");
            if (name !== undefined) q.update(logicalCards).set({ name }).where(eq(logicalCards.id, id)).run();
            if (currentCardId !== undefined) {
              const card = q
                .select()
                .from(cards)
                .where(and(eq(cards.id, currentCardId), eq(cards.logicalCardId, id)))
                .get();
              if (!card)
                throw new ApiError(400, "invalid_request", "currentCardId: not a card of this logical card");
              makeCurrent(q, card);
            }
          });
          return c.json(logicalCardDtos(db, accountId).find((l) => l.id === id));
        },
      )
      // A logical card's running ledger balance, and what 2fiat reported along the way.
      .get("/logical-cards/:logicalCardId/balance-history", onLogicalCard("card.view"), (c) => {
        const history = balanceHistory(db, c.var.account.id, idParam(c, "logicalCardId", "logical card"));
        if (!history) throw notFound("logical card");
        return c.json(history);
      })
      // A logical card's money in and out, for the cash flow chart.
      .get("/logical-cards/:logicalCardId/cash-flow", onLogicalCard("card.view"), (c) => {
        const flows = cashFlow(db, c.var.account.id, idParam(c, "logicalCardId", "logical card"));
        if (!flows) throw notFound("logical card");
        return c.json({ activities: flows });
      })
      // Each card's balances at every evaluation, oldest first: when a gap appeared, and how it moved.
      .get(
        "/snapshots",
        anyRole,
        zValidator(
          "query",
          z.object({
            cardId: z.coerce.number().int().positive().optional(),
            /** The snapshots of all its physical cards. */
            logicalCardId: z.coerce.number().int().positive().optional(),
            from: z.iso.datetime().optional(),
          }),
          invalid,
        ),
        (c) => {
          const { cardId, logicalCardId, from } = c.req.valid("query");
          const rows = db
            .select({ snapshot: balanceSnapshots, asOf: evaluations.asOf })
            .from(balanceSnapshots)
            .innerJoin(evaluations, eq(evaluations.id, balanceSnapshots.evaluationId))
            .where(
              and(
                eq(evaluations.accountId, c.var.account.id),
                cardId === undefined ? undefined : eq(balanceSnapshots.cardId, cardId),
                logicalCardId === undefined
                  ? undefined
                  : inArray(
                      balanceSnapshots.cardId,
                      db.select({ id: cards.id }).from(cards).where(eq(cards.logicalCardId, logicalCardId)),
                    ),
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
