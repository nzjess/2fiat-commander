import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  CATEGORY_COLORS,
  CATEGORY_NAME_MAX,
  type CategoryRow,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../categories.ts";
import { categories } from "../db/schema.ts";
import { type AppDeps, idParam, invalid, notFound, type UserEnv } from "./common.ts";

const categoryDto = (c: CategoryRow, activityCount: number) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  activityCount,
});

const Name = z.string().trim().min(1).max(CATEGORY_NAME_MAX);
const Color = z.enum(CATEGORY_COLORS);

/** Routes under `/categories`: the user's own, shared by all their accounts. */
export function categoryRoutes(deps: AppDeps) {
  const { db } = deps;
  const find = (id: number, userId: number) => {
    const category = db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, userId)))
      .get();
    if (!category) throw notFound("category");
    return category;
  };
  const count = (id: number, userId: number) =>
    listCategories(db, userId).find((c) => c.id === id)?.activityCount ?? 0;

  return (
    new Hono<UserEnv>()
      // By name, each with how many activities it's on.
      .get("/", (c) => c.json(listCategories(db, c.var.user.id)))
      // Without a colour, it takes the palette's least-used one.
      .post("/", zValidator("json", z.object({ name: Name, color: Color.optional() }), invalid), (c) => {
        const { name, color } = c.req.valid("json");
        return c.json(categoryDto(createCategory(db, c.var.user.id, name, color), 0), 201);
      })
      .patch(
        "/:categoryId",
        zValidator("json", z.object({ name: Name.optional(), color: Color.optional() }), invalid),
        (c) => {
          const category = find(idParam(c, "categoryId", "category"), c.var.user.id);
          const updated = updateCategory(db, category, c.req.valid("json"));
          return c.json(categoryDto(updated, count(updated.id, c.var.user.id)));
        },
      )
      // Its activities go back to uncategorised.
      .delete("/:categoryId", (c) => {
        deleteCategory(db, find(idParam(c, "categoryId", "category"), c.var.user.id).id);
        return c.body(null, 204);
      })
  );
}
