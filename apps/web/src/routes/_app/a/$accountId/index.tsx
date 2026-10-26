import { Badge, Button, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api, type Card, type LogicalCard, ok } from "../../../../api.ts";
import { CardFace } from "../../../../components/CardFace.tsx";
import { AnchorLink } from "../../../../components/links.tsx";
import { GapBadge, OpeningBadge, TransientBadge } from "../../../../components/status.tsx";
import { cardLabel, formatMoney, formatMonth } from "../../../../lib/format.ts";
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
        logicalCards.map((l) => (
          <LogicalCardPanel
            key={l.id}
            accountId={accountId}
            logical={l}
            members={cards.filter((c) => l.cardIds.includes(c.id))}
            openFindings={openFindings}
          />
        ))
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

  return (
    <Paper withBorder p="md" radius="md">
      <Group align="flex-start" gap="lg">
        <Link
          to="/a/$accountId/cards/$cardId"
          params={{ accountId, cardId: String(current.id) }}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          <CardFace card={current} balanceCents={balance?.reportedCents} />
        </Link>
        <Stack gap="xs" style={{ flex: 1, minWidth: 260 }}>
          <Group gap="xs">
            <Title order={4}>{logical.name}</Title>
            {findings > 0 && (
              <Badge color="orange" variant="light">
                {findings} open {findings === 1 ? "finding" : "findings"}
              </Badge>
            )}
          </Group>
          {balance ? (
            <Group gap="xs">
              <Text size="sm" c="dimmed">
                Reported {formatMoney(balance.reportedCents, current.currency)} · ledger{" "}
                {formatMoney(balance.ledgerCents, current.currency)}
                {balance.holdsCents !== 0 && ` (${formatMoney(balance.holdsCents, current.currency)} held)`}
              </Text>
              <GapBadge cents={balance.gapCents} currency={current.currency} />
              {balance.transient && <TransientBadge />}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              Not evaluated yet.
            </Text>
          )}
          <PhysicalCards accountId={accountId} cards={members} openFindings={openFindings} />
        </Stack>
      </Group>
    </Paper>
  );
}

/** The physical cards behind a logical card: the details under the card the user thinks of. */
function PhysicalCards({
  accountId,
  cards,
  openFindings,
}: {
  accountId: string;
  cards: Card[];
  openFindings: Map<number, number>;
}) {
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table verticalSpacing={4} fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Card</Table.Th>
            <Table.Th>Expires</Table.Th>
            <Table.Th ta="right">Reported</Table.Th>
            <Table.Th ta="right">Gap</Table.Th>
            <Table.Th>Opening balance</Table.Th>
            <Table.Th ta="right">Findings</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cards.map((c) => {
            const findings = openFindings.get(c.id) ?? 0;
            return (
              <Table.Tr key={c.id}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <AnchorLink
                      to="/a/$accountId/cards/$cardId"
                      params={{ accountId, cardId: String(c.id) }}
                      size="sm"
                    >
                      {cardLabel(c)}
                    </AnchorLink>
                    {cards.length > 1 && c.isCurrent && (
                      <Badge size="xs" variant="outline">
                        Current
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>{formatMonth(c.expiresAt)}</Table.Td>
                <Table.Td ta="right">
                  {c.balance ? formatMoney(c.balance.reportedCents, c.currency) : "—"}
                </Table.Td>
                <Table.Td ta="right" c={c.balance?.gapCents ? "red" : undefined}>
                  {c.balance ? formatMoney(c.balance.gapCents, c.currency, { signed: true }) : "—"}
                </Table.Td>
                <Table.Td>
                  {c.openingBalance ? (
                    <Group gap={6} wrap="nowrap">
                      {formatMoney(c.openingBalance.cents, c.currency)}
                      <OpeningBadge source={c.openingBalance.source} />
                    </Group>
                  ) : (
                    "—"
                  )}
                </Table.Td>
                <Table.Td ta="right">
                  {findings > 0 ? (
                    <AnchorLink
                      to="/a/$accountId/findings"
                      params={{ accountId }}
                      search={{ cardId: c.id }}
                      size="sm"
                    >
                      {findings}
                    </AnchorLink>
                  ) : (
                    0
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
