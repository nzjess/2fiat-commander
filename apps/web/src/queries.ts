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

/** The display currency and its USD rates. Rates change daily, so an hour is fresh enough. */
export const fxQuery = queryOptions({
  queryKey: ["fx"],
  queryFn: () => ok(api.fx.$get()),
  staleTime: 3_600_000,
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

/** The account's categories. */
export const categoriesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "categories"],
    queryFn: () => ok(account.categories.$get({ param: { accountId } })),
  });

/** The account's category rules, in order. Under its categories, so a category change refreshes them too. */
export const rulesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "categories", "rules"],
    queryFn: () => ok(account.categories.rules.$get({ param: { accountId } })),
  });

/** Who has which role on the account and its cards: for owners. */
export const grantsQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "grants"],
    queryFn: () => ok(account.grants.$get({ param: { accountId } })),
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

export const balanceHistoryQuery = (accountId: string, logicalCardId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "balance-history", logicalCardId],
    queryFn: () =>
      ok(
        account["logical-cards"][":logicalCardId"]["balance-history"].$get({
          param: { accountId, logicalCardId: String(logicalCardId) },
        }),
      ),
  });

/** A page of activities, newest first: `params` from `activitiesParams`, and the previous page's `nextCursor`. */
export const activitiesQuery = (accountId: string, params: Record<string, string>, cursor?: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "activities", "list", params, cursor ?? null],
    queryFn: () =>
      ok(account.activities.$get({ param: { accountId }, query: { ...params, ...(cursor && { cursor }) } })),
  });

export const activityQuery = (accountId: string, activityId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "activities", activityId],
    queryFn: () =>
      ok(account.activities[":activityId"].$get({ param: { accountId, activityId: String(activityId) } })),
  });

/** The account's other uncategorised spending from the same merchant as the activity. */
export const sameMerchantQuery = (accountId: string, activityId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "activities", activityId, "same-merchant"],
    queryFn: () =>
      ok(
        account.activities[":activityId"]["same-merchant"].$get({
          param: { accountId, activityId: String(activityId) },
        }),
      ),
  });

export const cashFlowQuery = (accountId: string, logicalCardId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "cash-flow", logicalCardId],
    queryFn: () =>
      ok(
        account["logical-cards"][":logicalCardId"]["cash-flow"].$get({
          param: { accountId, logicalCardId: String(logicalCardId) },
        }),
      ),
  });

export const feeSchedulesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ["accounts", accountId, "fee-schedules"],
    queryFn: () => ok(account["fee-schedules"].$get({ param: { accountId }, query: {} })),
  });

export const feesQuery = (accountId: string, logicalCardId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "fees", logicalCardId],
    queryFn: () =>
      ok(
        account["logical-cards"][":logicalCardId"].fees.$get({
          param: { accountId, logicalCardId: String(logicalCardId) },
        }),
      ),
  });

export const adjustmentsQuery = (accountId: string, logicalCardId: number) =>
  queryOptions({
    queryKey: ["accounts", accountId, "adjustments", logicalCardId],
    queryFn: () =>
      ok(account.adjustments.$get({ param: { accountId }, query: { logicalCardId: String(logicalCardId) } })),
  });

/** An account's findings, or with `card` a logical card's. */
export const findingsQuery = (accountId: string, search: FindingsSearch & { card?: number }) =>
  queryOptions({
    queryKey: ["accounts", accountId, "findings", search],
    queryFn: () =>
      ok(
        account.findings.$get({
          param: { accountId },
          query: {
            status: search.status ?? "open",
            ...(search.card === undefined ? {} : { logicalCardId: String(search.card) }),
            ...(search.kind === undefined ? {} : { kind: search.kind }),
          },
        }),
      ),
  });
