import { Badge, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api, type Card, type LogicalCard, ok } from "../../../../api.ts";
import { CardFace } from "../../../../components/CardFace.tsx";
import { AnchorLink } from "../../../../components/links.tsx";
import { GapBadge, TransientBadge } from "../../../../components/status.tsx";
import { formatMoney } from "../../../../lib/format.ts";
import { accountQuery, cardsQuery, findingsQuery, logicalCardsQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/")({
  loader: ({ context: { queryClient }, params: { accountId } }) =>
    Promise.all([
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(findingsQuery(accountId, {})),
    ]),
  component: Overview,
});

function Overview() {
  const { accountId } = Route.useParams();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, {}));

  const openFindings = new Map<number, number>();
  for (const f of findings) openFindings.set(f.cardId, (openFindings.get(f.cardId) ?? 0) + 1);

  return (
    <Stack>
      <Title order={2}>{account.label}</Title>
      {logicalCards.length === 0 ? (
        <NoCards accountId={accountId} archived={account.archivedAt !== null} />
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
          {logicalCards.map((l) => (
            <LogicalCardPanel
              key={l.id}
              accountId={accountId}
              logical={l}
              members={cards.filter((c) => l.cardIds.includes(c.id))}
              openFindings={openFindings}
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

function NoCards({ accountId, archived }: { accountId: string; archived: boolean }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => ok(api.accounts[":accountId"].syncs.$post({ param: { accountId } })),
    onSuccess: (sync) =>
      queryClient.setQueryData(accountQuery(accountId).queryKey, (a) => a && { ...a, lastSync: sync }),
  });
  return (
    <Paper withBorder p="xl" radius="md">
      <Stack align="center" gap="xs">
        <Text fw={600}>No cards yet</Text>
        {archived ? (
          <Text c="dimmed" size="sm">
            This account was archived before any cards were fetched.
          </Text>
        ) : (
          <>
            <Text c="dimmed" size="sm">
              Sync the account to fetch its cards and history from 2fiat.
            </Text>
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              Sync now
            </Button>
            {start.error && (
              <Text c="red" size="sm">
                {start.error.message}
              </Text>
            )}
          </>
        )}
      </Stack>
    </Paper>
  );
}

/** A logical card: drawn as its current card, with its balances and open findings. */
function LogicalCardPanel({
  accountId,
  logical,
  members,
  openFindings,
}: {
  accountId: string;
  logical: LogicalCard;
  members: Card[];
  openFindings: Map<number, number>;
}) {
  const current = members.find((c) => c.id === logical.currentCardId) ?? members[0];
  if (!current) return null;
  const balance = logical.balance;
  const findings = members.reduce((n, c) => n + (openFindings.get(c.id) ?? 0), 0);
  const params = { accountId, logicalCardId: String(logical.id) };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Link
          to="/a/$accountId/cards/$logicalCardId"
          params={params}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          <CardFace card={current} balanceCents={balance?.reportedCents} />
        </Link>
        <Group gap="xs">
          <AnchorLink to="/a/$accountId/cards/$logicalCardId" params={params} fw={700} size="lg" c="inherit">
            {logical.name}
          </AnchorLink>
          {findings > 0 && (
            <AnchorLink to="/a/$accountId/findings" params={{ accountId }} search={{ card: logical.id }}>
              <Badge color="orange" variant="light" style={{ cursor: "pointer" }}>
                {findings} open {findings === 1 ? "finding" : "findings"}
              </Badge>
            </AnchorLink>
          )}
        </Group>
        {balance ? (
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              Ledger {formatMoney(balance.ledgerCents)}
              {balance.holdsCents !== 0 && ` (${formatMoney(balance.holdsCents)} held)`}
            </Text>
            <GapBadge cents={balance.gapCents} />
            {balance.transient && <TransientBadge />}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Not evaluated yet.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
