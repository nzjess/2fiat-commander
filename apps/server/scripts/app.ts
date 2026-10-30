import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backup } from "../src/backup.ts";
import { REPO_ROOT } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import {
  DEFAULT_CONFIG,
  installedEnv,
  installedPaths,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  LABEL,
  launchdPlist,
} from "../src/installed.ts";

// The installed app on this Mac (see src/installed.ts):
//   pnpm app install|update     build the web app, then (re)start the launchd agent from this checkout
//   pnpm app restart            restart the agent
//   pnpm app uninstall          remove all the install made but the data (the database, backups, config.env)
//                               and the Keychain secret, which the data can't be read without
//   pnpm app status|logs|open
//   pnpm app user:add|user:passwd <username>
//   pnpm app backup
//   (run: what the agent runs)

const SECURITY = "/usr/bin/security";
const SCRIPT = fileURLToPath(import.meta.url);
const paths = installedPaths(homedir());
const target = `gui/${process.getuid?.()}`;

const env = () =>
  installedEnv(paths, REPO_ROOT, existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "");
const url = () => `http://localhost:${env().PORT}`;

function readSecret(): string | undefined {
  try {
    const secret = execFileSync(
      SECURITY,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

/** Creates the app secret in the login Keychain unless it's there. It goes in through stdin, never argv. */
function ensureSecret(): void {
  if (readSecret()) return;
  const secret = randomBytes(32).toString("base64");
  execFileSync(SECURITY, ["-i"], {
    input: `add-generic-password -s "${KEYCHAIN_SERVICE}" -a ${KEYCHAIN_ACCOUNT} -w ${secret}\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (!readSecret()) throw new Error("couldn't store the app secret in the Keychain");
  console.log(`created the app secret in the login Keychain ("${KEYCHAIN_SERVICE}")`);
}

const launchctl = (...args: string[]) => spawnSync("launchctl", args, { encoding: "utf8" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops the agent, if it's loaded. `bootout` returns before launchd lets go of it, and bootstrapping it again before
 * then fails ("Bootstrap failed: 5: Input/output error"), so this waits until it's gone.
 */
async function bootout(): Promise<void> {
  if (launchctl("bootout", `${target}/${LABEL}`).status !== 0) return;
  const deadline = Date.now() + 15_000;
  while (launchctl("print", `${target}/${LABEL}`).status === 0) {
    if (Date.now() > deadline) throw new Error("the agent didn't stop within 15 seconds");
    await sleep(100);
  }
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url()}/api/health`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function install(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("the installed app runs on macOS only");
  execFileSync("pnpm", ["--filter", "@twofiat/web", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  ensureSecret();
  mkdirSync(paths.backups, { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });
  mkdirSync(dirname(paths.plist), { recursive: true });
  if (!existsSync(paths.config)) writeFileSync(paths.config, DEFAULT_CONFIG);
  // The node running this, so the agent keeps the pinned version; an update rewrites it.
  writeFileSync(
    paths.plist,
    launchdPlist({ node: process.execPath, script: SCRIPT, repoRoot: REPO_ROOT, log: paths.log }),
  );
  await bootout();
  const boot = launchctl("bootstrap", target, paths.plist);
  if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
  if (!(await healthy(15_000))) {
    console.error(`installed, but the server didn't answer: see ${paths.log}`);
    process.exit(1);
  }
  console.log(`running ${REPO_ROOT} at ${url()}`);
  console.log(`data in ${paths.support}`);
}

async function run(): Promise<void> {
  const secret = readSecret();
  if (!secret) {
    console.error(`no app secret in the login Keychain ("${KEYCHAIN_SERVICE}"): run pnpm app install`);
    process.exit(78);
  }
  Object.assign(process.env, env(), { APP_SECRET: secret });
  await import("../src/main.ts");
}

/** The checkout the agent runs, from its plist. */
function installedCheckout(): string | undefined {
  if (!existsSync(paths.plist)) return undefined;
  const program = readFileSync(paths.plist, "utf8").match(/<string>([^<]*scripts\/app\.ts)<\/string>/)?.[1];
  return program ? join(dirname(program), "..", "..", "..") : undefined;
}

async function uninstall(): Promise<void> {
  const checkout = installedCheckout();
  await bootout();
  const removed = [
    paths.plist,
    dirname(paths.log),
    ...(checkout ? [join(checkout, "apps", "web", "dist")] : []),
  ]
    .filter((path) => existsSync(path))
    .map((path) => {
      rmSync(path, { recursive: true, force: true });
      return path;
    });
  console.log(
    removed.length > 0 ? `stopped the agent and removed:\n  ${removed.join("\n  ")}` : "not installed",
  );
  if (!existsSync(paths.support) && !readSecret()) return;
  console.log(`kept the data in ${paths.support} and the app secret in the login Keychain ("${KEYCHAIN_SERVICE}"),
which the data can't be read without. To delete them too, for good:
  rm -r "${paths.support}"
  security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a ${KEYCHAIN_ACCOUNT}`);
}

async function status(): Promise<void> {
  if (!existsSync(paths.plist)) {
    console.log("not installed");
    return;
  }
  const printed = launchctl("print", `${target}/${LABEL}`);
  const field = (name: string) => printed.stdout.match(new RegExp(`^\\s*${name} = (.*)$`, "m"))?.[1];
  console.log(`agent:    ${printed.status === 0 ? (field("state") ?? "loaded") : "not loaded"}`);
  if (field("pid")) console.log(`pid:      ${field("pid")}`);
  const checkout = installedCheckout();
  if (checkout) console.log(`checkout: ${checkout}`);
  console.log(`server:   ${(await healthy(1_000)) ? `answering at ${url()}` : "not answering"}`);
  console.log(`data:     ${paths.support}`);
  console.log(`log:      ${paths.log}`);
}

function user(command: "add" | "passwd", username: string | undefined): void {
  if (!username) {
    console.error(`usage: pnpm app user:${command} <username>`);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [join(dirname(SCRIPT), "user.ts"), command, username], {
    env: { ...process.env, DATABASE_PATH: paths.database },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "install":
  case "update":
    await install();
    break;
  case "restart": {
    const kicked = launchctl("kickstart", "-k", `${target}/${LABEL}`);
    if (kicked.status !== 0) throw new Error(`launchctl kickstart failed: ${kicked.stderr.trim()}`);
    console.log(
      (await healthy(15_000)) ? `restarted at ${url()}` : `restarted, but not answering: see ${paths.log}`,
    );
    break;
  }
  case "uninstall":
    await uninstall();
    break;
  case "status":
    await status();
    break;
  case "logs":
    spawnSync("tail", ["-n", "100", "-f", paths.log], { stdio: "inherit" });
    break;
  case "open":
    execFileSync("open", [url()]);
    break;
  case "user:add":
    user("add", arg);
    break;
  case "user:passwd":
    user("passwd", arg);
    break;
  case "backup":
    if (!existsSync(paths.database)) throw new Error(`no database at ${paths.database}`);
    console.log(`backed up to ${backup(openDb(paths.database), paths.backups)}`);
    break;
  case "run":
    await run();
    break;
  default:
    console.error(
      "usage: pnpm app install|update|restart|uninstall|status|logs|open|backup|user:add <name>|user:passwd <name>",
    );
    process.exit(2);
}
