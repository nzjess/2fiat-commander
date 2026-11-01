import type { SessionOptions } from "@twofiat/client";
import { TwoFiatAuthError } from "@twofiat/client";
import { eq } from "drizzle-orm";
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type Access, loadAccess } from "../access.ts";
import { AccountArchivedError, DuplicateAccountError } from "../accounts.ts";
import { AdjustmentNotFoundError } from "../adjustments.ts";
import {
  resolveSession,
  SESSION_COOKIE,
  type SessionUser,
  USERNAME_PATTERN,
  USERNAME_RULE,
  UsernameTakenError,
} from "../auth.ts";
import { DuplicateCategoryError, DuplicateRuleError } from "../categories.ts";
import type { Db } from "../db/db.ts";
import { accounts } from "../db/schema.ts";
import { LedgerNotReadyError } from "../evaluate.ts";
import { DuplicateGrantError, LastOwnerError, UnknownUserError } from "../grants.ts";
import { InvalidInviteError, NotPendingError } from "../invites.ts";
import type { Secrets } from "../secrets.ts";
import { SyncAlreadyRunningError, type SyncRunner } from "../sync.ts";

export interface AppDeps {
  db: Db;
  secrets: Secrets;
  runner: SyncRunner;
  now?: () => Date;
  /** Whether anyone can create a user for themselves. On unless turned off. */
  signupEnabled?: boolean;
  /** Passed through to the 2fiat session that checks a new token (e.g. `fetch` in tests). */
  session?: Pick<SessionOptions, "baseUrl" | "fetch" | "sleep" | "maxRetries" | "userAgent">;
}

export type AccountRow = typeof accounts.$inferSelect;
export type UserEnv = { Variables: { user: SessionUser } };
export type AccountEnv = { Variables: { user: SessionUser; account: AccountRow; access: Access } };

/** An error with a status and a machine-readable code, returned as `{ error, message }`. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** A username being given to someone, or looked for among those that were. */
export const Username = z.string().trim().min(1).max(200).regex(USERNAME_PATTERN, USERNAME_RULE);

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

export const handleError: ErrorHandler = (err, c) => {
  const known = toApiError(err);
  if (known) return c.json({ error: known.code, message: known.message }, known.status);
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal", message: "internal server error" }, 500);
};

function toApiError(err: Error): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (err instanceof DuplicateAccountError) return new ApiError(409, "duplicate_account", err.message);
  if (err instanceof AccountArchivedError) return new ApiError(409, "account_archived", err.message);
  if (err instanceof DuplicateCategoryError) return new ApiError(409, "duplicate_category", err.message);
  if (err instanceof DuplicateRuleError) return new ApiError(409, "duplicate_rule", err.message);
  if (err instanceof AdjustmentNotFoundError) return new ApiError(404, "not_found", err.message);
  if (err instanceof UnknownUserError) return new ApiError(400, "unknown_user", err.message);
  if (err instanceof DuplicateGrantError) return new ApiError(409, "duplicate_grant", err.message);
  if (err instanceof LastOwnerError) return new ApiError(409, "last_owner", err.message);
  if (err instanceof UsernameTakenError) return new ApiError(409, "username_taken", err.message);
  if (err instanceof NotPendingError) return new ApiError(409, "not_pending", err.message);
  if (err instanceof InvalidInviteError) return new ApiError(404, "invalid_invite", err.message);
  if (err instanceof SyncAlreadyRunningError) return new ApiError(409, "sync_running", err.message);
  if (err instanceof LedgerNotReadyError) return new ApiError(409, "ledger_not_ready", err.message);
  if (err instanceof TwoFiatAuthError) return new ApiError(422, "token_rejected", "2fiat rejected the token");
  return undefined;
}

/** The hook for `zValidator`: a failed validation is a 400 in our error shape. */
export const invalid = (
  result: {
    success: boolean;
    error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
  },
  c: Context,
) => {
  if (!result.success) {
    const issues = result.error?.issues ?? [];
    const describe = (i: (typeof issues)[number]) =>
      i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message;
    return c.json({ error: "invalid_request", message: issues.map(describe).join("; ") }, 400);
  }
};

/** A positive integer path parameter, or a 404. */
export function idParam(c: Context, name: string, what: string): number {
  const value = c.req.param(name);
  const id = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) throw notFound(what);
  return id;
}

/** Secure cookies everywhere but plain-http localhost, where browsers would drop them. */
const secureCookies = (c: Context) => {
  const url = new URL(c.req.url);
  return url.protocol === "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
};

export function setSessionCookie(c: Context, token: string, expires: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookies(c),
    path: "/",
    expires,
  });
}

/** Rejects requests without a live session, and sets `user`. */
export function requireUser(deps: AppDeps): MiddlewareHandler<UserEnv> {
  const now = deps.now ?? (() => new Date());
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? resolveSession(deps.db, token, now()) : undefined;
    if (!token || !session) throw new ApiError(401, "unauthenticated", "not logged in");
    if (session.renewedUntil) setSessionCookie(c, token, session.renewedUntil);
    c.set("user", session.user);
    await next();
  };
}

/**
 * Loads the `:accountId` account, if the user holds a role on it or one of its cards, and sets `account` and `access`.
 * Access is worked out on each request, so a change of role applies straight away. Anyone else's is a 404 too.
 */
export function loadAccount(deps: AppDeps): MiddlewareHandler<AccountEnv> {
  return async (c, next) => {
    const id = idParam(c, "accountId", "account");
    const account = deps.db.select().from(accounts).where(eq(accounts.id, id)).get();
    const access = account && loadAccess(deps.db, id, c.var.user.id);
    if (!account || !access) throw notFound("account");
    c.set("account", account);
    c.set("access", access);
    await next();
  };
}
