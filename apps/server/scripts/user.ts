import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createUser,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  setPassword,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from "../src/auth.ts";
import { databasePath } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";

// For setting up a user by hand, and the only way to change a password.
//   pnpm user:add <username>      pnpm user:passwd <username>
//   pnpm user:set <username>      creates the user, or changes their password if they exist

const [command, username] = process.argv.slice(2);
if ((command !== "add" && command !== "passwd" && command !== "set") || !username) {
  console.error("usage: user.ts add|passwd|set <username>");
  process.exit(2);
}

if (command !== "passwd" && !USERNAME_PATTERN.test(username)) {
  console.error(`a username ${USERNAME_RULE}`);
  process.exit(1);
}

/** Reads a line from the terminal without echoing it, or from stdin when it's piped. */
async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let input = "";
    for await (const chunk of stdin) input += chunk;
    return input.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

const password = await readPassword("password: ");
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  process.exit(1);
}
if (process.stdin.isTTY && (await readPassword("again: ")) !== password) {
  console.error("the passwords don't match");
  process.exit(1);
}

const path = databasePath();
mkdirSync(dirname(path), { recursive: true });
const db = openDb(path);
const hashed = await hashPassword(password);
if (command === "add") {
  try {
    createUser(db, username, hashed);
  } catch (err) {
    if (!String(err).includes("UNIQUE constraint failed")) throw err;
    console.error(`user ${username} already exists`);
    process.exit(1);
  }
  console.log(`added user ${username}`);
} else if (setPassword(db, username, hashed)) {
  console.log(`changed the password of ${username}, and signed them out everywhere`);
} else if (command === "set") {
  createUser(db, username, hashed);
  console.log(`added user ${username}`);
} else {
  console.error(`no user ${username}`);
  process.exit(1);
}
