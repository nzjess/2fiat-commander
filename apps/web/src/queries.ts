import { queryOptions } from "@tanstack/react-query";
import { api, ok } from "./api.ts";
import type { FindingsSearch } from "./lib/search.ts";

// Keys: everything about an account sits under ["accounts", accountId], so one invalidation of ["accounts"]
// refreshes it all after a sync. Account ids are numeric strings, so they never clash with "list".

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => ok(api.auth.me.$get()),
  staleTime: Number.POSITIVE_INFINITY,
});

export const accountsQuery = queryOptions({
  queryKey: ["accounts", "list"],
  queryFn: () => ok(api.accounts.$get()),
});

const account = api.accounts[":accountId"];

export const accountQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId],
    queryFn: () => ok(account.$get({ param: { accountId } })),
  });

export const cardsQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "cards"],
    queryFn: () => ok(account.cards.$get({ param: { accountId } })),
  });

export const logicalCardsQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "logical-cards"],
    queryFn: () => ok(account["logical-cards"].$get({ param: { accountId } })),
  });

export const snapshotsQuery = (accountId: string, cardId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "snapshots", cardId],
    queryFn: () => ok(account.snapshots.$get({ param: { accountId }, query: { cardId: String(cardId) } })),
  });

export const findingsQuery = (accountId: string, search: FindingsSearch) =>
  queryOptions({
    queryKey: ["accounts", accountId, "findings", search],
    queryFn: () =>
      ok(
        account.findings.$get({
          param: { accountId },
          query: {
            status: search.status ?? "open",
            ...(search.cardId === undefined ? {} : { cardId: String(search.cardId) }),
            ...(search.kind === undefined ? {} : { kind: search.kind }),
          },
        }),
      ),
  });
