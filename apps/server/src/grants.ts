import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { loadAccess, ROLES, type Role } from "./access.ts";
import { usernameIs } from "./auth.ts";
import type { Db, Executor } from "./db/db.ts";
import { grants, users } from "./db/schema.ts";

// Granting never looks at a user's other grants: what they may do is worked out from whatever they hold (see
// `access.ts`). The one limit is on the account, which must always keep an owner.

export type GrantRow = typeof grants.$inferSelect;

export class UnknownUserError extends Error {
  constructor(username: string) {
    super(`there's no user named ${username}`);
    this.name = "UnknownUserError";
  }
}

export class DuplicateGrantError extends Error {
  constructor() {
    super("this user already has a role here: change it instead");
    this.name = "DuplicateGrantError";
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super("an account must keep at least one owner who has set a password");
    this.name = "LastOwnerError";
  }
}

/** The account's grants with their usernames: the whole account's first, then by card, then by username. */
export function listGrants(db: Executor, accountId: number) {
  return db
    .select({
      id: grants.id,
      userId: grants.userId,
      username: users.username,
      /** Invited, and hasn't set a password yet. */
      pending: sql<boolean>`${users.passwordHash} IS NULL`.mapWith(Boolean),
      logicalCardId: grants.logicalCardId,
      role: grants.role,
      createdAt: grants.createdAt,
    })
    .from(grants)
    .innerJoin(users, eq(users.id, grants.userId))
    .where(eq(grants.accountId, accountId))
    .orderBy(asc(grants.logicalCardId), sql`${users.username} COLLATE NOCASE`)
    .all();
}

/**
 * Whether `actorId` owns every account the user holds a grant on. Whoever makes a pending user's link can become them,
 * so someone who doesn't must keep away from a pending user, or they could take what other accounts' owners granted.
 */
export function ownsAllGrantsOf(q: Executor, actorId: number, userId: number): boolean {
  return q
    .selectDistinct({ accountId: grants.accountId })
    .from(grants)
    .where(eq(grants.userId, userId))
    .all()
    .every(({ accountId }) => loadAccess(q, accountId, actorId)?.can("grants.manage"));
}

export function createGrant(
  db: Db,
  accountId: number,
  actorId: number,
  input: { username: string; logicalCardId: number | null; role: Role },
): GrantRow {
  return db.transaction((q) => {
    const user = q
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(usernameIs(input.username))
      .get();
    if (!user || (user.passwordHash === null && !ownsAllGrantsOf(q, actorId, user.id))) {
      throw new UnknownUserError(input.username);
    }
    const scope =
      input.logicalCardId === null
        ? isNull(grants.logicalCardId)
        : eq(grants.logicalCardId, input.logicalCardId);
    const existing = q
      .select({ id: grants.id })
      .from(grants)
      .where(and(eq(grants.accountId, accountId), eq(grants.userId, user.id), scope))
      .get();
    if (existing) throw new DuplicateGrantError();
    return q
      .insert(grants)
      .values({ accountId, userId: user.id, logicalCardId: input.logicalCardId, role: input.role })
      .returning()
      .get();
  });
}

/**
 * Whether this grant is what's keeping the account owned. Only grants on the whole account can own it, and only
 * someone who can log in counts: a pending owner may never turn up.
 */
function isLastOwner(q: Executor, grant: GrantRow): boolean {
  if (grant.role !== "owner" || grant.logicalCardId !== null) return false;
  const another = q
    .select({ id: grants.id })
    .from(grants)
    .innerJoin(users, eq(users.id, grants.userId))
    .where(
      and(
        eq(grants.accountId, grant.accountId),
        eq(grants.role, "owner"),
        isNull(grants.logicalCardId),
        ne(grants.id, grant.id),
        isNotNull(users.passwordHash),
      ),
    )
    .get();
  return another === undefined;
}

const findGrant = (q: Executor, accountId: number, id: number) =>
  q
    .select()
    .from(grants)
    .where(and(eq(grants.id, id), eq(grants.accountId, accountId)))
    .get();

/** Changes one grant's role, leaving the user's others as they are. Undefined if the account has no such grant. */
export function updateGrantRole(db: Db, accountId: number, id: number, role: Role): GrantRow | undefined {
  return db.transaction((q) => {
    const grant = findGrant(q, accountId, id);
    if (!grant) return undefined;
    if (role !== "owner" && isLastOwner(q, grant)) throw new LastOwnerError();
    return q.update(grants).set({ role }).where(eq(grants.id, id)).returning().get();
  });
}

/**
 * Removes one grant, leaving the user's others as they are. False if the account has no such grant. A pending user left
 * with no grants is deleted, as nothing is waiting for them any more.
 */
export function deleteGrant(db: Db, accountId: number, id: number): boolean {
  return db.transaction((q) => {
    const grant = findGrant(q, accountId, id);
    if (!grant) return false;
    if (isLastOwner(q, grant)) throw new LastOwnerError();
    q.delete(grants).where(eq(grants.id, id)).run();
    const hasGrants = q.select({ id: grants.id }).from(grants).where(eq(grants.userId, grant.userId)).get();
    if (!hasGrants)
      q.delete(users)
        .where(and(eq(users.id, grant.userId), isNull(users.passwordHash)))
        .run();
    return true;
  });
}

/** A user leaves the account, giving up all their grants on it. */
export function leaveAccount(db: Db, accountId: number, userId: number): void {
  db.transaction((q) => {
    const theirs = and(eq(grants.accountId, accountId), eq(grants.userId, userId));
    if (
      q
        .select()
        .from(grants)
        .where(theirs)
        .all()
        .some((g) => isLastOwner(q, g))
    )
      throw new LastOwnerError();
    q.delete(grants).where(theirs).run();
  });
}

/** Earlier in `ROLES` is more. A role this code doesn't know is the least. */
const isHigher = (a: Role, b: Role) => {
  const rank = (role: Role) => {
    const index = ROLES.indexOf(role);
    return index === -1 ? ROLES.length : index;
  };
  return rank(a) < rank(b);
};

/**
 * Moves the grants on a logical card about to go to the one taking over its physical cards. A user holding a grant on
 * both keeps the higher role, on the one that stays.
 */
export function moveCardGrantsIn(q: Executor, fromLogicalCardId: number, toLogicalCardId: number): void {
  const held = new Map(
    q
      .select()
      .from(grants)
      .where(eq(grants.logicalCardId, toLogicalCardId))
      .all()
      .map((g) => [g.userId, g]),
  );
  for (const grant of q.select().from(grants).where(eq(grants.logicalCardId, fromLogicalCardId)).all()) {
    const existing = held.get(grant.userId);
    if (!existing) {
      q.update(grants).set({ logicalCardId: toLogicalCardId }).where(eq(grants.id, grant.id)).run();
    } else {
      if (isHigher(grant.role, existing.role)) {
        q.update(grants).set({ role: grant.role }).where(eq(grants.id, existing.id)).run();
      }
      q.delete(grants).where(eq(grants.id, grant.id)).run();
    }
  }
}
