import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { accountsOfUser, loadAccess } from "../access.ts";
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
import { anyRole, requireAccount, requireAnyCard } from "./guards.ts";

const Label = z.string().trim().min(1).max(100);
const Token = z
  .string()
  .trim()
  .regex(TOKEN_PATTERN, "not a 2fiat account token (the token1… part of the login link)");

/**
 * What a sync did covers the whole account, so only someone who sees every card gets its details. Anyone else gets
 * its status and times, which is all a card's page needs.
 */
export function syncDto(s: SyncRow, seesAllCards: boolean) {
  const detail = <T>(value: T) => (seesAllCards ? value : null);
  return {
    id: s.id,
    trigger: s.trigger,
    status: s.status,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    failedStage: detail(s.failedStage),
    error: detail(s.error),
    rowsNew: detail(s.rowsNew),
    rowsUpdated: detail(s.rowsUpdated),
    rowsMissing: detail(s.rowsMissing),
    windowFrom: detail(s.windowFrom),
    windowTo: detail(s.windowTo),
    ordersFrom: detail(s.ordersFrom),
    normalizedFrom: detail(s.normalizedFrom),
  };
}

function accountDto(db: Db, a: AccountRow, seesAllCards: boolean) {
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
    lastSync: lastSync ? syncDto(lastSync, seesAllCards) : null,
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
          accountsOfUser(db, c.var.user.id).map((a) =>
            accountDto(db, a, loadAccess(db, a.id, c.var.user.id)?.seesAllCards ?? false),
          ),
        ),
      )
      // Only checks the token with 2fiat: the first sync is up to the caller.
      .post("/", zValidator("json", z.object({ label: Label, token: Token }), invalid), async (c) => {
        const { label, token } = c.req.valid("json");
        const userId = c.var.user.id;
        assertNewToken(db, secrets, token);
        const sid = await verifyToken(token, { session: deps.session, now: now() });
        const id = createAccount(db, secrets, { userId, label, token, sid });
        await pullCardsIfAble(deps, id);
        return c.json(accountDto(db, getAccount(db, id), true), 201);
      })
  );
}

/** Routes under `/accounts/:accountId`, after `loadAccount`. */
export function accountScopedRoutes(deps: AppDeps) {
  const { db, secrets, runner } = deps;
  const now = deps.now ?? (() => new Date());

  return (
    new Hono<AccountEnv>()
      .get("/", anyRole, (c) => c.json(accountDto(db, c.var.account, c.var.access.seesAllCards)))
      .patch(
        "/",
        requireAccount("account.rename"),
        zValidator("json", z.object({ label: Label }), invalid),
        (c) => {
          db.update(accounts)
            .set({ label: c.req.valid("json").label })
            .where(eq(accounts.id, c.var.account.id))
            .run();
          return c.json(accountDto(db, getAccount(db, c.var.account.id), c.var.access.seesAllCards));
        },
      )
      // 2fiat replaced the account's token: the new token becomes a new account, and this one is archived.
      .post(
        "/replacement",
        requireAccount("account.replace"),
        zValidator("json", z.object({ label: Label.optional(), token: Token }), invalid),
        async (c) => {
          const { label, token } = c.req.valid("json");
          const account = c.var.account;
          if (account.archivedAt !== null) throw new AccountArchivedError(account.id);
          assertNewToken(db, secrets, token);
          const sid = await verifyToken(token, { session: deps.session, now: now() });
          const id = replaceAccount(db, secrets, account.id, { label, token, sid, now: now() });
          await pullCardsIfAble(deps, id);
          return c.json(accountDto(db, getAccount(db, id), c.var.access.seesAllCards), 201);
        },
      )
      // Starts a sync (or joins the running one) and returns straight away: poll the sync for its outcome.
      .post("/syncs", requireAnyCard("card.sync"), (c) => {
        const { syncId } = runner.start(c.var.account.id, "manual");
        return c.json(
          syncDto(
            db.select().from(syncs).where(eq(syncs.id, syncId)).get() as SyncRow,
            c.var.access.seesAllCards,
          ),
          202,
        );
      })
      .get(
        "/syncs",
        anyRole,
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
              .map((s) => syncDto(s, c.var.access.seesAllCards)),
          ),
      )
      .get("/syncs/:syncId", anyRole, (c) => {
        const id = idParam(c, "syncId", "sync");
        const sync = db
          .select()
          .from(syncs)
          .where(and(eq(syncs.id, id), eq(syncs.accountId, c.var.account.id)))
          .get();
        if (!sync) throw notFound("sync");
        return c.json(syncDto(sync, c.var.access.seesAllCards));
      })
  );
}
