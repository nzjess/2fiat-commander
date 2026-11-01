import { merchantKey } from "@twofiat/client";
import { and, asc, count, eq, gt, inArray, isNull, max, ne, or, type SQL, sql } from "drizzle-orm";
import { chunks, type Db, type Executor, IMMEDIATE } from "./db/db.ts";
import { activities, activityAnnotations, categories, categoryRules } from "./db/schema.ts";

/**
 * The category palette, in the order new categories take them. Keys, not colours: the web app maps each to its
 * light and dark steps (the dataviz skill's validated categorical palette).
 */
export const CATEGORY_COLORS = [
  "blue",
  "orange",
  "aqua",
  "yellow",
  "magenta",
  "green",
  "violet",
  "red",
] as const;
export type CategoryColor = (typeof CATEGORY_COLORS)[number];

/** The kinds that are spending, and so take a category. A refund nets against its category. */
export const CATEGORY_KINDS = ["purchase", "refund"] as const;
export const takesCategory = (kind: string) => (CATEGORY_KINDS as readonly string[]).includes(kind);

export const CATEGORY_NAME_MAX = 40;
export const NOTE_MAX = 2000;

export type CategoryRow = typeof categories.$inferSelect;

export class DuplicateCategoryError extends Error {
  constructor(name: string) {
    super(`there's already a category named "${name}"`);
    this.name = "DuplicateCategoryError";
  }
}

/**
 * The account's categories by name, each with how many activities it's on, and how many rules set it (deleting the
 * category deletes them).
 */
export function listCategories(db: Db, accountId: number) {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
      activityCount: count(activityAnnotations.activityId),
      ruleCount: sql<number>`(SELECT count(*) FROM ${categoryRules} WHERE ${categoryRules.categoryId} = ${categories.id})`,
    })
    .from(categories)
    .leftJoin(activityAnnotations, eq(activityAnnotations.categoryId, categories.id))
    .where(eq(categories.accountId, accountId))
    .groupBy(categories.id)
    .orderBy(sql`${categories.name} COLLATE NOCASE`, asc(categories.id))
    .all();
}

/** The palette's least-used colour among the account's categories, earliest in the palette on a tie. */
export function nextColor(db: Db, accountId: number): CategoryColor {
  const used = new Map<string, number>();
  for (const c of db
    .select({ color: categories.color })
    .from(categories)
    .where(eq(categories.accountId, accountId))
    .all())
    used.set(c.color, (used.get(c.color) ?? 0) + 1);
  let best: CategoryColor = CATEGORY_COLORS[0];
  for (const color of CATEGORY_COLORS) if ((used.get(color) ?? 0) < (used.get(best) ?? 0)) best = color;
  return best;
}

/** Names are unique per account, ignoring case. */
function assertNameFree(db: Db, accountId: number, name: string, except?: number) {
  const clash = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.accountId, accountId),
        sql`${categories.name} = ${name} COLLATE NOCASE`,
        except === undefined ? undefined : ne(categories.id, except),
      ),
    )
    .get();
  if (clash) throw new DuplicateCategoryError(name);
}

export function createCategory(db: Db, accountId: number, name: string, color?: CategoryColor): CategoryRow {
  return db.transaction(() => {
    assertNameFree(db, accountId, name);
    return db
      .insert(categories)
      .values({ accountId, name, color: color ?? nextColor(db, accountId) })
      .returning()
      .get();
  }, IMMEDIATE);
}

export function updateCategory(
  db: Db,
  category: CategoryRow,
  changes: { name?: string; color?: CategoryColor },
): CategoryRow {
  return db.transaction(() => {
    if (changes.name !== undefined) assertNameFree(db, category.accountId, changes.name, category.id);
    return (
      db.update(categories).set(changes).where(eq(categories.id, category.id)).returning().get() ?? category
    );
  }, IMMEDIATE);
}

/** Its activities go back to uncategorised, and annotations left with nothing in them go. */
export function deleteCategory(db: Db, categoryId: number): void {
  db.transaction(() => {
    const annotated = db
      .select({ id: activityAnnotations.activityId })
      .from(activityAnnotations)
      .where(eq(activityAnnotations.categoryId, categoryId))
      .all()
      .map((a) => a.id);
    db.delete(categories).where(eq(categories.id, categoryId)).run();
    if (annotated.length > 0) deleteEmpty(db, annotated);
  }, IMMEDIATE);
}

function deleteEmpty(db: Db, activityIds: number[]) {
  db.delete(activityAnnotations)
    .where(
      and(
        inArray(activityAnnotations.activityId, activityIds),
        isNull(activityAnnotations.categoryId),
        isNull(activityAnnotations.note),
      ),
    )
    .run();
}

export interface AnnotationChanges {
  categoryId?: number | null;
  note?: string | null;
}

/**
 * Changes what's given of an activity's category and note, leaving the rest. An annotation left empty is deleted.
 * The caller checks the activity and category belong to the account, and that the activity's kind takes a category.
 */
export function annotate(db: Db, activityId: number, changes: AnnotationChanges): void {
  const set = {
    // The user's own choice: no longer a rule's.
    ...(changes.categoryId !== undefined && { categoryId: changes.categoryId, categoryRuleId: null }),
    ...(changes.note !== undefined && { note: changes.note?.trim() || null }),
    updatedAt: new Date().toISOString(),
  };
  db.transaction(() => {
    db.insert(activityAnnotations)
      .values({ activityId, ...set })
      .onConflictDoUpdate({ target: activityAnnotations.activityId, set })
      .run();
    deleteEmpty(db, [activityId]);
  }, IMMEDIATE);
}

/** Sets one category on many activities, keeping their notes. The caller checks them as for `annotate`. */
export function categorize(db: Db, activityIds: number[], categoryId: number): void {
  const updatedAt = new Date().toISOString();
  db.transaction(() => {
    for (const activityId of activityIds)
      db.insert(activityAnnotations)
        .values({ activityId, categoryId, updatedAt })
        .onConflictDoUpdate({
          target: activityAnnotations.activityId,
          set: { categoryId, categoryRuleId: null, updatedAt },
        })
        .run();
  }, IMMEDIATE);
}

/**
 * The account's uncategorised spending (`CATEGORY_KINDS`) from the same merchant as the description (see
 * `merchantKey`), newest first, leaving out `exceptId`.
 */
export function sameMerchant(
  db: Db,
  accountId: number,
  description: string,
  exceptId?: number,
  /** A further limit on the activities, such as to the cards a user can see. */
  only?: SQL,
) {
  const key = merchantKey(description);
  if (!key) return [];
  return db
    .select({ id: activities.id, description: activities.description })
    .from(activities)
    .leftJoin(activityAnnotations, eq(activityAnnotations.activityId, activities.id))
    .where(
      and(
        eq(activities.accountId, accountId),
        inArray(activities.kind, [...CATEGORY_KINDS]),
        or(isNull(activityAnnotations.activityId), isNull(activityAnnotations.categoryId)),
        exceptId === undefined ? undefined : ne(activities.id, exceptId),
        only,
      ),
    )
    .orderBy(sql`${activities.occurredAt} DESC`, sql`${activities.id} DESC`)
    .all()
    .filter((a) => merchantKey(a.description) === key)
    .map((a) => a.id);
}

// Rules: each sets a category on uncategorised spending that matches it. They run on a sync's new activities (the
// first match wins), and on existing ones only when the user asks. They never replace a category already set.

export const RULE_MATCHES = ["merchant", "contains"] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];
export type RuleRow = typeof categoryRules.$inferSelect;
type RuleCondition = Pick<RuleRow, "match" | "pattern">;
type Described = { description: string; postedDescription: string | null };

export class DuplicateRuleError extends Error {
  constructor() {
    super("there's already a rule for that");
    this.name = "DuplicateRuleError";
  }
}

/** What a rule stores for what was entered: a merchant's `merchantKey`, or the text in lower case. */
export function rulePattern(match: RuleMatch, input: string): string {
  return match === "merchant" ? merchantKey(input) : input.trim().toLowerCase();
}

export function ruleMatches(rule: RuleCondition, activity: Described): boolean {
  if (rule.match === "merchant") return merchantKey(activity.description) === rule.pattern;
  return [activity.description, activity.postedDescription].some((d) =>
    d?.toLowerCase().includes(rule.pattern),
  );
}

/** The account's rules in order, each with how many activities it has set. */
export function listRules(db: Db, accountId: number) {
  return db
    .select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      match: categoryRules.match,
      pattern: categoryRules.pattern,
      position: categoryRules.position,
      activityCount: count(activityAnnotations.activityId),
    })
    .from(categoryRules)
    .leftJoin(activityAnnotations, eq(activityAnnotations.categoryRuleId, categoryRules.id))
    .where(eq(categoryRules.accountId, accountId))
    .groupBy(categoryRules.id)
    .orderBy(asc(categoryRules.position), asc(categoryRules.id))
    .all();
}

function assertRuleFree(db: Db, accountId: number, rule: RuleCondition, except?: number) {
  const clash = db
    .select({ id: categoryRules.id })
    .from(categoryRules)
    .where(
      and(
        eq(categoryRules.accountId, accountId),
        eq(categoryRules.match, rule.match),
        eq(categoryRules.pattern, rule.pattern),
        except === undefined ? undefined : ne(categoryRules.id, except),
      ),
    )
    .get();
  if (clash) throw new DuplicateRuleError();
}

/** A new rule, last in the order. The caller checks the category is the account's and the pattern isn't empty. */
export function createRule(db: Db, accountId: number, rule: RuleCondition & { categoryId: number }): RuleRow {
  return db.transaction(() => {
    assertRuleFree(db, accountId, rule);
    const last = db
      .select({ position: max(categoryRules.position) })
      .from(categoryRules)
      .where(eq(categoryRules.accountId, accountId))
      .get()?.position;
    return db
      .insert(categoryRules)
      .values({ accountId, ...rule, position: (last ?? -1) + 1 })
      .returning()
      .get();
  }, IMMEDIATE);
}

/**
 * Changes a rule. With `move`, the activities it set follow it to its new category; otherwise they keep theirs and
 * are no longer marked as its.
 */
export function updateRule(
  db: Db,
  rule: RuleRow,
  changes: Partial<RuleCondition> & { categoryId?: number },
  { move = false }: { move?: boolean } = {},
): RuleRow {
  return db.transaction(() => {
    const next = { ...rule, ...changes };
    assertRuleFree(db, rule.accountId, next, rule.id);
    if (next.categoryId !== rule.categoryId) {
      db.update(activityAnnotations)
        .set(move ? { categoryId: next.categoryId } : { categoryRuleId: null })
        .where(eq(activityAnnotations.categoryRuleId, rule.id))
        .run();
    }
    return (
      db.update(categoryRules).set(changes).where(eq(categoryRules.id, rule.id)).returning().get() ?? rule
    );
  }, IMMEDIATE);
}

/** Deletes a rule. The categories it set stay, unless `clear`, which makes those activities uncategorised again. */
export function deleteRule(db: Db, ruleId: number, { clear = false }: { clear?: boolean } = {}): void {
  db.transaction(() => {
    if (clear) {
      const set = db
        .select({ id: activityAnnotations.activityId })
        .from(activityAnnotations)
        .where(eq(activityAnnotations.categoryRuleId, ruleId))
        .all()
        .map((a) => a.id);
      db.update(activityAnnotations)
        .set({ categoryId: null, categoryRuleId: null })
        .where(eq(activityAnnotations.categoryRuleId, ruleId))
        .run();
      for (const chunk of chunks(set)) deleteEmpty(db, chunk);
    }
    db.delete(categoryRules).where(eq(categoryRules.id, ruleId)).run();
  }, IMMEDIATE);
}

/** Puts the account's rules in the given order, which must name each of them once. Returns false if it doesn't. */
export function reorderRules(db: Db, accountId: number, ids: number[]): boolean {
  return db.transaction(() => {
    const mine = db
      .select({ id: categoryRules.id })
      .from(categoryRules)
      .where(eq(categoryRules.accountId, accountId))
      .all()
      .map((r) => r.id);
    if (
      ids.length !== mine.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => mine.includes(id))
    )
      return false;
    ids.forEach((id, position) => {
      db.update(categoryRules).set({ position }).where(eq(categoryRules.id, id)).run();
    });
    return true;
  }, IMMEDIATE);
}

/** An account's uncategorised spending, or only what's after `afterId` (a sync's new ones). */
function uncategorized(q: Executor, accountId: number, afterId?: number) {
  return q
    .select({
      id: activities.id,
      description: activities.description,
      postedDescription: activities.postedDescription,
    })
    .from(activities)
    .leftJoin(activityAnnotations, eq(activityAnnotations.activityId, activities.id))
    .where(
      and(
        eq(activities.accountId, accountId),
        afterId === undefined ? undefined : gt(activities.id, afterId),
        inArray(activities.kind, [...CATEGORY_KINDS]),
        isNull(activityAnnotations.categoryId),
      ),
    )
    .all();
}

/**
 * Sets a rule's category on activities, as that rule's, wherever no category has been set meanwhile. Returns how
 * many it set.
 */
function setByRule(q: Executor, activityIds: number[], rule: Pick<RuleRow, "id" | "categoryId">): number {
  const updatedAt = new Date().toISOString();
  const set = { categoryId: rule.categoryId, categoryRuleId: rule.id, updatedAt };
  let changed = 0;
  for (const activityId of activityIds)
    changed += q
      .insert(activityAnnotations)
      .values({ activityId, ...set })
      .onConflictDoUpdate({
        target: activityAnnotations.activityId,
        set,
        setWhere: isNull(activityAnnotations.categoryId),
      })
      .run().changes;
  return changed;
}

/** The account's uncategorised spending that a rule (saved or not) would categorise. */
export function ruleCandidates(db: Db, accountId: number, rule: RuleCondition): number[] {
  return uncategorized(db, accountId)
    .filter((a) => ruleMatches(rule, a))
    .map((a) => a.id);
}

/** Applies a rule to its account's existing uncategorised spending that it matches. Returns how many. */
export function applyRule(db: Db, rule: RuleRow): number {
  return db.transaction(() => {
    return setByRule(db, ruleCandidates(db, rule.accountId, rule), rule);
  }, IMMEDIATE);
}

/** The newest activity id, so a sync can tell the activities its normalisation adds: they get higher ids. */
export function lastActivityId(q: Executor): number {
  return (
    q
      .select({ id: max(activities.id) })
      .from(activities)
      .get()?.id ?? 0
  );
}

/**
 * Categorises a sync's new spending in an account (ids after `afterId`) by the account's rules, the first match
 * winning, in the caller's transaction. Returns how many it set.
 */
export function applyRulesIn(q: Executor, accountId: number, afterId: number): number {
  const rules = q
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.accountId, accountId))
    .orderBy(asc(categoryRules.position), asc(categoryRules.id))
    .all();
  if (rules.length === 0) return 0;
  const byRule = new Map<RuleRow, number[]>();
  for (const a of uncategorized(q, accountId, afterId)) {
    const rule = rules.find((r) => ruleMatches(r, a));
    if (rule) byRule.set(rule, [...(byRule.get(rule) ?? []), a.id]);
  }
  let set = 0;
  for (const [rule, ids] of byRule) set += setByRule(q, ids, rule);
  return set;
}

/**
 * Copies an account's categories and rules onto another, in the caller's transaction: a one-time copy with no link
 * left between them. What's categorised stays behind, since activities belong to their account.
 */
export function copyCategoriesIn(q: Executor, fromAccountId: number, toAccountId: number): void {
  const copied = new Map<number, number>();
  for (const { id, name, color } of q
    .select()
    .from(categories)
    .where(eq(categories.accountId, fromAccountId))
    .all()) {
    const copy = q
      .insert(categories)
      .values({ accountId: toAccountId, name, color })
      .returning({ id: categories.id })
      .get();
    copied.set(id, copy.id);
  }
  for (const { categoryId, match, pattern, position } of q
    .select()
    .from(categoryRules)
    .where(eq(categoryRules.accountId, fromAccountId))
    .all()) {
    q.insert(categoryRules)
      .values({
        accountId: toAccountId,
        categoryId: copied.get(categoryId) as number,
        match,
        pattern,
        position,
      })
      .run();
  }
}
