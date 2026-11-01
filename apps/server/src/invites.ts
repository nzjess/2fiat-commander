import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Role } from "./access.ts";
import { hashToken, isUsernameTaken, type SessionUser, sessionUser, UsernameTakenError } from "./auth.ts";
import type { Db, Executor } from "./db/db.ts";
import { grants, invites, users } from "./db/schema.ts";
import { ownsAllGrantsOf } from "./grants.ts";

// An invited user is a real user with no password, so their grants work like anyone's until they set one. The link's
// token is what lets them: it's stored hashed, works once, and whoever opens the link first becomes that user.

export const INVITE_TTL_MS = 7 * 86_400_000;

export class InvalidInviteError extends Error {
  constructor() {
    super("This invite link isn't valid: it may have expired or been used. Ask for a new one.");
    this.name = "InvalidInviteError";
  }
}

export class NotPendingError extends Error {
  constructor() {
    super("this user has already set a password, or has been invited to another account too");
    this.name = "NotPendingError";
  }
}

export interface InviteLink {
  token: string;
  expiresAt: string;
}

/** Issues the user's link, replacing any earlier one. */
function issueLink(q: Executor, userId: number, now: Date): InviteLink {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const link = { tokenHash: hashToken(token), expiresAt, createdAt: now.toISOString() };
  q.insert(invites)
    .values({ userId, ...link })
    .onConflictDoUpdate({ target: invites.userId, set: link })
    .run();
  return { token, expiresAt };
}

/** Creates a user with no password and one grant, and the link for them to set a password. */
export function createInvite(
  db: Db,
  accountId: number,
  input: { username: string; logicalCardId: number | null; role: Role },
  now: Date,
): InviteLink & { grantId: number } {
  return db.transaction((q) => {
    if (isUsernameTaken(q, input.username)) throw new UsernameTakenError(input.username);
    const { id: userId } = q
      .insert(users)
      .values({ username: input.username, passwordHash: null })
      .returning({ id: users.id })
      .get();
    const { id: grantId } = q
      .insert(grants)
      .values({ accountId, userId, logicalCardId: input.logicalCardId, role: input.role })
      .returning({ id: grants.id })
      .get();
    return { grantId, ...issueLink(q, userId, now) };
  });
}

/**
 * A new link for someone with a grant on this account who hasn't set a password. Undefined if they have no grant here.
 * Refused for anyone else: a link lets its holder become the user, so it can never be made for an active user, or for
 * a pending one who also has grants on an account `actorId` doesn't own.
 */
export function renewInvite(
  db: Db,
  accountId: number,
  actorId: number,
  userId: number,
  now: Date,
): InviteLink | undefined {
  return db.transaction((q) => {
    const held = q
      .select({ passwordHash: users.passwordHash })
      .from(grants)
      .innerJoin(users, eq(users.id, grants.userId))
      .where(and(eq(grants.accountId, accountId), eq(grants.userId, userId)))
      .get();
    if (!held) return undefined;
    if (held.passwordHash !== null || !ownsAllGrantsOf(q, actorId, userId)) throw new NotPendingError();
    return issueLink(q, userId, now);
  });
}

const liveInvite = (q: Executor, token: string, now: Date) =>
  q
    .select({ userId: users.id, username: users.username })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.userId))
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        gt(invites.expiresAt, now.toISOString()),
        isNull(users.passwordHash),
      ),
    )
    .get();

/** Who the link is for, if it can still be used. */
export function findInvite(db: Db, token: string, now: Date) {
  return liveInvite(db, token, now);
}

/** Sets the user's password and uses up the link, so of two tries at once only the first gets through. */
export function acceptInvite(db: Db, token: string, passwordHash: string, now: Date): SessionUser {
  return db.transaction((q) => {
    const invite = liveInvite(q, token, now);
    if (!invite) throw new InvalidInviteError();
    q.delete(invites).where(eq(invites.userId, invite.userId)).run();
    return sessionUser(
      q.update(users).set({ passwordHash }).where(eq(users.id, invite.userId)).returning().get(),
    );
  });
}
