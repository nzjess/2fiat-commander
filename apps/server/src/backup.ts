import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./db/db.ts";

// Backups are `VACUUM INTO` copies: consistent snapshots taken while the server runs, unlike a file copy of a WAL
// database (which is what Time Machine would otherwise get). They hold what the database holds, so the tokens and
// sids in them stay encrypted with the app secret.

const NAME = /^commander-(\d{8}-\d{6})\.db$/;
const DAY_MS = 24 * 60 * 60_000;
const CHECK_EVERY_MS = 60 * 60_000;

/** `commander-YYYYMMDD-HHMMSS.db`, in UTC, so the names sort by age. */
export const backupName = (at: Date): string =>
  `commander-${at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.db`;

/** When the backup named `name` was taken. */
export function backupTime(name: string): Date | undefined {
  const m = NAME.exec(name)?.[1]?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : undefined;
}

/** The backups in `dir`, newest first. */
export function listBackups(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => NAME.test(name))
    .sort()
    .reverse();
}

/** Writes a snapshot of the database into `dir` and returns its path. */
export function backup(db: Db, dir: string, at = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, backupName(at));
  db.run(sql`VACUUM INTO ${path}`);
  return path;
}

/** Deletes all but the newest `keep` backups, and returns the ones deleted. */
export function pruneBackups(dir: string, keep: number): string[] {
  const old = listBackups(dir).slice(keep);
  for (const name of old) rmSync(join(dir, name));
  return old;
}

/**
 * Takes a backup once the newest is a day old, checking at startup and then hourly, so a Mac that sleeps or
 * restarts still gets one a day.
 */
export class Backups {
  readonly #db: Db;
  readonly #dir: string;
  readonly #keep: number;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: { db: Db; dir: string; keep: number; now?: () => Date }) {
    this.#db = options.db;
    this.#dir = options.dir;
    this.#keep = options.keep;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    this.#timer ??= setInterval(() => this.run(), CHECK_EVERY_MS);
    this.run();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Takes a backup if one is due, and returns its path. */
  run(): string | undefined {
    try {
      const newest = listBackups(this.#dir)[0];
      const taken = newest ? backupTime(newest) : undefined;
      const now = this.#now();
      if (taken && now.getTime() - taken.getTime() < DAY_MS) return undefined;
      const path = backup(this.#db, this.#dir, now);
      pruneBackups(this.#dir, this.#keep);
      return path;
    } catch (err) {
      console.error("backing up the database failed:", err);
      return undefined;
    }
  }
}
