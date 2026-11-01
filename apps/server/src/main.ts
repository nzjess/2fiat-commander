import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { Backups } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/db.ts";
import { FxMirror } from "./fx.ts";
import { rebuildOutdated } from "./reevaluate.ts";
import { Scheduler } from "./scheduler.ts";
import { Secrets } from "./secrets.ts";
import { SyncRunner } from "./sync.ts";
import { withWeb } from "./web.ts";

const config = loadConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const db = openDb(config.databasePath);
const secrets = new Secrets(config.appSecret);
const runner = new SyncRunner({ db, secrets, overlapDays: config.syncOverlapDays });

const interrupted = runner.recover();
if (interrupted > 0) console.log(`marked ${interrupted} interrupted sync(s) failed`);
try {
  const rebuilt = rebuildOutdated(db, new Date());
  if (rebuilt.length > 0) console.log(`rebuilt the ledger of account(s) ${rebuilt.join(", ")}`);
} catch (err) {
  // The raw rows are kept and the ledger stays marked dirty, so the next sync retries it.
  console.error("rebuilding outdated ledgers failed:", err);
}
if (config.syncIntervalMinutes > 0) {
  new Scheduler({ db, runner, intervalMinutes: config.syncIntervalMinutes }).start();
  console.log(`syncing every ${config.syncIntervalMinutes} minutes`);
}

new FxMirror({ db }).start();

if (config.backupDir) {
  new Backups({ db, dir: config.backupDir, keep: config.backupKeep }).start();
  console.log(`backing up daily to ${config.backupDir}`);
}

const api = createApp({ db, secrets, runner, signupEnabled: config.signupEnabled });
const app = config.webDist ? withWeb(api, config.webDist) : api;

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`server listening on http://${config.host}:${info.port}`);
});
