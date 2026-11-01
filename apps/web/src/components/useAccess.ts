import { useSuspenseQuery } from "@tanstack/react-query";
import { accessOf } from "../lib/access.ts";
import { accountQuery } from "../queries.ts";

/** What the user may do on the account. For hiding what they can't: the server checks every request anyway. */
export function useAccess(accountId: string) {
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  return accessOf(account.access);
}
