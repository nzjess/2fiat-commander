import { zValidator } from "@hono/zod-validator";
import { LOOKBACK_DAYS } from "@twofiat/client";
import { and, desc, eq, gte, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  activities,
  activitySources,
  adjustments,
  cards,
  findings,
  rawOrders,
  rawTransactions,
} from "../db/schema.ts";
import { daysBefore } from "../time.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";

type ActivityRow = typeof activities.$inferSelect;

/** Kinds whose pending authorisation should post within days; older ones are stale, as reconcile reports them. */
const STALE_KINDS = ["purchase", "refund"] as const;

function activityDto(a: ActivityRow, staleBefore: string) {
  return {
    id: a.id,
    cardId: a.cardId,
    kind: a.kind,
    status: a.status,
    amountCents: a.amountCents,
    authorizedAmountCents: a.authorizedAmountCents,
    attemptedAmountCents: a.attemptedAmountCents,
    requestedAmountCents: a.requestedAmountCents,
    feeCents: a.feeCents,
    currency: a.currency,
    occurredAt: a.occurredAt,
    settledAt: a.settledAt,
    description: a.description,
    postedDescription: a.postedDescription,
    transferId: a.transferId,
    counterpartCardId: a.counterpartCardId,
    flags: a.flags,
    /** Authorised more than `LOOKBACK_DAYS` ago and never posted. Computed now, never stored. */
    stale:
      a.status === "pending" &&
      (STALE_KINDS as readonly string[]).includes(a.kind) &&
      a.occurredAt < staleBefore,
  };
}

const list = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

const Cursor = z.tuple([z.string(), z.number().int()]);
const encodeCursor = (a: ActivityRow) =>
  Buffer.from(JSON.stringify([a.occurredAt, a.id])).toString("base64url");
function decodeCursor(cursor: string): [string, number] {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ApiError(400, "invalid_request", "cursor: not a cursor from this endpoint");
  }
}

const ListQuery = z.object({
  cardId: z.coerce.number().int().positive().optional(),
  logicalCardId: z.coerce.number().int().positive().optional(),
  /** The activities a finding points at. */
  findingId: z.coerce.number().int().positive().optional(),
  /** Comma-separated. */
  kind: z.string().transform(list).optional(),
  /** Comma-separated kinds to leave out, e.g. `fee`. */
  excludeKind: z.string().transform(list).optional(),
  status: z.string().transform(list).optional(),
  /** occurred_at from this time (inclusive) up to `to` (exclusive). */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Matches the description or the posted one. */
  q: z.string().trim().min(1).max(200).optional(),
  stale: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Routes under `/accounts/:accountId` for the activity ledger. */
export function activityRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<AccountEnv>()
      // Newest first, a page at a time: pass `nextCursor` back as `cursor` for the next page.
      .get("/activities", zValidator("query", ListQuery, invalid), (c) => {
        const query = c.req.valid("query");
        const staleBefore = daysBefore(now().toISOString(), LOOKBACK_DAYS);
        const isStale = and(
          eq(activities.status, "pending"),
          inArray(activities.kind, [...STALE_KINDS]),
          lt(activities.occurredAt, staleBefore),
        );
        const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
        const pattern = query.q && `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

        const rows = db
          .select()
          .from(activities)
          .where(
            and(
              eq(activities.accountId, c.var.account.id),
              query.cardId === undefined ? undefined : eq(activities.cardId, query.cardId),
              query.logicalCardId === undefined
                ? undefined
                : inArray(
                    activities.cardId,
                    db
                      .select({ id: cards.id })
                      .from(cards)
                      .where(eq(cards.logicalCardId, query.logicalCardId)),
                  ),
              // Activities are this account's, so another account's finding matches nothing.
              query.findingId === undefined
                ? undefined
                : sql`${activities.id} IN (SELECT value FROM ${findings}, json_each(${findings.activityIds}) WHERE ${findings.id} = ${query.findingId})`,
              query.kind?.length ? inArray(activities.kind, query.kind as ActivityRow["kind"][]) : undefined,
              query.excludeKind?.length
                ? notInArray(activities.kind, query.excludeKind as ActivityRow["kind"][])
                : undefined,
              query.status?.length
                ? inArray(activities.status, query.status as ActivityRow["status"][])
                : undefined,
              query.from === undefined ? undefined : gte(activities.occurredAt, query.from),
              query.to === undefined ? undefined : lt(activities.occurredAt, query.to),
              pattern
                ? or(
                    sql`${activities.description} LIKE ${pattern} ESCAPE '\\'`,
                    sql`${activities.postedDescription} LIKE ${pattern} ESCAPE '\\'`,
                  )
                : undefined,
              query.stale === undefined
                ? undefined
                : query.stale === "true"
                  ? isStale
                  : sql`NOT (${isStale})`,
              cursor === undefined
                ? undefined
                : or(
                    lt(activities.occurredAt, cursor[0]),
                    and(eq(activities.occurredAt, cursor[0]), lt(activities.id, cursor[1])),
                  ),
            ),
          )
          .orderBy(desc(activities.occurredAt), desc(activities.id))
          .limit(query.limit + 1)
          .all();

        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return c.json({
          items: page.map((a) => activityDto(a, staleBefore)),
          nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        });
      })
      // One activity, with 2fiat's original rows (or the user's adjustment) behind it and the findings that point at it.
      .get("/activities/:activityId", (c) => {
        const id = idParam(c, "activityId", "activity");
        const activity = db
          .select()
          .from(activities)
          .where(and(eq(activities.id, id), eq(activities.accountId, c.var.account.id)))
          .get();
        if (!activity) throw notFound("activity");

        const transactions = db
          .select({
            id: rawTransactions.id,
            twofiatId: rawTransactions.twofiatId,
            createdAt: rawTransactions.createdAt,
            firstSeenAt: rawTransactions.firstSeenAt,
            lastSeenAt: rawTransactions.lastSeenAt,
            raw: rawTransactions.raw,
          })
          .from(activitySources)
          .innerJoin(rawTransactions, eq(rawTransactions.id, activitySources.rawTransactionId))
          .where(eq(activitySources.activityId, id))
          .orderBy(rawTransactions.createdAt, rawTransactions.id)
          .all();
        const orders = db
          .select({
            id: rawOrders.id,
            twofiatId: rawOrders.twofiatId,
            createdAt: rawOrders.createdAt,
            firstSeenAt: rawOrders.firstSeenAt,
            lastSeenAt: rawOrders.lastSeenAt,
            raw: rawOrders.raw,
          })
          .from(activitySources)
          .innerJoin(rawOrders, eq(rawOrders.id, activitySources.rawOrderId))
          .where(eq(activitySources.activityId, id))
          .orderBy(rawOrders.createdAt, rawOrders.id)
          .all();
        const adjustment =
          db
            .select({
              id: adjustments.id,
              cents: adjustments.cents,
              occurredAt: adjustments.occurredAt,
              note: adjustments.note,
              createdAt: adjustments.createdAt,
              updatedAt: adjustments.updatedAt,
            })
            .from(activitySources)
            .innerJoin(adjustments, eq(adjustments.id, activitySources.adjustmentId))
            .where(eq(activitySources.activityId, id))
            .get() ?? null;
        const findingIds = db
          .select({ id: findings.id })
          .from(findings)
          .where(
            and(
              eq(findings.cardId, activity.cardId),
              sql`EXISTS (SELECT 1 FROM json_each(${findings.activityIds}) WHERE value = ${id})`,
            ),
          )
          .all()
          .map((f) => f.id);

        return c.json({
          ...activityDto(activity, daysBefore(now().toISOString(), LOOKBACK_DAYS)),
          sources: { transactions, orders, adjustment },
          findingIds,
        });
      })
  );
}
