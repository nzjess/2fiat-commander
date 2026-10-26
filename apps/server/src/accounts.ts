import { type SessionOptions, TwoFiatSession } from "@twofiat/client";
import { and, eq } from "drizzle-orm";
import type { Db, Executor } from "./db/db.ts";
import { accounts } from "./db/schema.ts";
import type { Secrets } from "./secrets.ts";

/** The `token1…` segment of an account's 2fiat login link. */
export const TOKEN_PATTERN = /^token1[a-z0-9]+$/i;

/** 2fiat's `sid` cookie lasts 14 days. */
export const SID_TTL_MS = 14 * 86_400_000;

export class DuplicateAccountError extends Error {
  constructor() {
    super("this 2fiat account has already been added");
    this.name = "DuplicateAccountError";
  }
}

export class AccountArchivedError extends Error {
  constructor(accountId: number) {
    super(`account ${accountId} is archived`);
    this.name = "AccountArchivedError";
  }
}

/** A sid and when it expires, from a token checked against 2fiat. */
export interface VerifiedSid {
  sid: string;
  expiresAt: string;
}

/**
 * Checks a token against 2fiat by exchanging it for a session cookie, which is read-only. Throws
 * `TwoFiatAuthError` when 2fiat rejects it.
 */
export async function verifyToken(
  token: string,
  options: { session?: Omit<SessionOptions, "token" | "sid" | "onSid">; now?: Date } = {},
): Promise<VerifiedSid> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("not a 2fiat account token");
  const sid = await new TwoFiatSession({ ...options.session, token }).exchange();
  return { sid, expiresAt: new Date((options.now ?? new Date()).getTime() + SID_TTL_MS).toISOString() };
}

/** Throws `DuplicateAccountError` if the user already has an account with this token. */
export function assertNewToken(db: Executor, secrets: Secrets, userId: number, token: string): void {
  const existing = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.tokenHash, secrets.hash(token))))
    .get();
  if (existing) throw new DuplicateAccountError();
}

/** Adds a 2fiat account for a user, with its token (and sid, if given) encrypted. A token added twice is refused. */
export function createAccount(
  db: Executor,
  secrets: Secrets,
  input: { userId: number; label: string; token: string; sid?: VerifiedSid },
): number {
  if (!TOKEN_PATTERN.test(input.token)) throw new Error("not a 2fiat account token");
  assertNewToken(db, secrets, input.userId, input.token);
  return db
    .insert(accounts)
    .values({
      userId: input.userId,
      label: input.label,
      tokenEnc: secrets.encrypt(input.token),
      tokenHash: secrets.hash(input.token),
      sidEnc: input.sid && secrets.encrypt(input.sid.sid),
      sidExpiresAt: input.sid?.expiresAt,
    })
    .returning({ id: accounts.id })
    .get().id;
}

/**
 * Replaces an account whose token 2fiat replaced: adds the new token as a new account and archives the old one,
 * dropping its token and sid. Accounts are hard boundaries, so nothing moves across. Returns the new account's id.
 */
export function replaceAccount(
  db: Db,
  secrets: Secrets,
  accountId: number,
  input: { label?: string; token: string; sid?: VerifiedSid; now?: Date },
): number {
  return db.transaction((q) => {
    const old = q.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!old) throw new Error(`No account ${accountId}`);
    if (old.archivedAt !== null) throw new AccountArchivedError(accountId);
    const id = createAccount(q, secrets, {
      userId: old.userId,
      label: input.label ?? old.label,
      token: input.token,
      sid: input.sid,
    });
    q.update(accounts)
      .set({
        archivedAt: (input.now ?? new Date()).toISOString(),
        replacedByAccountId: id,
        tokenEnc: null,
        sidEnc: null,
        sidExpiresAt: null,
      })
      .where(eq(accounts.id, accountId))
      .run();
    return id;
  });
}
