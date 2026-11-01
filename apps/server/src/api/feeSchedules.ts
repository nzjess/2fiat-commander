import { zValidator } from "@hono/zod-validator";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { cards, feeSchedules } from "../db/schema.ts";
import { feeComparisons, suggestSchedule } from "../fees.ts";
import { reevaluate } from "../reevaluate.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";
import { anyRole, cardGuards, requireAccount } from "./guards.ts";

type ScheduleRow = typeof feeSchedules.$inferSelect;

function scheduleDto(s: ScheduleRow) {
  return {
    id: s.id,
    product: s.product,
    kind: s.kind,
    effectiveFrom: s.effectiveFrom,
    rateBps: s.rateBps,
    authorizationFeeCents: s.authorizationFeeCents,
    postingFeeCents: s.postingFeeCents,
    note: s.note,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

const effectiveFrom = z.iso.datetime().transform((v) => new Date(v).toISOString());
const note = z.string().trim().min(1).max(2000);
const rateBps = z.number().int().min(0).max(10_000);
const feeCents = z.number().int().min(0).max(10_000);

const Create = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("topup"), product: z.string().min(1), effectiveFrom, note, rateBps }),
  z.object({
    kind: z.literal("transaction"),
    product: z.string().min(1),
    effectiveFrom,
    note,
    authorizationFeeCents: feeCents,
    postingFeeCents: feeCents,
  }),
]);

const Update = z
  .object({ effectiveFrom, note, rateBps, authorizationFeeCents: feeCents, postingFeeCents: feeCents })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

function findSchedule(db: Db, accountId: number, id: number): ScheduleRow {
  const schedule = db
    .select()
    .from(feeSchedules)
    .where(and(eq(feeSchedules.id, id), eq(feeSchedules.accountId, accountId)))
    .get();
  if (!schedule) throw notFound("fee schedule");
  return schedule;
}

/** No two schedules of a kind may start at the same time for the same product. */
function assertFreeStart(
  db: Db,
  accountId: number,
  s: Pick<ScheduleRow, "product" | "kind" | "effectiveFrom">,
  id?: number,
) {
  const clash = db
    .select({ id: feeSchedules.id })
    .from(feeSchedules)
    .where(
      and(
        eq(feeSchedules.accountId, accountId),
        eq(feeSchedules.product, s.product),
        eq(feeSchedules.kind, s.kind),
        eq(feeSchedules.effectiveFrom, s.effectiveFrom),
      ),
    )
    .get();
  if (clash && clash.id !== id) {
    throw new ApiError(409, "duplicate_schedule", "a schedule of this kind already starts then");
  }
}

/**
 * Routes under `/accounts/:accountId` for fee schedules the user accepted as 2fiat's practice, and what a card's
 * fees came to against them. Every change re-evaluates the account straight away, without a sync.
 */
export function feeScheduleRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const { onLogicalCard } = cardGuards(db);

  return (
    new Hono<AccountEnv>()
      // By product, kind and start.
      .get(
        "/fee-schedules",
        anyRole,
        zValidator("query", z.object({ product: z.string().min(1).optional() }), invalid),
        (c) => {
          const { product } = c.req.valid("query");
          return c.json(
            db
              .select()
              .from(feeSchedules)
              .where(
                and(
                  eq(feeSchedules.accountId, c.var.account.id),
                  product === undefined ? undefined : eq(feeSchedules.product, product),
                ),
              )
              .orderBy(asc(feeSchedules.product), asc(feeSchedules.kind), asc(feeSchedules.effectiveFrom))
              .all()
              .map(scheduleDto),
          );
        },
      )
      // What to accept for a card's product, from what 2fiat has charged.
      .get(
        "/fee-schedules/suggestion",
        requireAccount("fees.edit"),
        zValidator(
          "query",
          z.object({ cardId: z.coerce.number().int().positive(), kind: z.enum(["topup", "transaction"]) }),
          invalid,
        ),
        (c) => {
          const { cardId, kind } = c.req.valid("query");
          const card = db
            .select({ id: cards.id })
            .from(cards)
            .where(and(eq(cards.id, cardId), eq(cards.accountId, c.var.account.id)))
            .get();
          if (!card) throw notFound("card");
          const suggestion = suggestSchedule(db, c.var.account.id, cardId, kind);
          if (!suggestion) throw new ApiError(409, "no_fees", "no fees of this kind charged yet");
          return c.json(suggestion);
        },
      )
      .post("/fee-schedules", requireAccount("fees.edit"), zValidator("json", Create, invalid), (c) => {
        const input = c.req.valid("json");
        const accountId = c.var.account.id;
        const product = db
          .select({ id: cards.id })
          .from(cards)
          .where(and(eq(cards.accountId, accountId), eq(cards.product, input.product)))
          .get();
        if (!product) throw new ApiError(400, "invalid_request", "product: no card of this product");
        assertFreeStart(db, accountId, input);
        const schedule = db
          .insert(feeSchedules)
          .values({ accountId, ...input })
          .returning()
          .get();
        reevaluate(db, accountId, now());
        return c.json(scheduleDto(schedule), 201);
      })
      .patch(
        "/fee-schedules/:scheduleId",
        requireAccount("fees.edit"),
        zValidator("json", Update, invalid),
        (c) => {
          const accountId = c.var.account.id;
          const existing = findSchedule(db, accountId, idParam(c, "scheduleId", "fee schedule"));
          const changes = c.req.valid("json");
          const wrongKind =
            existing.kind === "topup"
              ? changes.authorizationFeeCents !== undefined || changes.postingFeeCents !== undefined
              : changes.rateBps !== undefined;
          if (wrongKind) {
            throw new ApiError(400, "invalid_request", `a ${existing.kind} schedule has no such value`);
          }
          assertFreeStart(db, accountId, { ...existing, ...changes }, existing.id);
          const schedule = db
            .update(feeSchedules)
            .set({ ...changes, updatedAt: now().toISOString() })
            .where(eq(feeSchedules.id, existing.id))
            .returning()
            .get();
          reevaluate(db, accountId, now());
          return c.json(scheduleDto(schedule));
        },
      )
      .delete("/fee-schedules/:scheduleId", requireAccount("fees.edit"), (c) => {
        const accountId = c.var.account.id;
        const existing = findSchedule(db, accountId, idParam(c, "scheduleId", "fee schedule"));
        db.delete(feeSchedules).where(eq(feeSchedules.id, existing.id)).run();
        reevaluate(db, accountId, now());
        return c.body(null, 204);
      })
      // Each of a logical card's physical cards: its fees against the advert and the accepted schedules.
      .get("/logical-cards/:logicalCardId/fees", onLogicalCard("card.view"), (c) => {
        const result = feeComparisons(
          db,
          c.var.account.id,
          idParam(c, "logicalCardId", "logical card"),
          now().toISOString(),
        );
        if (!result) throw notFound("logical card");
        return c.json({ cards: result });
      })
  );
}
