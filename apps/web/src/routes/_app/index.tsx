import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLastAccount } from "../../lib/storage.ts";
import { accountsQuery } from "../../queries.ts";

/** Home: the last account viewed, else the first active one, else the accounts page to add one. */
export const Route = createFileRoute("/_app/")({
  beforeLoad: async ({ context }) => {
    const accounts = await context.queryClient.ensureQueryData(accountsQuery);
    const last = getLastAccount();
    const target =
      accounts.find((a) => String(a.id) === last) ??
      accounts.find((a) => a.archivedAt === null) ??
      accounts[0];
    if (!target) throw redirect({ to: "/accounts" });
    throw redirect({ to: "/a/$accountId", params: { accountId: String(target.id) } });
  },
});
