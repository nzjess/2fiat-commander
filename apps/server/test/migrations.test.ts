import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_A, card } from "@twofiat/client/fixtures";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { type Db, openDb } from "../src/db/db.ts";
import { accounts, cards, grants, logicalCards, users } from "../src/db/schema.ts";

/** The connection behind `db`, which `Db` doesn't name because nothing outside these tests closes one. */
const client = (db: Db) => (db as unknown as { $client: Database.Database }).$client;

const REAL = fileURLToPath(new URL("../drizzle", import.meta.url));
const BREAK = "\n--> statement-breakpoint\n";

/** A copy of the real migrations, plus `extra` as later ones. */
function folderWith(...extra: string[]): string {
  const folder = mkdtempSync(join(tmpdir(), "commander-migrations-"));
  cpSync(REAL, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  extra.forEach((text, i) => {
    const tag = `900${i}_test`;
    writeFileSync(join(folder, `${tag}.sql`), text);
    journal.entries.push({ ...last, idx: last.idx + i + 1, tag, when: last.when + (i + 1) * 1000 });
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

/** A database at the real baseline, with a user, an account and a card that all hang off each other. */
function populated(): string {
  const path = join(mkdtempSync(join(tmpdir(), "commander-db-")), "commander.db");
  const db = openDb(path);
  const userId = db.insert(users).values({ username: "u", passwordHash: "x" }).returning().get().id;
  const accountId = db
    .insert(accounts)
    .values({ label: "main", tokenEnc: "x", tokenHash: "h" })
    .returning()
    .get().id;
  db.insert(grants).values({ accountId, userId, role: "owner" }).run();
  const logicalCardId = db.insert(logicalCards).values({ accountId, name: "Card" }).returning().get().id;
  const raw = card({ id: CARD_A, balance: 0 });
  db.insert(cards)
    .values({
      accountId,
      logicalCardId,
      isCurrent: true,
      twofiatId: raw.id,
      alias: raw.alias,
      maskedNumber: raw.cardNumber,
      currency: raw.currency,
      product: raw.cardProduct.title,
      status: raw.status,
      issuedAt: raw.createdAt,
      expiresAt: raw.expireDate,
      raw,
    })
    .run();
  client(db).close();
  return path;
}

/** How drizzle-kit rebuilds a table, from its real definition. Its pragmas do nothing inside a transaction. */
function rebuildOf(path: string, table: string): string {
  const raw = new Database(path, { readonly: true });
  const { sql } = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as {
    sql: string;
  };
  raw.close();
  return [
    "PRAGMA foreign_keys=OFF;",
    `${sql.replace(`\`${table}\``, `\`__new_${table}\``)};`,
    `INSERT INTO \`__new_${table}\` SELECT * FROM \`${table}\`;`,
    `DROP TABLE \`${table}\`;`,
    `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`,
    "PRAGMA foreign_keys=ON;",
  ].join(BREAK);
}

function counts(path: string) {
  const raw = new Database(path, { readonly: true });
  const count = (table: string) => raw.prepare(`SELECT count(*) AS n FROM ${table}`).pluck().get();
  const result = {
    accounts: count("accounts"),
    grants: count("grants"),
    logical_cards: count("logical_cards"),
    cards: count("cards"),
    migrations: count("__drizzle_migrations"),
  };
  raw.close();
  return result;
}

const copiesBeside = (path: string) => {
  const dir = join(path, "..", "pre-migration");
  return existsSync(dir) ? readdirSync(dir) : [];
};

const BEFORE = { accounts: 1, grants: 1, logical_cards: 1, cards: 1, migrations: 1 };

describe("migrations", () => {
  test("the baseline is frozen: schema changes are new migrations, never a regenerated baseline", () => {
    const baseline = readFileSync(join(REAL, "0000_init.sql"));
    expect(createHash("sha256").update(baseline).digest("hex")).toBe(
      "c09508e3998219d7cc0e052c7abb6f048846224eae173c2a64e6aa236cfafa5a",
    );
  });

  test("rebuilding a parent table keeps its cascading children", () => {
    const path = populated();
    expect(counts(path)).toEqual(BEFORE);
    const rebuild = rebuildOf(path, "accounts");

    // The hazard this guards against, so the test can't pass by not triggering it.
    const copy = `${path}.hazard`;
    const hazard = new Database(path, { readonly: true });
    hazard.exec(`VACUUM INTO '${copy}'`);
    hazard.close();
    const on = new Database(copy);
    on.pragma("foreign_keys = ON");
    on.transaction(() => {
      for (const statement of rebuild.split(BREAK)) on.exec(statement);
    })();
    on.close();
    expect(counts(copy).grants).toBe(0);

    client(openDb(path, { migrationsFolder: folderWith(rebuild) })).close();
    expect(counts(path)).toEqual({ ...BEFORE, migrations: 2 });
  });

  test("foreign keys are enforced afterwards, whether or not anything was pending", () => {
    const path = populated();
    const enforced = (db: Db) => client(db).pragma("foreign_keys", { simple: true });
    const migrated = openDb(path, { migrationsFolder: folderWith(rebuildOf(path, "accounts")) });
    expect(enforced(migrated)).toBe(1);
    client(migrated).close();
    const unchanged = openDb(path, { migrationsFolder: folderWith() });
    expect(enforced(unchanged)).toBe(1);
    client(unchanged).close();
  });

  test("a migration that breaks a reference applies nothing, and the database still opens", () => {
    const path = populated();
    const folder = folderWith("ALTER TABLE users ADD COLUMN extra text", "DELETE FROM accounts");
    expect(() => openDb(path, { migrationsFolder: folder })).toThrow(/broken foreign key.*grants/);
    expect(counts(path)).toEqual(BEFORE);
    client(openDb(path)).close();
  });

  test("a migration that fails applies nothing", () => {
    const path = populated();
    const folder = folderWith("ALTER TABLE users ADD COLUMN extra text", "THIS IS NOT SQL");
    expect(() => openDb(path, { migrationsFolder: folder })).toThrow();
    const raw = new Database(path, { readonly: true });
    const columns = raw.pragma("table_info(users)") as { name: string }[];
    raw.close();
    expect(columns.map((c) => c.name)).not.toContain("extra");
    expect(counts(path)).toEqual(BEFORE);
  });

  test("a populated database is copied before migrating, and the copy is the old one", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const path = populated();
    expect(copiesBeside(path)).toEqual([]);
    client(openDb(path, { migrationsFolder: folderWith("ALTER TABLE users ADD COLUMN extra text") })).close();
    const names = copiesBeside(path);
    expect(names).toHaveLength(1);
    expect(counts(join(path, "..", "pre-migration", names[0] as string))).toEqual(BEFORE);
    vi.restoreAllMocks();
  });

  test.each([
    ["succeeds", "ALTER TABLE users ADD COLUMN extra text"],
    ["fails", "THIS IS NOT SQL"],
  ])("only the newest 3 copies are kept when a migration %s", (outcome, migration) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const path = populated();
    const dir = join(path, "..", "pre-migration");
    mkdirSync(dir);
    const older = ["20200101", "20200102", "20200103", "20200104"].map((day) => `commander-${day}-000000.db`);
    for (const name of [...older, "keep-me.txt"]) writeFileSync(join(dir, name), "");

    const open = () => client(openDb(path, { migrationsFolder: folderWith(migration) })).close();
    if (outcome === "fails") expect(open).toThrow();
    else open();

    const names = copiesBeside(path);
    expect(names).toContain("keep-me.txt");
    expect(names).toContain(older[3]);
    expect(names).toContain(older[2]);
    expect(names).not.toContain(older[1]);
    expect(names).not.toContain(older[0]);
    expect(names).toHaveLength(4);
    vi.restoreAllMocks();
  });

  test("nothing is copied for a new database, or with nothing pending", () => {
    const path = populated();
    expect(copiesBeside(path)).toEqual([]);
    client(openDb(path)).close();
    expect(copiesBeside(path)).toEqual([]);
  });

  test("a later open doesn't apply a migration again", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const path = populated();
    const folder = folderWith("ALTER TABLE users ADD COLUMN extra text");
    client(openDb(path, { migrationsFolder: folder })).close();
    client(openDb(path, { migrationsFolder: folder })).close();
    expect(counts(path).migrations).toBe(2);
    expect(copiesBeside(path)).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
