import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ROLES, type Role } from "../access.ts";
import { logicalCards } from "../db/schema.ts";
import { createGrant, deleteGrant, leaveAccount, listGrants, updateGrantRole } from "../grants.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound } from "./common.ts";
import { anyRole, requireAccount } from "./guards.ts";

const RoleName = z.enum(ROLES);

const notOwnerOfACard = (role: Role, logicalCardId: number | null) => {
  if (role === "owner" && logicalCardId !== null) {
    throw new ApiError(400, "invalid_request", "role: owner only applies to the whole account");
  }
};

/** Routes under `/accounts/:accountId/grants`: who has which role on the account and its cards. */
export function grantRoutes(deps: AppDeps) {
  const { db } = deps;

  const dto = (accountId: number, id: number) => listGrants(db, accountId).find((g) => g.id === id);

  return (
    new Hono<AccountEnv>()
      .get("/grants", requireAccount("grants.manage"), (c) => c.json(listGrants(db, c.var.account.id)))
      // Gives an existing user a role on the whole account, or with `logicalCardId` on that card. Their other grants
      // stay as they are.
      .post(
        "/grants",
        requireAccount("grants.manage"),
        zValidator(
          "json",
          z.object({
            username: z.string().trim().min(1),
            logicalCardId: z.number().int().positive().nullable(),
            role: RoleName,
          }),
          invalid,
        ),
        (c) => {
          const input = c.req.valid("json");
          const accountId = c.var.account.id;
          notOwnerOfACard(input.role, input.logicalCardId);
          if (input.logicalCardId !== null) {
            const card = db
              .select({ id: logicalCards.id })
              .from(logicalCards)
              .where(and(eq(logicalCards.id, input.logicalCardId), eq(logicalCards.accountId, accountId)))
              .get();
            if (!card) throw new ApiError(400, "invalid_request", "logicalCardId: no such card");
          }
          const grant = createGrant(db, accountId, input);
          return c.json(dto(accountId, grant.id), 201);
        },
      )
      // The user leaves the account, giving up all their grants on it. Before `:grantId`, which it would match.
      .delete("/grants/mine", anyRole, (c) => {
        leaveAccount(db, c.var.account.id, c.var.user.id);
        return c.body(null, 204);
      })
      .patch(
        "/grants/:grantId",
        requireAccount("grants.manage"),
        zValidator("json", z.object({ role: RoleName }), invalid),
        (c) => {
          const accountId = c.var.account.id;
          const id = idParam(c, "grantId", "grant");
          const { role } = c.req.valid("json");
          const current = listGrants(db, accountId).find((g) => g.id === id);
          if (!current) throw notFound("grant");
          notOwnerOfACard(role, current.logicalCardId);
          updateGrantRole(db, accountId, id, role);
          return c.json(dto(accountId, id));
        },
      )
      .delete("/grants/:grantId", requireAccount("grants.manage"), (c) => {
        if (!deleteGrant(db, c.var.account.id, idParam(c, "grantId", "grant"))) throw notFound("grant");
        return c.body(null, 204);
      })
  );
}
