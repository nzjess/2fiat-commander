import { zValidator } from "@hono/zod-validator";
import { LOOKBACK_DAYS } from "@twofiat/client";
import { and, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  annotate,
  CATEGORY_KINDS,
  categorize,
  NOTE_MAX,
  sameMerchant,
  takesCategory,
} from "../categories.ts";
import { chunks } from "../db/db.ts";
import {
  activities,
  activityAnnotations,
  activitySources,
  adjustments,
  cards,
  categories,
  findings,
  rawOrders,
  rawTransactions,
} from "../db/schema.ts";
import { daysBefore } from "../time.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";

type ActivityRow = typeof activities.$inferSelect;
type Annotation = Pick<typeof activityAnnotations.$inferSelect, "categoryId" | "categoryRuleId" | "note">;

/** Kinds whose pending authorisation should post within days; older ones are stale, as reconcile reports them. */
const STALE_KINDS = ["purchase", "refund"] as const;

function activityDto(a: ActivityRow, annotation: Annotation | null, staleBefore: string) {
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
    /** Whether it's spending, which can take a category. */
    categorizable: takesCategory(a.kind),
    categoryId: annotation?.categoryId ?? null,
    /** The rule that set the category, if one did. */
    categoryRuleId: annotation?.categoryRuleId ?? null,
    note: annotation?.note ?? null,
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
  /**
   * Comma-separated, any of them matching. `stale` is a pending hold that never posted, and `pending` then means
   * the rest, so each activity has exactly one, as the web app shows them.
   */
  status: z.string().transform(list).optional(),
  /** occurred_at from this time (inclusive) up to `to` (exclusive). */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Comma-separated category ids, and `none` for uncategorised spending. */
  category: z
    .string()
    .transform(list)
    .pipe(
      z.array(
        z.union([
          z.literal("none"),
          z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number),
        ]),
      ),
    )
    .optional(),
  /** Matches the description, the posted one, or the note. */
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Routes under `/accounts/:accountId` for the activity ledger. */
export function activityRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const findActivity = (id: number, accountId: number) => {
    const activity = db
      .select()
      .from(activities)
      .where(and(eq(activities.id, id), eq(activities.accountId, accountId)))
      .get();
    if (!activity) throw notFound("activity");
    return activity;
  };
  const annotationOf = (activityId: number): Annotation | null =>
    db
      .select({
        categoryId: activityAnnotations.categoryId,
        categoryRuleId: activityAnnotations.categoryRuleId,
        note: activityAnnotations.note,
      })
      .from(activityAnnotations)
      .where(eq(activityAnnotations.activityId, activityId))
      .get() ?? null;
  /** A category of the user's; anyone else's is a 400, as it's in the body. */
  const assertCategory = (categoryId: number, accountId: number) => {
    const found = db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.accountId, accountId)))
      .get();
    if (!found) throw new ApiError(400, "invalid_request", "categoryId: no such category");
  };
  const notSpending = (a: ActivityRow) =>
    new ApiError(400, "invalid_request", `a ${a.kind} can't take a category, only spending can`);

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
          .select({
            activity: activities,
            // Flat, not a nested object: Drizzle drops a left-joined object whose first column is null, which
            // would lose a note on an uncategorised activity.
            categoryId: activityAnnotations.categoryId,
            categoryRuleId: activityAnnotations.categoryRuleId,
            note: activityAnnotations.note,
          })
          .from(activities)
          .leftJoin(activityAnnotations, eq(activityAnnotations.activityId, activities.id))
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
                ? or(
                    ...query.status.map((status) =>
                      status === "stale"
                        ? isStale
                        : status === "pending"
                          ? and(eq(activities.status, "pending"), sql`NOT (${isStale})`)
                          : eq(activities.status, status as ActivityRow["status"]),
                    ),
                  )
                : undefined,
              query.category?.length
                ? or(
                    ...query.category.map((category) =>
                      category === "none"
                        ? and(
                            inArray(activities.kind, [...CATEGORY_KINDS]),
                            isNull(activityAnnotations.categoryId),
                          )
                        : eq(activityAnnotations.categoryId, category),
                    ),
                  )
                : undefined,
              query.from === undefined ? undefined : gte(activities.occurredAt, query.from),
              query.to === undefined ? undefined : lt(activities.occurredAt, query.to),
              pattern
                ? or(
                    sql`${activities.description} LIKE ${pattern} ESCAPE '\\'`,
                    sql`${activities.postedDescription} LIKE ${pattern} ESCAPE '\\'`,
                    sql`${activityAnnotations.note} LIKE ${pattern} ESCAPE '\\'`,
                  )
                : undefined,
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
          items: page.map(({ activity, ...annotation }) => activityDto(activity, annotation, staleBefore)),
          nextCursor: rows.length > query.limit && last ? encodeCursor(last.activity) : null,
        });
      })
      // Sets what's given of an activity's category and note; null clears one. Any activity takes a note.
      .patch(
        "/activities/:activityId/annotation",
        zValidator(
          "json",
          z.object({
            categoryId: z.number().int().positive().nullable().optional(),
            note: z.string().max(NOTE_MAX).nullable().optional(),
          }),
          invalid,
        ),
        (c) => {
          const changes = c.req.valid("json");
          const activity = findActivity(idParam(c, "activityId", "activity"), c.var.account.id);
          if (changes.categoryId != null) {
            if (!takesCategory(activity.kind)) throw notSpending(activity);
            assertCategory(changes.categoryId, c.var.account.id);
          }
          annotate(db, activity.id, changes);
          return c.json(
            activityDto(activity, annotationOf(activity.id), daysBefore(now().toISOString(), LOOKBACK_DAYS)),
          );
        },
      )
      // The account's uncategorised spending from the same merchant as this activity: for setting its category on them too.
      .get("/activities/:activityId/same-merchant", (c) => {
        const activity = findActivity(idParam(c, "activityId", "activity"), c.var.account.id);
        return c.json({ activityIds: sameMerchant(db, c.var.account.id, activity.description, activity.id) });
      })
      // Sets one category on many activities, keeping their notes.
      .post(
        "/activities/categorize",
        zValidator(
          "json",
          z.object({
            activityIds: z.array(z.number().int().positive()).min(1).max(5000),
            categoryId: z.number().int().positive(),
          }),
          invalid,
        ),
        (c) => {
          const { activityIds, categoryId } = c.req.valid("json");
          assertCategory(categoryId, c.var.account.id);
          const ids = [...new Set(activityIds)];
          const found = [...chunks(ids)].flatMap((chunk) =>
            db
              .select()
              .from(activities)
              .where(and(eq(activities.accountId, c.var.account.id), inArray(activities.id, chunk)))
              .all(),
          );
          if (found.length < ids.length)
            throw new ApiError(400, "invalid_request", "activityIds: no such activity");
          const other = found.find((a) => !takesCategory(a.kind));
          if (other) throw notSpending(other);
          categorize(db, ids, categoryId);
          return c.json({ count: ids.length });
        },
      )
      // One activity, with 2fiat's original rows (or the user's adjustment) behind it and the findings that point at it.
      .get("/activities/:activityId", (c) => {
        const id = idParam(c, "activityId", "activity");
        const activity = findActivity(id, c.var.account.id);

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
          ...activityDto(activity, annotationOf(id), daysBefore(now().toISOString(), LOOKBACK_DAYS)),
          sources: { transactions, orders, adjustment },
          findingIds,
        });
      })
  );
}
