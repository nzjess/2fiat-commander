import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ROLES, type Role } from "../access.ts";
import { logicalCards } from "../db/schema.ts";
import {
  createGrant,
  deleteGrant,
  leaveAccount,
  listGrants,
  ownsAllGrantsOf,
  updateGrantRole,
} from "../grants.ts";
import { createInvite, renewInvite } from "../invites.ts";
import { type AccountEnv, ApiError, type AppDeps, idParam, invalid, notFound, Username } from "./common.ts";
import { anyRole, requireAccount } from "./guards.ts";

const RoleName = z.enum(ROLES);
const NewGrant = z.object({
  username: Username,
  logicalCardId: z.number().int().positive().nullable(),
  role: RoleName,
});

const notOwnerOfACard = (role: Role, logicalCardId: number | null) => {
  if (role === "owner" && logicalCardId !== null) {
    throw new ApiError(400, "invalid_request", "role: owner only applies to the whole account");
  }
};

/** Routes under `/accounts/:accountId/grants`: who has which role on the account and its cards. */
export function grantRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Refuses a grant that can't be given: the checks that adding someone and inviting them share. */
  const checkPlace = (accountId: number, { role, logicalCardId }: z.infer<typeof NewGrant>) => {
    notOwnerOfACard(role, logicalCardId);
    if (logicalCardId === null) return;
    const card = db
      .select({ id: logicalCards.id })
      .from(logicalCards)
      .where(and(eq(logicalCards.id, logicalCardId), eq(logicalCards.accountId, accountId)))
      .get();
    if (!card) throw new ApiError(400, "invalid_request", "logicalCardId: no such card");
  };

  /** The account's grants, each saying whether this owner could make a new invite link for its user. */
  const grantDtos = (accountId: number, actorId: number) =>
    listGrants(db, accountId).map((g) => ({
      ...g,
      canMakeLink: g.pending && ownsAllGrantsOf(db, actorId, g.userId),
    }));
  const dto = (accountId: number, actorId: number, id: number) =>
    grantDtos(accountId, actorId).find((g) => g.id === id);

  return (
    new Hono<AccountEnv>()
      .get("/grants", requireAccount("grants.manage"), (c) =>
        c.json(grantDtos(c.var.account.id, c.var.user.id)),
      )
      // Gives an existing user a role on the whole account, or with `logicalCardId` on that card. Their other grants
      // stay as they are.
      .post("/grants", requireAccount("grants.manage"), zValidator("json", NewGrant, invalid), (c) => {
        const input = c.req.valid("json");
        const accountId = c.var.account.id;
        checkPlace(accountId, input);
        const grant = createGrant(db, accountId, c.var.user.id, input);
        return c.json(dto(accountId, c.var.user.id, grant.id), 201);
      })
      // Creates a user with no password and this one grant. The token is only ever in this response: the web app turns
      // it into the link the owner shares.
      .post("/invites", requireAccount("grants.manage"), zValidator("json", NewGrant, invalid), (c) => {
        const input = c.req.valid("json");
        const accountId = c.var.account.id;
        checkPlace(accountId, input);
        const { grantId, token, expiresAt } = createInvite(db, accountId, input, now());
        return c.json({ grant: dto(accountId, c.var.user.id, grantId), token, expiresAt }, 201);
      })
      // A new link for someone who hasn't used theirs. The old one stops working.
      .post("/invites/:userId", requireAccount("grants.manage"), (c) => {
        const userId = idParam(c, "userId", "user");
        const link = renewInvite(db, c.var.account.id, c.var.user.id, userId, now());
        if (!link) throw notFound("user");
        return c.json(link);
      })
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
          return c.json(dto(accountId, c.var.user.id, id));
        },
      )
      .delete("/grants/:grantId", requireAccount("grants.manage"), (c) => {
        if (!deleteGrant(db, c.var.account.id, idParam(c, "grantId", "grant"))) throw notFound("grant");
        return c.body(null, 204);
      })
  );
}
