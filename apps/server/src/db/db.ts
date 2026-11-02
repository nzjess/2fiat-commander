import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database, { type RunResult } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { backup } from "../backup.ts";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;
/** The database or a transaction on it. */
export type Executor = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

// Not `.pathname`, which keeps a path's spaces percent-encoded (e.g. a checkout in "~/Applications/2fiat Commander").
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Opens (or creates) the database and applies any pending migrations. Pass ":memory:" for tests. */
export function openDb(path: string, options: { migrationsFolder?: string } = {}): Db {
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    // Another process holding the write lock makes us wait, rather than fail with SQLITE_BUSY.
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    applyMigrations(sqlite, db, path, options.migrationsFolder ?? MIGRATIONS);
    sqlite.pragma("foreign_keys = ON");
    return db;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/**
 * Applies what's pending in one transaction, reading and writing drizzle's own table. This replaces drizzle's
 * `migrate()`, which can't do the two things a table rebuild needs:
 * - Foreign keys are off throughout, set before the transaction, as the pragma does nothing inside one. With them on,
 *   the `DROP TABLE` in a rebuild fires `ON DELETE CASCADE` and empties the child tables.
 * - `foreign_key_check` runs before the commit, so a migration that breaks a reference leaves nothing behind.
 * A database with data in it is copied first, to `pre-migration/` beside it. These copies are never pruned.
 */
function applyMigrations(sqlite: Database.Database, db: Db, path: string, folder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`);
  const pending = () => {
    const last = sqlite.prepare(`SELECT max(created_at) FROM ${MIGRATIONS_TABLE}`).pluck().get() as
      | number
      | null;
    return {
      fresh: last === null,
      todo: migrations.filter((m) => last === null || Number(last) < m.folderMillis),
    };
  };

  const { fresh, todo } = pending();
  if (todo.length === 0) return;
  if (!fresh) {
    const copy = backup(db, join(dirname(path), "pre-migration"));
    console.log(`applying ${todo.length} migration(s), with a copy of the database at ${copy}`);
  }

  const apply = sqlite.transaction(() => {
    // Again, now holding the write lock: another process may have got here first.
    for (const migration of pending().todo) {
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`)
        .run(migration.hash, migration.folderMillis);
    }
    const broken = sqlite.pragma("foreign_key_check") as { table: string }[];
    if (broken.length > 0) {
      const tables = [...new Set(broken.map((row) => row.table))].join(", ");
      throw new Error(
        `migrations left ${broken.length} broken foreign key(s) in ${tables}; none were applied`,
      );
    }
  });
  sqlite.pragma("foreign_keys = OFF");
  apply.immediate();
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
