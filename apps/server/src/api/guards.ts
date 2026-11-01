import { and, type Column, eq, inArray } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Access, AccountPermission, CardPermission } from "../access.ts";
import type { Executor } from "../db/db.ts";
import { activities, adjustments, cards, findings, logicalCards } from "../db/schema.ts";
import { type AccountEnv, ApiError, idParam, notFound } from "./common.ts";

// Every route under `/accounts/:accountId` starts with one of these guards, and `test/permissions.test.ts` fails on
// one that doesn't. A card the user can't see is a 404, as if it weren't there; something they can see but may not
// change is a 403.

const GUARD = Symbol("access guard");

type Guard = MiddlewareHandler<AccountEnv>;

const guard = (check: (c: Context<AccountEnv>) => void): Guard => {
  const handler: Guard = async (c, next) => {
    check(c);
    await next();
  };
  return Object.assign(handler, { [GUARD]: true });
};

/** Whether a route handler is one of these guards. */
export const isGuard = (handler: unknown): boolean => typeof handler === "function" && GUARD in handler;

export const forbidden = () => new ApiError(403, "forbidden", "you don't have permission to do this");

/** Throws unless the user may do this on the logical card. */
export function assertOnCard(
  access: Access,
  permission: CardPermission,
  logicalCardId: number,
  what = "logical card",
): void {
  if (!access.canOnCard("card.view", logicalCardId)) throw notFound(what);
  if (!access.canOnCard(permission, logicalCardId)) throw forbidden();
}

/** Limits a query to the logical cards the user can see, given a logical card id column. */
export const visibleLogicalCards = (access: Access, logicalCardId: Column) =>
  access.seesAllCards ? undefined : inArray(logicalCardId, [...access.grantedCardIds]);

/** Limits a query to the cards the user can see, given a physical card id column. */
export const visibleCards = (db: Executor, access: Access, cardId: Column) =>
  access.seesAllCards
    ? undefined
    : inArray(
        cardId,
        db
          .select({ id: cards.id })
          .from(cards)
          .where(inArray(cards.logicalCardId, [...access.grantedCardIds])),
      );

/**
 * Open to anyone with a grant on the account. The handler must limit what it returns to the cards they can see, with
 * `visibleCards` or `visibleLogicalCards`.
 */
export const anyRole: Guard = guard(() => {});

/** Needs a permission only an account role can grant. */
export const requireAccount = (permission: AccountPermission): Guard =>
  guard((c) => {
    if (!c.var.access.can(permission)) throw forbidden();
  });

/**
 * Needs a permission on at least one card. For what is account-wide but open to card roles, or names its cards in
 * the body, where the handler must then check each one.
 */
export const requireAnyCard = (permission: CardPermission): Guard =>
  guard((c) => {
    if (!c.var.access.canOnAnyCard(permission)) throw forbidden();
  });

/** The logical card a physical card of the account belongs to. */
export const logicalCardOfCard = (db: Executor, accountId: number, cardId: number) =>
  db
    .select({ id: cards.logicalCardId })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.accountId, accountId)))
    .get()?.id;

/** Guards for routes naming something in their path: each needs the permission on the logical card it belongs to. */
export function cardGuards(db: Executor) {
  const on = (
    permission: CardPermission,
    what: string,
    find: (c: Context<AccountEnv>, accountId: number) => number | undefined,
  ): Guard =>
    guard((c) => {
      const logicalCardId = find(c, c.var.account.id);
      if (logicalCardId === undefined) throw notFound(what);
      assertOnCard(c.var.access, permission, logicalCardId, what);
    });

  return {
    onLogicalCard: (permission: CardPermission) =>
      on(
        permission,
        "logical card",
        (c, accountId) =>
          db
            .select({ id: logicalCards.id })
            .from(logicalCards)
            .where(
              and(
                eq(logicalCards.id, idParam(c, "logicalCardId", "logical card")),
                eq(logicalCards.accountId, accountId),
              ),
            )
            .get()?.id,
      ),
    onCard: (permission: CardPermission) =>
      on(permission, "card", (c, accountId) =>
        logicalCardOfCard(db, accountId, idParam(c, "cardId", "card")),
      ),
    onActivity: (permission: CardPermission) =>
      on(
        permission,
        "activity",
        (c, accountId) =>
          db
            .select({ id: cards.logicalCardId })
            .from(activities)
            .innerJoin(cards, eq(cards.id, activities.cardId))
            .where(
              and(
                eq(activities.id, idParam(c, "activityId", "activity")),
                eq(activities.accountId, accountId),
              ),
            )
            .get()?.id,
      ),
    onFinding: (permission: CardPermission) =>
      on(
        permission,
        "finding",
        (c, accountId) =>
          db
            .select({ id: cards.logicalCardId })
            .from(findings)
            .innerJoin(cards, eq(cards.id, findings.cardId))
            .where(and(eq(findings.id, idParam(c, "findingId", "finding")), eq(cards.accountId, accountId)))
            .get()?.id,
      ),
    onAdjustment: (permission: CardPermission) =>
      on(
        permission,
        "adjustment",
        (c, accountId) =>
          db
            .select({ id: cards.logicalCardId })
            .from(adjustments)
            .innerJoin(cards, eq(cards.id, adjustments.cardId))
            .where(
              and(
                eq(adjustments.id, idParam(c, "adjustmentId", "adjustment")),
                eq(adjustments.accountId, accountId),
              ),
            )
            .get()?.id,
      ),
  };
}
