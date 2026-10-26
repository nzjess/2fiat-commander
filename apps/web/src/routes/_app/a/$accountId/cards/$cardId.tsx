import { LineChart } from "@mantine/charts";
import {
  Badge,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { api, type Card, type LogicalCard, ok, type Snapshot, send } from "../../../../../api.ts";
import { AdjustmentList } from "../../../../../components/Adjustments.tsx";
import { CardFace } from "../../../../../components/CardFace.tsx";
import { FindingList } from "../../../../../components/FindingList.tsx";
import { AnchorLink } from "../../../../../components/links.tsx";
import { GapBadge, OpeningBadge, TransientBadge } from "../../../../../components/status.tsx";
import {
  cardLabel,
  formatDate,
  formatDateTime,
  formatMoney,
  formatMonth,
  isActive,
  toCents,
} from "../../../../../lib/format.ts";
import { positiveInt } from "../../../../../lib/search.ts";
import {
  accountQuery,
  adjustmentsQuery,
  cardsQuery,
  findingsQuery,
  logicalCardsQuery,
  snapshotsQuery,
} from "../../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/cards/$cardId")({
  loader: async ({ context: { queryClient }, params: { accountId, cardId } }) => {
    const id = positiveInt(cardId);
    if (id === undefined) throw notFound();
    const [cards] = await Promise.all([
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(snapshotsQuery(accountId, id)),
      queryClient.ensureQueryData(findingsQuery(accountId, { cardId: id })),
      queryClient.ensureQueryData(adjustmentsQuery(accountId, id)),
    ]);
    if (!cards.some((c) => c.id === id)) throw notFound();
  },
  component: CardPage,
});

function CardPage() {
  const { accountId, cardId: cardParam } = Route.useParams();
  const cardId = Number(cardParam);
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: snapshots } = useSuspenseQuery(snapshotsQuery(accountId, cardId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, { cardId }));
  const card = cards.find((c) => c.id === cardId);
  const logical = logicalCards.find((l) => l.id === card?.logicalCardId);
  if (!card || !logical) return null;
  const readOnly = account.archivedAt !== null;

  return (
    <Stack gap="lg">
      <Group align="flex-start" gap="xl">
        <CardFace card={card} balanceCents={card.balance?.reportedCents} width={340} />
        <Stack gap={4}>
          <Group gap="xs">
            <Title order={2}>{cardLabel(card)}</Title>
            {!isActive(card) && <Badge color="gray">Status {card.status}</Badge>}
          </Group>
          <Text c="dimmed" size="sm">
            {card.product} · {card.currency} · issued {formatDate(card.issuedAt)} · expires{" "}
            {formatMonth(card.expiresAt)}
          </Text>
          <Text c="dimmed" size="sm">
            Part of <b>{logical.name}</b>
            {logical.cardIds.length > 1 &&
              (card.isCurrent ? ", as its current card" : ", as an earlier card")}
          </Text>
        </Stack>
      </Group>

      <Balances card={card} />

      <Section title="Balance over time">
        <BalanceChart snapshots={snapshots} currency={card.currency} />
      </Section>

      <Section title="Opening balance">
        <OpeningBalance accountId={accountId} card={card} readOnly={readOnly} />
      </Section>

      <Section title="Adjustments">
        <AdjustmentList accountId={accountId} cardId={card.id} currency={card.currency} readOnly={readOnly} />
      </Section>

      <Section title="Same card over time">
        <Grouping
          accountId={accountId}
          card={card}
          cards={cards}
          logical={logical}
          logicalCards={logicalCards}
        />
      </Section>

      <Section
        title="Open findings"
        action={
          <AnchorLink
            to="/a/$accountId/findings"
            params={{ accountId }}
            search={{ cardId, status: "all" }}
            size="sm"
          >
            All of this card's findings
          </AnchorLink>
        }
      >
        <FindingList
          accountId={accountId}
          findings={findings}
          cards={cards}
          showCard={false}
          readOnly={readOnly}
        />
      </Section>
    </Stack>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>{title}</Title>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text fw={700} size="lg">
        {children}
      </Text>
    </Paper>
  );
}

function Balances({ card }: { card: Card }) {
  const b = card.balance;
  if (!b) return <Text c="dimmed">Not evaluated yet: sync the account.</Text>;
  const money = (cents: number) => formatMoney(cents, card.currency);
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Stat label="Reported by 2fiat">{money(b.reportedCents)}</Stat>
        <Stat label="Ledger">{money(b.ledgerCents)}</Stat>
        <Stat label="Held">{money(b.holdsCents)}</Stat>
        <Stat label="Gap">{formatMoney(b.gapCents, card.currency, { signed: true })}</Stat>
      </SimpleGrid>
      <Group gap="xs">
        <GapBadge cents={b.gapCents} currency={card.currency} />
        {b.transient && <TransientBadge />}
        <Text size="xs" c="dimmed">
          As of {formatDateTime(b.asOf)}. The ledger is the opening balance plus every activity, holds
          included.
        </Text>
      </Group>
    </Stack>
  );
}

function BalanceChart({ snapshots, currency }: { snapshots: Snapshot[]; currency: string }) {
  if (snapshots.length < 2) {
    return (
      <Text c="dimmed" size="sm">
        The chart appears after a second sync.
      </Text>
    );
  }
  const data = snapshots.map((s) => ({
    at: formatDateTime(s.asOf),
    reported: s.reportedCents / 100,
    ledger: s.ledgerCents / 100,
  }));
  return (
    <LineChart
      h={240}
      data={data}
      dataKey="at"
      curveType="stepAfter"
      withLegend
      series={[
        { name: "reported", label: "Reported", color: "blue.6" },
        { name: "ledger", label: "Ledger", color: "teal.6" },
      ]}
      valueFormatter={(v) => formatMoney(Math.round(v * 100), currency)}
    />
  );
}

/** For cards whose history starts with a balance (e.g. carried over from an older token). */
function OpeningBalance({ accountId, card, readOnly }: { accountId: string; card: Card; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const param = { accountId, cardId: String(card.id) };
  const endpoint = api.accounts[":accountId"].cards[":cardId"]["opening-balance"];
  const save = useMutation({
    mutationFn: (cents: number | null) =>
      cents === null ? send(endpoint.$delete({ param })) : send(endpoint.$put({ param, json: { cents } })),
    onSuccess: () => {
      setDraft(null);
      return queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
    },
  });
  const opening = card.openingBalance;
  const cents = draft === null ? undefined : toCents(draft);

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        What the card held before the first row 2fiat reports. It's inferred from the gap at the first sync
        when the history is incomplete; enter it if you know better, and later gaps then measure drift.
      </Text>
      {draft === null ? (
        <Group gap="sm">
          <Text fw={600}>{opening ? formatMoney(opening.cents, card.currency) : "None"}</Text>
          {opening && <OpeningBadge source={opening.source} />}
          {!readOnly && (
            <>
              <Button
                size="compact-sm"
                variant="subtle"
                onClick={() => setDraft(opening ? (opening.cents / 100).toFixed(2) : "")}
              >
                {opening ? "Change" : "Enter"}
              </Button>
              {opening?.source === "entered" && (
                <Button
                  size="compact-sm"
                  variant="subtle"
                  color="gray"
                  loading={save.isPending}
                  onClick={() => save.mutate(null)}
                >
                  Reset to inferred
                </Button>
              )}
            </>
          )}
        </Group>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (cents !== undefined) save.mutate(cents);
          }}
        >
          <Group gap="xs" align="flex-start">
            <TextInput
              autoFocus
              w={160}
              inputMode="decimal"
              leftSection={<Text size="xs">{card.currency}</Text>}
              leftSectionWidth={44}
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              error={(draft !== "" && cents === undefined ? "e.g. 120.50" : undefined) ?? save.error?.message}
            />
            <Button type="submit" disabled={cents === undefined} loading={save.isPending}>
              Save
            </Button>
            <Button variant="default" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </Group>
        </form>
      )}
    </Stack>
  );
}

/**
 * Which physical cards are the same card to the user (e.g. a renewal), and which of them is current. Spending
 * and history follow the logical card across the swap.
 */
function Grouping({
  accountId,
  card,
  cards,
  logical,
  logicalCards,
}: {
  accountId: string;
  card: Card;
  cards: Card[];
  logical: LogicalCard;
  logicalCards: LogicalCard[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const done = () => queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
  const move = useMutation({
    mutationFn: (logicalCardId: number | null) =>
      ok(
        api.accounts[":accountId"].cards[":cardId"].$patch({
          param: { accountId, cardId: String(card.id) },
          json: { logicalCardId },
        }),
      ),
    onSuccess: done,
  });
  const update = useMutation({
    mutationFn: (json: { name?: string; currentCardId?: number }) =>
      ok(
        api.accounts[":accountId"]["logical-cards"][":logicalCardId"].$patch({
          param: { accountId, logicalCardId: String(logical.id) },
          json,
        }),
      ),
    onSuccess: () => {
      setName(null);
      return done();
    },
  });

  const byId = new Map(cards.map((c) => [c.id, c]));
  const members = logical.cardIds.flatMap((id) => byId.get(id) ?? []);
  const others = logicalCards
    .filter((l) => l.id !== logical.id)
    .map((l) => {
      const current = l.currentCardId === null ? undefined : byId.get(l.currentCardId);
      return { value: String(l.id), label: current ? `${l.name} (${cardLabel(current)})` : l.name };
    });
  const error = move.error ?? update.error;

  return (
    <Stack gap="sm">
      {name === null ? (
        <Group gap="xs">
          <Text>
            Logical card <b>{logical.name}</b>
          </Text>
          <Button size="compact-sm" variant="subtle" onClick={() => setName(logical.name)}>
            Rename
          </Button>
        </Group>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) update.mutate({ name: name.trim() });
          }}
        >
          <Group gap="xs">
            <TextInput
              autoFocus
              w={240}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Button type="submit" loading={update.isPending} disabled={!name.trim()}>
              Save
            </Button>
            <Button variant="default" onClick={() => setName(null)}>
              Cancel
            </Button>
          </Group>
        </form>
      )}

      {members.length > 1 && (
        <Stack gap={4}>
          {members.map((m) => (
            <Group key={m.id} gap="xs">
              <AnchorLink
                to="/a/$accountId/cards/$cardId"
                params={{ accountId, cardId: String(m.id) }}
                size="sm"
                fw={m.id === card.id ? 700 : undefined}
              >
                {cardLabel(m)}
              </AnchorLink>
              <Text size="xs" c="dimmed">
                issued {formatDate(m.issuedAt)}
              </Text>
              {m.isCurrent ? (
                <Badge size="xs" variant="outline">
                  Current
                </Badge>
              ) : (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  loading={update.isPending}
                  onClick={() => update.mutate({ currentCardId: m.id })}
                >
                  Make current
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}

      <Group gap="xs" align="flex-end">
        {others.length > 0 && (
          <Select
            label="This card replaced, or was replaced by"
            description="Moves it into that card's history"
            placeholder="Choose a card"
            w={320}
            data={others}
            value={null}
            disabled={move.isPending}
            onChange={(value) => value && move.mutate(Number(value))}
          />
        )}
        {members.length > 1 && (
          <Button variant="default" loading={move.isPending} onClick={() => move.mutate(null)}>
            Make it a separate card
          </Button>
        )}
      </Group>
      {error && (
        <Text c="red" size="sm">
          {error.message}
        </Text>
      )}
    </Stack>
  );
}
