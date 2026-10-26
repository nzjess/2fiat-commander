import { Alert, Stack } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AnchorLink } from "../../../components/links.tsx";
import { setLastAccount } from "../../../lib/storage.ts";
import { accountQuery } from "../../../queries.ts";

/** One account's pages. Remembers the account for next time, and marks an archived one. */
export const Route = createFileRoute("/_app/a/$accountId")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(accountQuery(params.accountId)),
  component: AccountLayout,
});

function AccountLayout() {
  const { accountId } = Route.useParams();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  useEffect(() => setLastAccount(accountId), [accountId]);

  return (
    <Stack>
      {account.archivedAt !== null && (
        <Alert color="gray" variant="light" title="Archived account">
          2fiat replaced this account's token, so it no longer syncs. Its history stays here to view.
          {account.replacedByAccountId !== null && (
            <>
              {" "}
              <AnchorLink
                to="/a/$accountId"
                params={{ accountId: String(account.replacedByAccountId) }}
                size="sm"
              >
                Go to its replacement
              </AnchorLink>
              .
            </>
          )}
        </Alert>
      )}
      <Outlet />
    </Stack>
  );
}
