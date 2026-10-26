import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKBACK_DAYS } from "@twofiat/client";
import { z } from "zod";

/** Relative paths in the config resolve against the repo root, wherever the process was started from. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const Env = z.object({
  /** 32+ random bytes, base64: the key material for encryption at rest. */
  APP_SECRET: z.string().min(1, "APP_SECRET is required"),
  DATABASE_PATH: z.string().default("data/commander.db"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  SYNC_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(LOOKBACK_DAYS),
  /** How often each account syncs on its own, in minutes. 0 (the default) leaves syncing to the user. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(0),
});

export interface Config {
  appSecret: string;
  databasePath: string;
  host: string;
  port: number;
  syncOverlapDays: number;
  syncIntervalMinutes: number;
}

/** The database path alone, for tools that don't need the rest of the config (e.g. the user CLI). */
export function databasePath(env: Record<string, string | undefined> = process.env): string {
  const path = env.DATABASE_PATH || "data/commander.db";
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const e = parsed.data;
  return {
    appSecret: e.APP_SECRET,
    databasePath: databasePath({ DATABASE_PATH: e.DATABASE_PATH }),
    host: e.HOST,
    port: e.PORT,
    syncOverlapDays: e.SYNC_OVERLAP_DAYS,
    syncIntervalMinutes: e.SYNC_INTERVAL_MINUTES,
  };
}
