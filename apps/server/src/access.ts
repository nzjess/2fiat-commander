import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "./db/db.ts";
import { accounts, grants } from "./db/schema.ts";

/** Actions on the account as a whole: only a grant on the whole account can allow them. */
export const ACCOUNT_PERMISSIONS = [
  "account.view",
  "grants.manage",
  "account.replace",
  "account.rename",
  "cards.rename",
  "cards.link",
  "fees.edit",
  "categories.manage",
] as const;
export type AccountPermission = (typeof ACCOUNT_PERMISSIONS)[number];

/** Actions on one card: a grant on the whole account allows them on every card, a grant on a card on that card. */
export const CARD_PERMISSIONS = [
  "card.view",
  "card.annotate",
  "card.explain",
  "card.adjust",
  "card.openingBalance",
  "card.setCurrent",
  "card.sync",
] as const;
export type CardPermission = (typeof CARD_PERMISSIONS)[number];

/** A role is a named group of actions. Where it applies comes from the grant, and each action's kind limits it. */
const ROLE_PERMISSIONS = {
  owner: [...ACCOUNT_PERMISSIONS, ...CARD_PERMISSIONS],
  manager: ["account.view", "fees.edit", "categories.manage", ...CARD_PERMISSIONS],
  member: ["account.view", "card.view"],
} as const satisfies Record<string, readonly (AccountPermission | CardPermission)[]>;

export type Role = keyof typeof ROLE_PERMISSIONS;
export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

/** A grant of a role, on the whole account when `logicalCardId` is null, otherwise on that card. */
export interface Grant {
  logicalCardId: number | null;
  role: Role;
}

/**
 * What one user may do on one account: the union of their grants on it. Grants don't exclude each other, so an
 * account member who manages one card can change that card and only see the rest.
 */
export interface Access {
  /** Their role on the whole account, if they have one. */
  accountRole: Role | null;
  /** Sees every card, so also account-wide figures. Only a grant on the whole account does. */
  seesAllCards: boolean;
  /** The logical cards they hold a grant on: with `seesAllCards` false, all they can see. */
  grantedCardIds: readonly number[];
  can(permission: AccountPermission): boolean;
  canOnCard(permission: CardPermission, logicalCardId: number): boolean;
  /** For what is account-wide but open to grants on a card, such as starting a sync. */
  canOnAnyCard(permission: CardPermission): boolean;
}

/** Works out a user's access from their grants. Nothing is stored, so a change of grant applies straight away. */
export function resolveAccess(userGrants: readonly Grant[]): Access {
  const allows = ({ role }: Grant, permission: AccountPermission | CardPermission) =>
    (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
  const onAccount = userGrants.filter((g) => g.logicalCardId === null);
  return {
    accountRole: onAccount[0]?.role ?? null,
    seesAllCards: onAccount.length > 0,
    grantedCardIds: userGrants.flatMap((g) => (g.logicalCardId === null ? [] : [g.logicalCardId])),
    can: (permission) => onAccount.some((g) => allows(g, permission)),
    canOnCard: (permission, logicalCardId) =>
      userGrants.some(
        (g) => (g.logicalCardId === null || g.logicalCardId === logicalCardId) && allows(g, permission),
      ),
    canOnAnyCard: (permission) => userGrants.some((g) => allows(g, permission)),
  };
}

/**
 * The user's access to an account, or undefined when they hold no grant on it. A role this code doesn't know, as in
 * a database from a later version, grants nothing.
 */
export function loadAccess(db: Executor, accountId: number, userId: number): Access | undefined {
  const userGrants = db
    .select({ logicalCardId: grants.logicalCardId, role: grants.role })
    .from(grants)
    .where(and(eq(grants.accountId, accountId), eq(grants.userId, userId), inArray(grants.role, ROLES)))
    .all();
  return userGrants.length === 0 ? undefined : resolveAccess(userGrants);
}

/** The accounts a user holds any grant on, whole or on one of its cards. */
export function accountsOfUser(db: Executor, userId: number) {
  return db
    .select()
    .from(accounts)
    .where(
      inArray(
        accounts.id,
        db
          .select({ id: grants.accountId })
          .from(grants)
          .where(and(eq(grants.userId, userId), inArray(grants.role, ROLES))),
      ),
    )
    .orderBy(accounts.id)
    .all();
}

/** Copies the grants on the whole of `fromAccountId` to `toAccountId`. Grants on a card stay with the old cards. */
export function copyAccountGrantsIn(q: Executor, fromAccountId: number, toAccountId: number): void {
  const onAccount = q
    .select()
    .from(grants)
    .where(and(eq(grants.accountId, fromAccountId), isNull(grants.logicalCardId)))
    .all();
  if (onAccount.length === 0) return;
  q.insert(grants)
    .values(onAccount.map(({ userId, role }) => ({ accountId: toAccountId, userId, role })))
    .run();
}
