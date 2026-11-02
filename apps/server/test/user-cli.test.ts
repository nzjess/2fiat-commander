import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { checkPassword, createSession, resolveSession } from "../src/auth.ts";
import { openDb } from "../src/db/db.ts";
import { users } from "../src/db/schema.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/user.ts", import.meta.url));

const scratchDb = () => join(mkdtempSync(join(tmpdir(), "commander-user-cli-")), "commander.db");

/** Runs the CLI against `path`, with the password piped in. */
const run = (path: string, args: string[], password: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    input: `${password}\n`,
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: path },
  });

describe("user.ts set", () => {
  test("creates a user who doesn't exist", { timeout: 30_000 }, async () => {
    const path = scratchDb();
    const result = run(path, ["set", "Sam"], "first-password-1");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added user Sam");
    expect(await checkPassword(openDb(path), "Sam", "first-password-1")).toBeDefined();
  });

  test("resets an existing user, in any case, and signs them out", { timeout: 30_000 }, async () => {
    const path = scratchDb();
    expect(run(path, ["set", "Sam"], "first-password-1").status).toBe(0);
    const db = openDb(path);
    const id = db.select().from(users).where(eq(users.username, "Sam")).get()?.id as number;
    const now = new Date();
    const { token } = createSession(db, id, now);

    const result = run(path, ["set", "sam"], "second-password-2");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed the password of sam");

    expect(
      db
        .select()
        .from(users)
        .all()
        .map((u) => u.username),
    ).toEqual(["Sam"]);
    expect(await checkPassword(db, "Sam", "first-password-1")).toBeUndefined();
    expect(await checkPassword(db, "Sam", "second-password-2")).toBeDefined();
    expect(resolveSession(db, token, now)).toBeUndefined();
  });

  test("refuses a bad username or a short password", { timeout: 30_000 }, () => {
    const path = scratchDb();
    expect(run(path, ["set", "not an email@example"], "first-password-1").status).toBe(1);
    expect(run(path, ["set", "Sam"], "short").status).toBe(1);
    expect(openDb(path).select().from(users).all()).toEqual([]);
  });

  test("passwd still needs an existing user, and add a new one", { timeout: 30_000 }, () => {
    const path = scratchDb();
    expect(run(path, ["passwd", "Sam"], "first-password-1").status).toBe(1);
    expect(run(path, ["add", "Sam"], "first-password-1").status).toBe(0);
    expect(run(path, ["add", "Sam"], "second-password-2").status).toBe(1);
  });
});
