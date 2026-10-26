import { eq, isNull, max } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { accounts, syncs } from "./db/schema.ts";
import { SyncAlreadyRunningError, type SyncRunner } from "./sync.ts";

const TICK_MS = 60_000;

/**
 * Syncs each live account once its last sync started `intervalMinutes` ago (or it never synced), one account at
 * a time so 2fiat isn't hit in parallel. A failed sync counts as an attempt, so it's retried an interval later.
 * The state lives in `syncs`, so a restart doesn't sync everything again.
 */
export class Scheduler {
  readonly #db: Db;
  readonly #runner: SyncRunner;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<number[]> | undefined;

  constructor(options: { db: Db; runner: SyncRunner; intervalMinutes: number; now?: () => Date }) {
    if (options.intervalMinutes <= 0) throw new Error("the sync interval must be positive");
    this.#db = options.db;
    this.#runner = options.runner;
    this.#intervalMs = options.intervalMinutes * 60_000;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Syncs the accounts that are due, and returns them. A tick while one is still running joins it. */
  tick(): Promise<number[]> {
    this.#ticking ??= this.#syncDue().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  /** Live accounts whose last sync started at least an interval ago, or that never synced. */
  due(): number[] {
    const cutoff = new Date(this.#now().getTime() - this.#intervalMs).toISOString();
    return this.#db
      .select({ id: accounts.id, lastStarted: max(syncs.startedAt) })
      .from(accounts)
      .leftJoin(syncs, eq(syncs.accountId, accounts.id))
      .where(isNull(accounts.archivedAt))
      .groupBy(accounts.id)
      .all()
      .filter((a) => a.lastStarted === null || a.lastStarted <= cutoff)
      .map((a) => a.id);
  }

  async #syncDue(): Promise<number[]> {
    const synced: number[] = [];
    for (const id of this.due()) {
      try {
        await this.#runner.sync(id, "scheduled");
        synced.push(id);
      } catch (err) {
        // Another process is syncing it: that counts.
        if (!(err instanceof SyncAlreadyRunningError)) console.error(`scheduled sync of account ${id}:`, err);
      }
    }
    return synced;
  }
}
