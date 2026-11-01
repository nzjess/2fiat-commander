import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  applyRule,
  CATEGORY_COLORS,
  CATEGORY_NAME_MAX,
  type CategoryRow,
  createCategory,
  createRule,
  deleteCategory,
  deleteRule,
  listCategories,
  listRules,
  RULE_MATCHES,
  type RuleMatch,
  reorderRules,
  ruleCandidates,
  rulePattern,
  updateCategory,
  updateRule,
} from "../categories.ts";
import { categories, categoryRules } from "../db/schema.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";
import { anyRole, requireAccount } from "./guards.ts";

const categoryDto = (c: CategoryRow, counts: { activityCount: number; ruleCount: number }) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  ...counts,
});

const Name = z.string().trim().min(1).max(CATEGORY_NAME_MAX);
const Color = z.enum(CATEGORY_COLORS);
const Match = z.enum(RULE_MATCHES);
/** What the user entered: a merchant rule takes a description, and keeps its merchant. */
const Pattern = z.string().trim().min(1).max(200);

/** Routes under `/accounts/:accountId/categories`: each account has its own. */
export function categoryRoutes(deps: AppDeps) {
  const { db } = deps;
  const find = (id: number, accountId: number) => {
    const category = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.accountId, accountId)))
      .get();
    if (!category) throw notFound("category");
    return category;
  };
  const counts = (id: number, accountId: number) => {
    const listed = listCategories(db, accountId).find((c) => c.id === id);
    return { activityCount: listed?.activityCount ?? 0, ruleCount: listed?.ruleCount ?? 0 };
  };
  const findRule = (id: number, accountId: number) => {
    const rule = db
      .select()
      .from(categoryRules)
      .where(and(eq(categoryRules.id, id), eq(categoryRules.accountId, accountId)))
      .get();
    if (!rule) throw notFound("rule");
    return rule;
  };
  /** A category of the account's named in a body: any other is a 400. */
  const assertCategory = (categoryId: number, accountId: number) => {
    if (
      !db
        .select()
        .from(categories)
        .where(and(eq(categories.id, categoryId), eq(categories.accountId, accountId)))
        .get()
    )
      throw new ApiError(400, "invalid_request", "categoryId: no such category");
  };
  /** The stored pattern, which mustn't come out empty (a merchant of only digits, say). */
  const pattern = (match: RuleMatch, input: string) => {
    const stored = rulePattern(match, input);
    if (!stored) throw new ApiError(400, "invalid_request", "pattern: nothing left to match on");
    return stored;
  };
  const ruleDto = (id: number, accountId: number) => listRules(db, accountId).find((r) => r.id === id);

  return (
    new Hono<AccountEnv>()
      // Category rules, in order, each with how many activities it set.
      .get("/categories/rules", requireAccount("account.view"), (c) =>
        c.json(listRules(db, c.var.account.id)),
      )
      .post(
        "/categories/rules",
        requireAccount("categories.manage"),
        zValidator(
          "json",
          z.object({ categoryId: z.number().int().positive(), match: Match, pattern: Pattern }),
          invalid,
        ),
        (c) => {
          const body = c.req.valid("json");
          assertCategory(body.categoryId, c.var.account.id);
          const rule = createRule(db, c.var.account.id, {
            ...body,
            pattern: pattern(body.match, body.pattern),
          });
          return c.json(ruleDto(rule.id, c.var.account.id), 201);
        },
      )
      // How much existing uncategorised spending a rule not yet saved would categorise.
      .get(
        "/categories/rules/preview",
        requireAccount("account.view"),
        zValidator("query", z.object({ match: Match, pattern: Pattern }), invalid),
        (c) => {
          const { match, pattern: input } = c.req.valid("query");
          const stored = rulePattern(match, input);
          return c.json({
            count: stored ? ruleCandidates(db, c.var.account.id, { match, pattern: stored }).length : 0,
          });
        },
      )
      // Each rule id once, in the new order.
      .put(
        "/categories/rules/order",
        requireAccount("categories.manage"),
        zValidator("json", z.object({ ids: z.array(z.number().int().positive()) }), invalid),
        (c) => {
          if (!reorderRules(db, c.var.account.id, c.req.valid("json").ids))
            throw new ApiError(400, "invalid_request", "ids: not each of the account's rules once");
          return c.body(null, 204);
        },
      )
      .get("/categories/rules/:ruleId/matches", requireAccount("account.view"), (c) => {
        const rule = findRule(idParam(c, "ruleId", "rule"), c.var.account.id);
        return c.json({ count: ruleCandidates(db, c.var.account.id, rule).length });
      })
      // Sets the rule's category on the account's existing uncategorised spending that it matches.
      .post("/categories/rules/:ruleId/apply", requireAccount("categories.manage"), (c) => {
        const rule = findRule(idParam(c, "ruleId", "rule"), c.var.account.id);
        return c.json({ count: applyRule(db, rule) });
      })
      // With `move`, the activities the rule set follow it to a new category.
      .patch(
        "/categories/rules/:ruleId",
        requireAccount("categories.manage"),
        zValidator(
          "json",
          z.object({
            categoryId: z.number().int().positive().optional(),
            match: Match.optional(),
            pattern: Pattern.optional(),
            move: z.boolean().optional(),
          }),
          invalid,
        ),
        (c) => {
          const rule = findRule(idParam(c, "ruleId", "rule"), c.var.account.id);
          const { move, ...body } = c.req.valid("json");
          if (body.categoryId !== undefined) assertCategory(body.categoryId, c.var.account.id);
          const match = body.match ?? rule.match;
          const changes = {
            ...(body.categoryId !== undefined && { categoryId: body.categoryId }),
            ...(body.match !== undefined && { match }),
            ...((body.pattern !== undefined || body.match !== undefined) && {
              pattern: pattern(match, body.pattern ?? rule.pattern),
            }),
          };
          updateRule(db, rule, changes, { move });
          return c.json(ruleDto(rule.id, c.var.account.id));
        },
      )
      // With `clear=true`, the categories it set are cleared too; otherwise they stay.
      .delete(
        "/categories/rules/:ruleId",
        requireAccount("categories.manage"),
        zValidator("query", z.object({ clear: z.enum(["true", "false"]).optional() }), invalid),
        (c) => {
          const rule = findRule(idParam(c, "ruleId", "rule"), c.var.account.id);
          deleteRule(db, rule.id, { clear: c.req.valid("query").clear === "true" });
          return c.body(null, 204);
        },
      )
      // By name, each with how many activities it's on.
      .get("/categories", anyRole, (c) =>
        c.json(
          listCategories(db, c.var.account.id).map(({ activityCount, ruleCount, ...category }) => ({
            ...category,
            // They count across the whole account, so only someone who sees every card gets them.
            activityCount: c.var.access.seesAllCards ? activityCount : null,
            ruleCount: c.var.access.seesAllCards ? ruleCount : null,
          })),
        ),
      )
      // Without a colour, it takes the palette's least-used one.
      .post(
        "/categories",
        requireAccount("categories.manage"),
        zValidator("json", z.object({ name: Name, color: Color.optional() }), invalid),
        (c) => {
          const { name, color } = c.req.valid("json");
          return c.json(
            categoryDto(createCategory(db, c.var.account.id, name, color), {
              activityCount: 0,
              ruleCount: 0,
            }),
            201,
          );
        },
      )
      .patch(
        "/categories/:categoryId",
        requireAccount("categories.manage"),
        zValidator("json", z.object({ name: Name.optional(), color: Color.optional() }), invalid),
        (c) => {
          const category = find(idParam(c, "categoryId", "category"), c.var.account.id);
          const updated = updateCategory(db, category, c.req.valid("json"));
          return c.json(categoryDto(updated, counts(updated.id, c.var.account.id)));
        },
      )
      // Its activities go back to uncategorised.
      .delete("/categories/:categoryId", requireAccount("categories.manage"), (c) => {
        deleteCategory(db, find(idParam(c, "categoryId", "category"), c.var.account.id).id);
        return c.body(null, 204);
      })
  );
}
