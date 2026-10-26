import type { Db } from "./db/db.ts";
import { accounts } from "./db/schema.ts";
import type { Secrets } from "./secrets.ts";

/** The `token1…` segment of an account's 2fiat login link. */
export const TOKEN_PATTERN = /^token1[a-z0-9]+$/i;

/** Adds a 2fiat account for a user, with its token encrypted. A user adding the same token twice is refused. */
export function createAccount(
  db: Db,
  secrets: Secrets,
  input: { userId: number; label: string; token: string },
): number {
  if (!TOKEN_PATTERN.test(input.token)) throw new Error("not a 2fiat account token");
  return db
    .insert(accounts)
    .values({
      userId: input.userId,
      label: input.label,
      tokenEnc: secrets.encrypt(input.token),
      tokenHash: secrets.hash(input.token),
    })
    .returning({ id: accounts.id })
    .get().id;
}
