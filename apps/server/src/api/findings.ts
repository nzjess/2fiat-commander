import { zValidator } from "@hono/zod-validator";
import { and, type Column, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { cards, findings } from "../db/schema.ts";
import { type AccountEnv, type AppDeps, idParam, invalid, notFound } from "./common.ts";

const asOf = (evaluationId: Column) =>
  sql<string | null>`(SELECT as_of FROM evaluations WHERE id = ${evaluationId})`;

/** Findings with the times of the evaluations that first saw, last saw and resolved them. */
function selectFindings(db: Db) {
  return db
    .select({
      id: findings.id,
      cardId: findings.cardId,
      kind: findings.kind,
      cents: findings.cents,
      message: findings.message,
      activityIds: findings.activityIds,
      firstSeenEvaluationId: findings.firstSeenEvaluationId,
      firstSeenAt: asOf(findings.firstSeenEvaluationId).mapWith(String),
      lastSeenEvaluationId: findings.lastSeenEvaluationId,
      lastSeenAt: asOf(findings.lastSeenEvaluationId).mapWith(String),
      resolvedEvaluationId: findings.resolvedEvaluationId,
      resolvedAt: asOf(findings.resolvedEvaluationId),
      explainedAt: findings.explainedAt,
      explanation: findings.explanation,
    })
    .from(findings)
    .innerJoin(cards, eq(cards.id, findings.cardId));
}

const ListQuery = z.object({
  /** Open findings (the default) are the ones the latest evaluation still saw. Explained ones are open too. */
  status: z.enum(["open", "resolved", "all"]).default("open"),
  cardId: z.coerce.number().int().positive().optional(),
  /** Comma-separated. */
  kind: z
    .string()
    .transform((v) =>
      v
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .optional(),
});

/** Routes under `/accounts/:accountId` for reconciliation findings. */
export function findingRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const findingOf = (accountId: number, id: number) => {
    const finding = selectFindings(db)
      .where(and(eq(findings.id, id), eq(cards.accountId, accountId)))
      .get();
    if (!finding) throw notFound("finding");
    return finding;
  };

  return (
    new Hono<AccountEnv>()
      // Most recently seen first.
      .get("/findings", zValidator("query", ListQuery, invalid), (c) => {
        const { status, cardId, kind } = c.req.valid("query");
        return c.json(
          selectFindings(db)
            .where(
              and(
                eq(cards.accountId, c.var.account.id),
                status === "open" ? isNull(findings.resolvedEvaluationId) : undefined,
                status === "resolved" ? isNotNull(findings.resolvedEvaluationId) : undefined,
                cardId === undefined ? undefined : eq(findings.cardId, cardId),
                kind?.length
                  ? inArray(findings.kind, kind as (typeof findings.$inferSelect)["kind"][])
                  : undefined,
              ),
            )
            .orderBy(desc(findings.lastSeenEvaluationId), desc(findings.id))
            .all(),
        );
      })
      .get("/findings/:findingId", (c) =>
        c.json(findingOf(c.var.account.id, idParam(c, "findingId", "finding"))),
      )
      // Marks a finding explained, with the user's explanation, or with null not explained again.
      .patch(
        "/findings/:findingId",
        zValidator("json", z.object({ explanation: z.string().trim().min(1).max(2000).nullable() }), invalid),
        (c) => {
          const finding = findingOf(c.var.account.id, idParam(c, "findingId", "finding"));
          const { explanation } = c.req.valid("json");
          db.update(findings)
            .set({ explanation, explainedAt: explanation === null ? null : now().toISOString() })
            .where(eq(findings.id, finding.id))
            .run();
          return c.json(findingOf(c.var.account.id, finding.id));
        },
      )
  );
}
