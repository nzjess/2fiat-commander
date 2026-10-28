import { join } from "node:path";
import { parseEnv } from "node:util";

// The installed app: this checkout run by a launchd agent on the user's Mac, with its data outside the repo (so dev,
// which wipes `data/`, never touches it) and the app secret in the login Keychain. `scripts/app.ts` drives it.

export const LABEL = "com.ubercraft.2fiat-commander";
export const KEYCHAIN_SERVICE = "2fiat Commander";
export const KEYCHAIN_ACCOUNT = "APP_SECRET";

export interface InstalledPaths {
  /** Holds the database, the backups and `config.env`. */
  support: string;
  database: string;
  backups: string;
  config: string;
  log: string;
  plist: string;
}

export function installedPaths(home: string): InstalledPaths {
  const support = join(home, "Library", "Application Support", "2fiat Commander");
  return {
    support,
    database: join(support, "commander.db"),
    backups: join(support, "backups"),
    config: join(support, "config.env"),
    log: join(home, "Library", "Logs", "2fiat Commander", "server.log"),
    plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
}

/** `config.env` as the install first writes it. The user edits it, then runs `pnpm app restart`. */
export const DEFAULT_CONFIG = `# 2fiat Commander's settings. Run \`pnpm app restart\` after changing them.
# Not the app secret: that lives in the login Keychain.

# Off the dev server's 3000, so both can run.
PORT=4310

# How often each account syncs on its own, in minutes (0 turns it off).
SYNC_INTERVAL_MINUTES=360

# How many daily backups to keep.
BACKUP_KEEP=14
`;

/** The server's env, but for the secret: the installed paths, then whatever `config.env` sets. */
export function installedEnv(
  paths: InstalledPaths,
  repoRoot: string,
  configText = "",
): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    PORT: "4310",
    DATABASE_PATH: paths.database,
    BACKUP_DIR: paths.backups,
    WEB_DIST: join(repoRoot, "apps", "web", "dist"),
    ...parseEnv(configText),
  };
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The launchd agent: runs `app.ts run` with this node at login, and again whenever it exits. */
export function launchdPlist(options: {
  node: string;
  script: string;
  repoRoot: string;
  log: string;
}): string {
  const args = [options.node, options.script, "run"].map((arg) => `    <string>${xml(arg)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.log)}</string>
</dict>
</plist>
`;
}
