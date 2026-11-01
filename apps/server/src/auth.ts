import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import type { Db, Executor } from "./db/db.ts";
import { invites, sessions, users } from "./db/schema.ts";
import { type Currency, isCurrency } from "./fx.ts";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 86_400_000;
export const MIN_PASSWORD_LENGTH = 12;
/** A session's expiry moves forward on use, but at most this often. */
const SESSION_REFRESH_MS = 86_400_000;

export interface SessionUser {
  id: number;
  username: string;
  displayCurrency: Currency;
}

/** What a username can hold. The database checks the same, and all of it is matched ignoring case. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const USERNAME_RULE = "can only have letters, digits, dots, underscores and hyphens";

/** Matches the user of this name in any case, so `Sam` and `sam` are the same person. */
export const usernameIs = (username: string) => sql`${users.username} = ${username} COLLATE NOCASE`;

/** A user row as a session user. A currency since dropped from the whitelist falls back to USD. */
export const sessionUser = (row: { id: number; username: string; displayCurrency: string }): SessionUser => ({
  id: row.id,
  username: row.username,
  displayCurrency: isCurrency(row.displayCurrency) ? row.displayCurrency : "USD",
});

/** argon2id at the library's defaults. */
export const hashPassword = (password: string): Promise<string> => hash(password);

// Verified against when the user is unknown or has no password yet, so a failed login costs the same either way.
let dummyHash: Promise<string> | undefined;

/** The user, if the username and password match. */
export async function checkPassword(
  db: Db,
  username: string,
  password: string,
): Promise<SessionUser | undefined> {
  const user = db.select().from(users).where(usernameIs(username)).get();
  if (!user?.passwordHash) {
    dummyHash ??= hashPassword(randomBytes(16).toString("base64"));
    await verify(await dummyHash, password);
    return undefined;
  }
  return (await verify(user.passwordHash, password)) ? sessionUser(user) : undefined;
}

export function createUser(db: Db, username: string, passwordHash: string): number {
  return db.insert(users).values({ username, passwordHash }).returning({ id: users.id }).get().id;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`the username ${username} is taken`);
    this.name = "UsernameTakenError";
  }
}

export const isUsernameTaken = (q: Executor, username: string) =>
  q.select({ id: users.id }).from(users).where(usernameIs(username)).get() !== undefined;

/** A new user with a password and no grants, who has signed themselves up. */
export function signUp(db: Db, username: string, passwordHash: string): SessionUser {
  if (isUsernameTaken(db, username)) throw new UsernameTakenError(username);
  return sessionUser(db.insert(users).values({ username, passwordHash }).returning().get());
}

export function setPassword(db: Db, username: string, passwordHash: string): boolean {
  const user = db.select({ id: users.id }).from(users).where(usernameIs(username)).get();
  if (!user) return false;
  db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
  // A new password signs out everywhere, and ends any invite.
  db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  db.delete(invites).where(eq(invites.userId, user.id)).run();
  return true;
}

/** What's stored for a token given out in a cookie or a link. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Starts a session and returns the cookie token. Only its hash is stored. */
export function createSession(db: Db, userId: number, now: Date): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })
    .run();
  return { token, expiresAt };
}

/**
 * The session's user, or undefined for an unknown or expired session (which is deleted). `renewedUntil` is set
 * when the expiry moved forward, so the caller can re-issue the cookie.
 */
export function resolveSession(
  db: Db,
  token: string,
  now: Date,
): { user: SessionUser; renewedUntil?: Date } | undefined {
  const id = hashToken(token);
  const row = db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id,
      username: users.username,
      displayCurrency: users.displayCurrency,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return undefined;
  if (row.expiresAt <= now.toISOString()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }
  const user = sessionUser(row);
  if (Date.parse(row.expiresAt) - now.getTime() > SESSION_TTL_MS - SESSION_REFRESH_MS) return { user };
  const renewedUntil = new Date(now.getTime() + SESSION_TTL_MS);
  db.update(sessions).set({ expiresAt: renewedUntil.toISOString() }).where(eq(sessions.id, id)).run();
  return { user, renewedUntil };
}

export function setDisplayCurrency(db: Db, userId: number, currency: Currency): void {
  db.update(users).set({ displayCurrency: currency }).where(eq(users.id, userId)).run();
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, hashToken(token)))
    .run();
}
