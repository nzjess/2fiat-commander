import { describe, expect, test } from "vitest";
import { createAccount, DuplicateAccountError } from "../src/accounts.ts";
import { openDb } from "../src/db/db.ts";
import { users } from "../src/db/schema.ts";
import { Secrets } from "../src/secrets.ts";

const secrets = new Secrets(Buffer.alloc(32, 1).toString("base64"));

describe("Secrets", () => {
  test("round-trips, with a fresh IV each time", () => {
    const a = secrets.encrypt("token1abc");
    expect(a).toMatch(/^v1:/);
    expect(secrets.encrypt("token1abc")).not.toBe(a);
    expect(secrets.decrypt(a)).toBe("token1abc");
  });

  test("rejects a tampered value or another key", () => {
    const [v, iv, ct, tag] = secrets.encrypt("token1abc").split(":") as string[];
    const flipped = `${ct?.[0] === "A" ? "B" : "A"}${ct?.slice(1)}`;
    expect(() => secrets.decrypt([v, iv, flipped, tag].join(":"))).toThrow();
    const other = new Secrets(Buffer.alloc(32, 2).toString("base64"));
    expect(() => other.decrypt(secrets.encrypt("token1abc"))).toThrow();
  });

  test("hashes deterministically, with a key of its own", () => {
    expect(secrets.hash("token1abc")).toBe(secrets.hash("token1abc"));
    expect(new Secrets(Buffer.alloc(32, 2).toString("base64")).hash("token1abc")).not.toBe(
      secrets.hash("token1abc"),
    );
  });

  test("refuses a short app secret", () => {
    expect(() => new Secrets(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("createAccount", () => {
  test("refuses malformed tokens, and the same token twice for a user", () => {
    const db = openDb(":memory:");
    const userId = db.insert(users).values({ username: "u", passwordHash: "x" }).returning().get().id;
    expect(() => createAccount(db, secrets, { userId, label: "a", token: "https://2fiat.com" })).toThrow();
    createAccount(db, secrets, { userId, label: "a", token: "token1abc" });
    expect(() => createAccount(db, secrets, { userId, label: "b", token: "token1abc" })).toThrow(
      DuplicateAccountError,
    );
  });
});
