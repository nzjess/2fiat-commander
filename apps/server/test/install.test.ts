import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { Backups, backup, backupName, backupTime, listBackups, pruneBackups } from "../src/backup.ts";
import { loadConfig, REPO_ROOT } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { users } from "../src/db/schema.ts";
import { DEFAULT_CONFIG, installedEnv, installedPaths, LABEL, launchdPlist } from "../src/installed.ts";
import { withWeb } from "../src/web.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "commander-test-"));

describe("backups", () => {
  test("are named by their UTC time, which reads back", () => {
    const at = new Date("2026-10-28T07:05:09.123Z");
    expect(backupName(at)).toBe("commander-20261028-070509.db");
    expect(backupTime(backupName(at))).toEqual(new Date("2026-10-28T07:05:09Z"));
    expect(backupTime("notes.txt")).toBeUndefined();
  });

  test("are consistent copies of the database", () => {
    const dir = tempDir();
    const db = openDb(join(dir, "commander.db"));
    db.insert(users).values({ username: "u", passwordHash: "x" }).run();
    const path = backup(db, join(dir, "backups"));
    const copy = new Database(path, { readonly: true });
    expect(copy.prepare("SELECT username FROM users").all()).toEqual([{ username: "u" }]);
    copy.close();
  });

  test("prune keeps the newest, and leaves other files alone", () => {
    const dir = tempDir();
    for (const day of [1, 2, 3, 4]) writeFileSync(join(dir, backupName(new Date(`2026-10-0${day}`))), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(pruneBackups(dir, 2)).toEqual(["commander-20261002-000000.db", "commander-20261001-000000.db"]);
    expect(listBackups(dir)).toEqual(["commander-20261004-000000.db", "commander-20261003-000000.db"]);
    expect(readdirSync(dir)).toContain("notes.txt");
    expect(listBackups(join(dir, "missing"))).toEqual([]);
  });

  test("the daily backup runs once the newest is a day old", () => {
    const dir = tempDir();
    const db = openDb(":memory:");
    let now = new Date("2026-10-28T09:00:00Z");
    const backups = new Backups({ db, dir, keep: 2, now: () => now });
    expect(backups.run()).toBe(join(dir, "commander-20261028-090000.db"));
    now = new Date("2026-10-29T08:59:59Z");
    expect(backups.run()).toBeUndefined();
    now = new Date("2026-10-29T09:00:00Z");
    expect(backups.run()).toBeDefined();
    now = new Date("2026-10-30T09:00:00Z");
    backups.run();
    expect(listBackups(dir)).toEqual(["commander-20261030-090000.db", "commander-20261029-090000.db"]);
  });
});

describe("withWeb", () => {
  const dist = tempDir();
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<html>app</html>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  const api = new Hono().basePath("/api").get("/health", (c) => c.json({ ok: true }));
  const app = withWeb(api, dist);

  test("passes /api to the API, unmatched routes included", async () => {
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
    expect((await app.request("/api/nope")).status).toBe(404);
  });

  test("serves files, caching the hashed assets for good", async () => {
    const res = await app.request("/assets/index-abc.js");
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("cache-control")).toContain("immutable");
    // A missing asset is a 404, not the app: a stale index.html must not be handed a page in place of a script.
    const missing = await app.request("/assets/missing.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
  });

  test("answers client-side routes with index.html, revalidated each time", async () => {
    for (const path of ["/", "/a/1/activity"]) {
      const res = await app.request(path);
      expect(await res.text()).toBe("<html>app</html>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });
});

describe("the installed app", () => {
  const paths = installedPaths("/Users/me");

  test("keeps its data and log outside the checkout", () => {
    expect(paths.database).toBe("/Users/me/Library/Application Support/2fiat Commander/commander.db");
    expect(paths.log).toBe("/Users/me/Library/Logs/2fiat Commander/server.log");
    expect(paths.plist).toBe(`/Users/me/Library/LaunchAgents/${LABEL}.plist`);
  });

  test("its env loads, and config.env overrides the defaults", () => {
    const env = installedEnv(paths, "/repo", DEFAULT_CONFIG);
    const config = loadConfig({ ...env, APP_SECRET: "s" });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4310,
      databasePath: paths.database,
      backupDir: paths.backups,
      webDist: "/repo/apps/web/dist",
      syncIntervalMinutes: 360,
      backupKeep: 14,
    });
    expect(installedEnv(paths, "/repo", "PORT=5000\n").PORT).toBe("5000");
  });

  test("the launchd plist runs the checkout's app.ts, with its paths escaped", () => {
    const plist = launchdPlist({
      node: "/n/node",
      script: "/R&D/apps/server/scripts/app.ts",
      repoRoot: "/R&D",
      log: paths.log,
    });
    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain(
      "<string>/n/node</string>\n    <string>/R&amp;D/apps/server/scripts/app.ts</string>",
    );
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>/R&amp;D</string>");
  });
});

test("the config resolves relative web and backup paths against the repo root", () => {
  expect(loadConfig({ APP_SECRET: "s", WEB_DIST: "apps/web/dist", BACKUP_DIR: "/b" })).toMatchObject({
    webDist: join(REPO_ROOT, "apps/web/dist"),
    backupDir: "/b",
    backupKeep: 14,
  });
  expect(loadConfig({ APP_SECRET: "s" })).toMatchObject({ webDist: undefined, backupDir: undefined });
});
