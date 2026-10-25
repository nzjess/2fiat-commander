import Database, { type RunResult } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;
/** The database or a transaction on it. */
export type Executor = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

const MIGRATIONS = new URL("../../drizzle", import.meta.url).pathname;

/** Opens (or creates) the database and applies any pending migrations. Pass ":memory:" for tests. */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Another process holding the write lock makes us wait, rather than fail with SQLITE_BUSY.
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

/**
 * For transactions that read and then write: taking the write lock up front means another process's write can't
 * slip in between and fail the upgrade from read to write lock with SQLITE_BUSY (which busy_timeout can't retry).
 */
export const IMMEDIATE = { behavior: "immediate" } as const;

/** Splits ids into runs that stay well under SQLite's bound-parameter limit. */
export function* chunks<T>(items: T[], size = 500): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
