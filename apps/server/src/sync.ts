import {
  dollarsToCents,
  LOOKBACK_DAYS,
  type RawCardDetails,
  type SessionOptions,
  TwoFiatClient,
  TwoFiatSession,
} from "@twofiat/client";
import { eq } from "drizzle-orm";
import { AccountArchivedError, SID_TTL_MS } from "./accounts.ts";
import type { Db } from "./db/db.ts";
import { accounts, type SyncStage, syncs } from "./db/schema.ts";
import { type EvaluateResult, evaluate } from "./evaluate.ts";
import { ingest, type Pull, planPull, windowStart } from "./ingest.ts";
import { normalizeAccount } from "./ledger.ts";
import type { Secrets } from "./secrets.ts";
import { utcDay } from "./time.ts";

export interface SyncRunnerOptions {
  db: Db;
  secrets: Secrets;
  /** How far before the last pull's window to start the next one, in days. */
  overlapDays?: number;
  /** Passed through to each account's 2fiat session (e.g. `fetch` in tests). */
  session?: Pick<SessionOptions, "baseUrl" | "fetch" | "sleep" | "maxRetries" | "userAgent">;
  now?: () => Date;
}

export type SyncRow = typeof syncs.$inferSelect;

export interface SyncOutcome {
  sync: SyncRow;
  /** Undefined when the sync failed before evaluating. */
  evaluation: EvaluateResult | undefined;
}

export interface StartedSync {
  syncId: number;
  /** Never rejects: a failure is recorded on the sync. */
  done: Promise<SyncOutcome>;
}

export class SyncAlreadyRunningError extends Error {
  constructor(accountId: number) {
    super(`a sync of account ${accountId} is already running in another process`);
    this.name = "SyncAlreadyRunningError";
  }
}

/**
 * Pulls accounts from 2fiat in three stages, each committed on its own: ingest writes the raw rows, normalise
 * brings the ledger up to date with them, and evaluate reconciles it. A failure in a later stage keeps what the
 * earlier ones wrote, and the next sync picks up from there.
 *
 * One sync runs per account at a time: a second trigger gets the running one's outcome, and the database refuses
 * a second running sync from another process.
 */
export class SyncRunner {
  readonly #db: Db;
  readonly #secrets: Secrets;
  readonly #overlapDays: number;
  readonly #session: SyncRunnerOptions["session"];
  readonly #now: () => Date;
  readonly #running = new Map<number, StartedSync>();

  constructor(options: SyncRunnerOptions) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#overlapDays = options.overlapDays ?? LOOKBACK_DAYS;
    this.#session = options.session;
    this.#now = options.now ?? (() => new Date());
  }

  /** Marks syncs left running by a process that died as failed. Call at startup, before any sync. */
  recover(): number {
    return this.#db
      .update(syncs)
      .set({ status: "failed", error: "interrupted", finishedAt: this.#now().toISOString() })
      .where(eq(syncs.status, "running"))
      .run().changes;
  }

  /**
   * Starts a sync of an account, or joins the one already running in this process, and returns its id once its
   * `syncs` row exists. Throws `AccountArchivedError` for an archived account, and `SyncAlreadyRunningError` when
   * another process is syncing it.
   */
  start(accountId: number, trigger: SyncRow["trigger"]): StartedSync {
    const running = this.#running.get(accountId);
    if (running) return running;

    const account = this.#db
      .select({ archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    if (!account) throw new Error(`No account ${accountId}`);
    if (account.archivedAt !== null) throw new AccountArchivedError(accountId);

    let syncId: number;
    try {
      syncId = this.#db
        .insert(syncs)
        .values({ accountId, trigger, status: "running", startedAt: this.#now().toISOString() })
        .returning({ id: syncs.id })
        .get().id;
    } catch (err) {
      if (String(err).includes("UNIQUE constraint failed")) throw new SyncAlreadyRunningError(accountId);
      throw err;
    }
    const started = {
      syncId,
      done: this.#run(accountId, syncId).finally(() => this.#running.delete(accountId)),
    };
    this.#running.set(accountId, started);
    return started;
  }

  /** Syncs an account, or joins the sync already running in this process, and resolves when it has finished. */
  async sync(accountId: number, trigger: SyncRow["trigger"]): Promise<SyncOutcome> {
    return this.start(accountId, trigger).done;
  }

  /** Whether this process is syncing the account. */
  isRunning(accountId: number): boolean {
    return this.#running.has(accountId);
  }

  async #run(accountId: number, syncId: number): Promise<SyncOutcome> {
    const db = this.#db;
    let stage: SyncStage = "fetch";
    let evaluation: EvaluateResult | undefined;
    try {
      const pull = await this.#fetch(accountId);
      stage = "ingest";
      ingest(db, accountId, syncId, pull);
      stage = "normalize";
      const normalized = normalizeAccount(db, accountId);
      if (normalized)
        db.update(syncs).set({ normalizedFrom: normalized.from }).where(eq(syncs.id, syncId)).run();
      stage = "evaluate";
      evaluation = evaluate(db, accountId, { syncId, asOf: this.#now().toISOString() });
      db.update(syncs)
        .set({ status: "ok", finishedAt: this.#now().toISOString() })
        .where(eq(syncs.id, syncId))
        .run();
    } catch (err) {
      db.update(syncs)
        .set({
          status: "failed",
          failedStage: stage,
          error: err instanceof Error ? err.message : String(err),
          finishedAt: this.#now().toISOString(),
        })
        .where(eq(syncs.id, syncId))
        .run();
    }
    const sync = db.select().from(syncs).where(eq(syncs.id, syncId)).get() as SyncRow;
    return { sync, evaluation };
  }

  /**
   * Fetches everything the next ingest needs. The cards are listed again at the end: a balance that moved in the
   * meantime may not match the rows fetched, so it's marked transient.
   */
  async #fetch(accountId: number): Promise<Pull> {
    const client = new TwoFiatClient(this.#openSession(accountId));
    const plan = planPull(this.#db, accountId, this.#overlapDays);
    const today = utcDay(this.#now());

    const listed = await client.listCards();
    const details: RawCardDetails[] = [];
    for (const card of listed) details.push(await client.getCardDetails(card.id));

    const window = { from: windowStart(plan, details, today), to: today };
    const transactions = await client.fetchTransactions(window);
    const orders = await client.fetchOrders({ since: plan.ordersFrom });

    // Rows can belong to cards that are no longer listed (e.g. cancelled ones) and aren't stored yet.
    const seen = new Set([...plan.knownCards, ...details.map((c) => c.id)]);
    for (const id of [...transactions.map((t) => t.cardId), ...orders.map((o) => o.cardId)]) {
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      details.push(await client.getCardDetails(id));
    }

    const after = new Map((await client.listCards()).map((c) => [c.id, c.balance]));
    const balances = new Map(
      listed.map((card) => {
        const latest = after.get(card.id) ?? card.balance;
        return [card.id, { cents: dollarsToCents(latest), transient: latest !== card.balance }];
      }),
    );
    return {
      cards: details,
      balances,
      observedAt: this.#now().toISOString(),
      transactions,
      window,
      orders,
      ordersFrom: plan.ordersFrom,
    };
  }

  /** A session reusing the account's stored sid while it's valid, and storing any new one straight away. */
  #openSession(accountId: number): TwoFiatSession {
    const account = this.#db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) throw new Error(`No account ${accountId}`);
    if (account.tokenEnc === null) throw new AccountArchivedError(accountId);
    const sidValid =
      account.sidEnc && account.sidExpiresAt && account.sidExpiresAt > this.#now().toISOString();
    return new TwoFiatSession({
      ...this.#session,
      token: this.#secrets.decrypt(account.tokenEnc),
      sid: sidValid && account.sidEnc ? this.#secrets.decrypt(account.sidEnc) : undefined,
      onSid: (sid) => {
        this.#db
          .update(accounts)
          .set({
            sidEnc: this.#secrets.encrypt(sid),
            sidExpiresAt: new Date(this.#now().getTime() + SID_TTL_MS).toISOString(),
          })
          .where(eq(accounts.id, accountId))
          .run();
      },
    });
  }
}
