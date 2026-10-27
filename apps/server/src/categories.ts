import { merchantKey } from "@twofiat/client";
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { type Db, IMMEDIATE } from "./db/db.ts";
import { activities, activityAnnotations, categories } from "./db/schema.ts";

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

/** The user's categories by name, each with how many activities (in all their accounts) it's on. */
export function listCategories(db: Db, userId: number) {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
      activityCount: count(activityAnnotations.activityId),
    })
    .from(categories)
    .leftJoin(activityAnnotations, eq(activityAnnotations.categoryId, categories.id))
    .where(eq(categories.userId, userId))
    .groupBy(categories.id)
    .orderBy(sql`${categories.name} COLLATE NOCASE`, asc(categories.id))
    .all();
}

/** The palette's least-used colour among the user's categories, earliest in the palette on a tie. */
export function nextColor(db: Db, userId: number): CategoryColor {
  const used = new Map<string, number>();
  for (const c of db
    .select({ color: categories.color })
    .from(categories)
    .where(eq(categories.userId, userId))
    .all())
    used.set(c.color, (used.get(c.color) ?? 0) + 1);
  let best: CategoryColor = CATEGORY_COLORS[0];
  for (const color of CATEGORY_COLORS) if ((used.get(color) ?? 0) < (used.get(best) ?? 0)) best = color;
  return best;
}

/** Names are unique per user, ignoring case. */
function assertNameFree(db: Db, userId: number, name: string, except?: number) {
  const clash = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        sql`${categories.name} = ${name} COLLATE NOCASE`,
        except === undefined ? undefined : ne(categories.id, except),
      ),
    )
    .get();
  if (clash) throw new DuplicateCategoryError(name);
}

export function createCategory(db: Db, userId: number, name: string, color?: CategoryColor): CategoryRow {
  return db.transaction(() => {
    assertNameFree(db, userId, name);
    return db
      .insert(categories)
      .values({ userId, name, color: color ?? nextColor(db, userId) })
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
    if (changes.name !== undefined) assertNameFree(db, category.userId, changes.name, category.id);
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
 * The caller checks the activity and category belong to the user, and that the activity's kind takes a category.
 */
export function annotate(db: Db, activityId: number, changes: AnnotationChanges): void {
  const set = {
    ...(changes.categoryId !== undefined && { categoryId: changes.categoryId }),
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
        .onConflictDoUpdate({ target: activityAnnotations.activityId, set: { categoryId, updatedAt } })
        .run();
  }, IMMEDIATE);
}

/**
 * The account's uncategorised spending (`CATEGORY_KINDS`) from the same merchant as the description (see
 * `merchantKey`), newest first, leaving out `exceptId`.
 */
export function sameMerchant(db: Db, accountId: number, description: string, exceptId?: number) {
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
      ),
    )
    .orderBy(sql`${activities.occurredAt} DESC`, sql`${activities.id} DESC`)
    .all()
    .filter((a) => merchantKey(a.description) === key)
    .map((a) => a.id);
}
