import { and, asc, count, eq, isNull } from "drizzle-orm";
import { ROLES, type Role } from "./access.ts";
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
    super("an account must keep at least one owner");
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
      logicalCardId: grants.logicalCardId,
      role: grants.role,
      createdAt: grants.createdAt,
    })
    .from(grants)
    .innerJoin(users, eq(users.id, grants.userId))
    .where(eq(grants.accountId, accountId))
    .orderBy(asc(grants.logicalCardId), asc(users.username))
    .all();
}

export function createGrant(
  db: Db,
  accountId: number,
  input: { username: string; logicalCardId: number | null; role: Role },
): GrantRow {
  return db.transaction((q) => {
    const user = q.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get();
    if (!user) throw new UnknownUserError(input.username);
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

/** Whether this grant is what's keeping the account owned. Only grants on the whole account can own it. */
function isLastOwner(q: Executor, grant: GrantRow): boolean {
  if (grant.role !== "owner" || grant.logicalCardId !== null) return false;
  const owners = q
    .select({ owners: count() })
    .from(grants)
    .where(and(eq(grants.accountId, grant.accountId), eq(grants.role, "owner"), isNull(grants.logicalCardId)))
    .get();
  return owners?.owners === 1;
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

/** Removes one grant, leaving the user's others as they are. False if the account has no such grant. */
export function deleteGrant(db: Db, accountId: number, id: number): boolean {
  return db.transaction((q) => {
    const grant = findGrant(q, accountId, id);
    if (!grant) return false;
    if (isLastOwner(q, grant)) throw new LastOwnerError();
    q.delete(grants).where(eq(grants.id, id)).run();
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
