import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  type AdjustmentRow,
  activityOf,
  createAdjustment,
  deleteAdjustment,
  updateAdjustment,
} from "../adjustments.ts";
import type { Db } from "../db/db.ts";
import { adjustments, cards, rawOrders } from "../db/schema.ts";
import { reevaluate } from "../reevaluate.ts";
import { type AccountEnv, type AppDeps, idParam, invalid } from "./common.ts";

const Fields = z.object({
  cents: z
    .number()
    .int()
    .safe()
    .refine((v) => v !== 0, "an adjustment can't be zero"),
  occurredAt: z.iso.datetime().transform((v) => new Date(v).toISOString()),
  note: z.string().trim().min(1).max(2000),
});

function adjustmentDto(db: Db, a: AdjustmentRow) {
  const order =
    a.rawOrderId === null
      ? undefined
      : db
          .select({ id: rawOrders.id, twofiatId: rawOrders.twofiatId, createdAt: rawOrders.createdAt })
          .from(rawOrders)
          .where(eq(rawOrders.id, a.rawOrderId))
          .get();
  return {
    id: a.id,
    cardId: a.cardId,
    cents: a.cents,
    occurredAt: a.occurredAt,
    note: a.note,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    activityId: activityOf(db, a.id) ?? null,
    /** The top-up order this adjustment completes, if any. */
    order: order ?? null,
  };
}

/**
 * Routes under `/accounts/:accountId` for adjustments: money 2fiat moved without a row. Every change re-evaluates
 * the account straight away, without a sync.
 */
export function adjustmentRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<AccountEnv>()
      // Oldest first.
      .get(
        "/adjustments",
        zValidator(
          "query",
          z.object({
            cardId: z.coerce.number().int().positive().optional(),
            /** The adjustments of all its physical cards. */
            logicalCardId: z.coerce.number().int().positive().optional(),
          }),
          invalid,
        ),
        (c) => {
          const { cardId, logicalCardId } = c.req.valid("query");
          return c.json(
            db
              .select()
              .from(adjustments)
              .where(
                and(
                  eq(adjustments.accountId, c.var.account.id),
                  cardId === undefined ? undefined : eq(adjustments.cardId, cardId),
                  logicalCardId === undefined
                    ? undefined
                    : inArray(
                        adjustments.cardId,
                        db.select({ id: cards.id }).from(cards).where(eq(cards.logicalCardId, logicalCardId)),
                      ),
                ),
              )
              .orderBy(asc(adjustments.occurredAt), asc(adjustments.id))
              .all()
              .map((a) => adjustmentDto(db, a)),
          );
        },
      )
      .post(
        "/adjustments",
        zValidator(
          "json",
          Fields.extend({
            cardId: z.number().int().positive(),
            /** A top-up activity on the card whose order this adjustment completes. */
            topupActivityId: z.number().int().positive().optional(),
          }),
          invalid,
        ),
        (c) => {
          const { cardId, topupActivityId, ...input } = c.req.valid("json");
          const accountId = c.var.account.id;
          const adjustment = createAdjustment(db, accountId, cardId, input, { topupActivityId });
          reevaluate(db, accountId, now());
          return c.json(adjustmentDto(db, adjustment), 201);
        },
      )
      .patch(
        "/adjustments/:adjustmentId",
        zValidator(
          "json",
          Fields.partial().refine((v) => Object.keys(v).length > 0, "nothing to change"),
          invalid,
        ),
        (c) => {
          const accountId = c.var.account.id;
          const id = idParam(c, "adjustmentId", "adjustment");
          const adjustment = updateAdjustment(db, accountId, id, c.req.valid("json"));
          reevaluate(db, accountId, now());
          return c.json(adjustmentDto(db, adjustment));
        },
      )
      .delete("/adjustments/:adjustmentId", (c) => {
        const accountId = c.var.account.id;
        deleteAdjustment(db, accountId, idParam(c, "adjustmentId", "adjustment"));
        reevaluate(db, accountId, now());
        return c.body(null, 204);
      })
  );
}
