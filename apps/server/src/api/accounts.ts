import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  AccountArchivedError,
  assertNewToken,
  createAccount,
  replaceAccount,
  TOKEN_PATTERN,
  verifyToken,
} from "../accounts.ts";
import type { Db } from "../db/db.ts";
import { accounts, syncs } from "../db/schema.ts";
import type { SyncRow } from "../sync.ts";
import {
  type AccountEnv,
  type AccountRow,
  type AppDeps,
  idParam,
  invalid,
  notFound,
  type UserEnv,
} from "./common.ts";

const Label = z.string().trim().min(1).max(100);
const Token = z
  .string()
  .trim()
  .regex(TOKEN_PATTERN, "not a 2fiat account token (the token1… part of the login link)");

export function syncDto(s: SyncRow) {
  return {
    id: s.id,
    trigger: s.trigger,
    status: s.status,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    failedStage: s.failedStage,
    error: s.error,
    rowsNew: s.rowsNew,
    rowsUpdated: s.rowsUpdated,
    rowsMissing: s.rowsMissing,
    windowFrom: s.windowFrom,
    windowTo: s.windowTo,
    ordersFrom: s.ordersFrom,
    normalizedFrom: s.normalizedFrom,
  };
}

function accountDto(db: Db, a: AccountRow) {
  const lastSync = db
    .select()
    .from(syncs)
    .where(eq(syncs.accountId, a.id))
    .orderBy(desc(syncs.id))
    .limit(1)
    .get();
  return {
    id: a.id,
    label: a.label,
    createdAt: a.createdAt,
    archivedAt: a.archivedAt,
    replacedByAccountId: a.replacedByAccountId,
    lastSync: lastSync ? syncDto(lastSync) : null,
  };
}

const getAccount = (db: Db, id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get() as AccountRow;

/** `/accounts`: the user's accounts. */
/**
 * Stores a new account's cards so they show before its first sync. The account stands even if this fails: its cards
 * then arrive with the first sync.
 */
async function pullCardsIfAble(deps: AppDeps, accountId: number): Promise<void> {
  try {
    await deps.runner.pullCards(accountId);
  } catch (err) {
    console.warn(
      `account ${accountId}: couldn't fetch its cards yet:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function accountRoutes(deps: AppDeps) {
  const { db, secrets } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<UserEnv>()
      .get("/", (c) =>
        c.json(
          db
            .select()
            .from(accounts)
            .where(eq(accounts.userId, c.var.user.id))
            .orderBy(accounts.id)
            .all()
            .map((a) => accountDto(db, a)),
        ),
      )
      // Only checks the token with 2fiat: the first sync is up to the caller.
      .post("/", zValidator("json", z.object({ label: Label, token: Token }), invalid), async (c) => {
        const { label, token } = c.req.valid("json");
        const userId = c.var.user.id;
        assertNewToken(db, secrets, userId, token);
        const sid = await verifyToken(token, { session: deps.session, now: now() });
        const id = createAccount(db, secrets, { userId, label, token, sid });
        await pullCardsIfAble(deps, id);
        return c.json(accountDto(db, getAccount(db, id)), 201);
      })
  );
}

/** Routes under `/accounts/:accountId`, after `loadAccount`. */
export function accountScopedRoutes(deps: AppDeps) {
  const { db, secrets, runner } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<AccountEnv>()
      .get("/", (c) => c.json(accountDto(db, c.var.account)))
      .patch("/", zValidator("json", z.object({ label: Label }), invalid), (c) => {
        db.update(accounts)
          .set({ label: c.req.valid("json").label })
          .where(eq(accounts.id, c.var.account.id))
          .run();
        return c.json(accountDto(db, getAccount(db, c.var.account.id)));
      })
      // 2fiat replaced the account's token: the new token becomes a new account, and this one is archived.
      .post(
        "/replacement",
        zValidator("json", z.object({ label: Label.optional(), token: Token }), invalid),
        async (c) => {
          const { label, token } = c.req.valid("json");
          const account = c.var.account;
          if (account.archivedAt !== null) throw new AccountArchivedError(account.id);
          assertNewToken(db, secrets, account.userId, token);
          const sid = await verifyToken(token, { session: deps.session, now: now() });
          const id = replaceAccount(db, secrets, account.id, { label, token, sid, now: now() });
          await pullCardsIfAble(deps, id);
          return c.json(accountDto(db, getAccount(db, id)), 201);
        },
      )
      // Starts a sync (or joins the running one) and returns straight away: poll the sync for its outcome.
      .post("/syncs", (c) => {
        const { syncId } = runner.start(c.var.account.id, "manual");
        return c.json(syncDto(db.select().from(syncs).where(eq(syncs.id, syncId)).get() as SyncRow), 202);
      })
      .get(
        "/syncs",
        zValidator(
          "query",
          z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
          invalid,
        ),
        (c) =>
          c.json(
            db
              .select()
              .from(syncs)
              .where(eq(syncs.accountId, c.var.account.id))
              .orderBy(desc(syncs.id))
              .limit(c.req.valid("query").limit)
              .all()
              .map(syncDto),
          ),
      )
      .get("/syncs/:syncId", (c) => {
        const id = idParam(c, "syncId", "sync");
        const sync = db
          .select()
          .from(syncs)
          .where(and(eq(syncs.id, id), eq(syncs.accountId, c.var.account.id)))
          .get();
        if (!sync) throw notFound("sync");
        return c.json(syncDto(sync));
      })
  );
}
