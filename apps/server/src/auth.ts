import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { sessions, users } from "./db/schema.ts";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 86_400_000;
/** A session's expiry moves forward on use, but at most this often. */
const SESSION_REFRESH_MS = 86_400_000;

export interface SessionUser {
  id: number;
  username: string;
}

/** argon2id at the library's defaults. */
export const hashPassword = (password: string): Promise<string> => hash(password);

// Verified against when the username is unknown, so a failed login costs the same either way.
let dummyHash: Promise<string> | undefined;

/** The user, if the username and password match. */
export async function checkPassword(
  db: Db,
  username: string,
  password: string,
): Promise<SessionUser | undefined> {
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) {
    dummyHash ??= hashPassword(randomBytes(16).toString("base64"));
    await verify(await dummyHash, password);
    return undefined;
  }
  return (await verify(user.passwordHash, password)) ? { id: user.id, username: user.username } : undefined;
}

export function createUser(db: Db, username: string, passwordHash: string): number {
  return db.insert(users).values({ username, passwordHash }).returning({ id: users.id }).get().id;
}

export function setPassword(db: Db, username: string, passwordHash: string): boolean {
  const changed =
    db.update(users).set({ passwordHash }).where(eq(users.username, username)).run().changes > 0;
  // A new password signs out everywhere.
  if (changed) {
    const user = db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
    if (user) db.delete(sessions).where(eq(sessions.userId, user.id)).run();
  }
  return changed;
}

const sessionId = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Starts a session and returns the cookie token. Only its hash is stored. */
export function createSession(db: Db, userId: number, now: Date): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({
      id: sessionId(token),
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
  const id = sessionId(token);
  const row = db
    .select({ expiresAt: sessions.expiresAt, userId: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return undefined;
  if (row.expiresAt <= now.toISOString()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }
  const user = { id: row.userId, username: row.username };
  if (Date.parse(row.expiresAt) - now.getTime() > SESSION_TTL_MS - SESSION_REFRESH_MS) return { user };
  const renewedUntil = new Date(now.getTime() + SESSION_TTL_MS);
  db.update(sessions).set({ expiresAt: renewedUntil.toISOString() }).where(eq(sessions.id, id)).run();
  return { user, renewedUntil };
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions)
    .where(eq(sessions.id, sessionId(token)))
    .run();
}
