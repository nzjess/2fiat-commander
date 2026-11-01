import { Button, Group, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ok, type Sync } from "../api.ts";
import { accessOf } from "../lib/access.ts";
import { timeAgo } from "../lib/format.ts";
import { accountQuery } from "../queries.ts";

/** Without the error, either because none was recorded or because it's about the whole account. */
const NO_ERROR = "No error to show.";

/**
 * Starts a sync and follows it. The account's `lastSync` is the source of truth: while it's running, the account
 * is polled every second, so a sync started elsewhere (or before a reload) shows too. When it finishes, all of
 * the account's data is refetched.
 */
export function SyncButton({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const { data: account } = useQuery({
    ...accountQuery(accountId),
    refetchInterval: (q) => (q.state.data?.lastSync?.status === "running" ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: () => ok(api.accounts[":accountId"].syncs.$post({ param: { accountId } })),
    onSuccess: (sync) =>
      queryClient.setQueryData(accountQuery(accountId).queryKey, (a) => a && { ...a, lastSync: sync }),
    onError: (error) =>
      notifications.show({ color: "red", title: "Couldn't start a sync", message: error.message }),
  });

  const sync = account?.lastSync ?? null;
  const previous = useRef<{ accountId: string; sync: Sync | null }>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = { accountId, sync };
    if (before?.accountId !== accountId || before.sync?.status !== "running" || sync?.status === "running")
      return;
    if (sync?.id !== before.sync.id) return;
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    if (sync.status === "ok") {
      notifications.show({
        color: "green",
        title: "Synced",
        message: describeRows(sync) ?? "The account is up to date.",
      });
    } else {
      notifications.show({
        color: "red",
        title: `Sync failed${sync.failedStage ? ` at ${sync.failedStage}` : ""}`,
        message: sync.error ?? NO_ERROR,
        autoClose: false,
      });
    }
  }, [accountId, sync, queryClient]);

  if (!account || account.archivedAt !== null) return null;
  const running = sync?.status === "running" || start.isPending;
  return (
    <Group gap="xs" wrap="nowrap">
      <SyncStatus sync={sync} />
      {accessOf(account.access).canOnAnyCard("card.sync") && (
        <Button size="xs" variant="light" loading={running} onClick={() => start.mutate()}>
          Sync
        </Button>
      )}
    </Group>
  );
}

/** The current time, ticking every `ms`, so a relative time like "5 minutes ago" keeps up. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function SyncStatus({ sync }: { sync: Sync | null }) {
  const now = useNow(15_000);
  if (!sync) {
    return (
      <Text size="xs" c="dimmed" visibleFrom="md">
        Never synced
      </Text>
    );
  }
  if (sync.status === "running") {
    return (
      <Text size="xs" c="dimmed" visibleFrom="md">
        Syncing…
      </Text>
    );
  }
  const when = timeAgo(sync.finishedAt ?? sync.startedAt, now);
  if (sync.status === "failed") {
    return (
      <Tooltip label={sync.error ?? NO_ERROR} multiline w={320}>
        <Text size="xs" c="red" visibleFrom="md">
          Sync failed {when}
        </Text>
      </Tooltip>
    );
  }
  const synced = (
    <Text size="xs" c="dimmed" visibleFrom="md">
      Synced {when}
    </Text>
  );
  const rows = describeRows(sync);
  return rows ? <Tooltip label={rows}>{synced}</Tooltip> : synced;
}

/** What a sync did, for those who get to see it: it covers the whole account. */
function describeRows(sync: Sync) {
  if (sync.rowsNew === null) return undefined;
  const parts = [`${sync.rowsNew} new`, `${sync.rowsUpdated} changed`];
  if ((sync.rowsMissing ?? 0) > 0) parts.push(`${sync.rowsMissing} missing`);
  return `${parts.join(", ")} rows`;
}
