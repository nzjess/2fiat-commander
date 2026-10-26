import {
  Accordion,
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
import { api, type Card, type LogicalCard, ok, send } from "../../../../../api.ts";
import { AdjustmentList } from "../../../../../components/Adjustments.tsx";
import { BalanceChart } from "../../../../../components/BalanceChart.tsx";
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
  balanceHistoryQuery,
  cardsQuery,
  findingsQuery,
  logicalCardsQuery,
} from "../../../../../queries.ts";

/**
 * A logical card: the card as the user thinks of it, across renewals and replacements. Its physical cards (2fiat's
 * own) are details, at the bottom.
 */
export const Route = createFileRoute("/_app/a/$accountId/cards/$logicalCardId")({
  loader: async ({ context: { queryClient }, params: { accountId, logicalCardId } }) => {
    const id = positiveInt(logicalCardId);
    if (id === undefined) throw notFound();
    const logicalCards = await queryClient.ensureQueryData(logicalCardsQuery(accountId));
    if (!logicalCards.some((l) => l.id === id)) throw notFound();
    await Promise.all([
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(findingsQuery(accountId, { card: id })),
      queryClient.ensureQueryData(adjustmentsQuery(accountId, id)),
      queryClient.ensureQueryData(balanceHistoryQuery(accountId, id)),
    ]);
  },
  component: LogicalCardPage,
});

function LogicalCardPage() {
  const { accountId, logicalCardId } = Route.useParams();
  const id = Number(logicalCardId);
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, { card: id }));
  const logical = logicalCards.find((l) => l.id === id);
  // E.g. just after its last physical card moved into another logical card.
  if (!logical) return <Text c="dimmed">This card no longer exists.</Text>;
  const members = cards
    .filter((c) => c.logicalCardId === id)
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) || (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""),
    );
  const current = members[0];
  if (!current) return null;
  const readOnly = account.archivedAt !== null;

  return (
    <Stack gap="lg">
      <Group align="flex-start" gap="xl">
        <CardFace card={current} balanceCents={logical.balance?.reportedCents} width={340} />
        <Stack gap={4}>
          <Name accountId={accountId} logical={logical} />
          <Text c="dimmed" size="sm">
            {cardLabel(current)} · {current.product} · {current.currency} · expires{" "}
            {formatMonth(current.expiresAt)}
            {!isActive(current) && ` · status ${current.status}`}
          </Text>
          {members.length > 1 && (
            <Text c="dimmed" size="sm">
              Spans {members.length} physical cards: their history and balances count as one.
            </Text>
          )}
        </Stack>
      </Group>

      <Balances logical={logical} current={current} />

      <Section title="Balance over time">
        <BalanceChart accountId={accountId} logicalCardId={id} />
      </Section>

      <Section
        title="Open findings"
        action={
          <AnchorLink
            to="/a/$accountId/findings"
            params={{ accountId }}
            search={{ card: id, status: "all" }}
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
          logicalCards={logicalCards}
          showCard={false}
          readOnly={readOnly}
        />
      </Section>

      <Section title="Adjustments">
        <AdjustmentList accountId={accountId} logicalCardId={id} cards={members} readOnly={readOnly} />
      </Section>

      <Accordion variant="contained">
        <Accordion.Item value="physical">
          <Accordion.Control>
            <Text fw={600}>Physical cards ({members.length})</Text>
            <Text size="xs" c="dimmed">
              2fiat's own cards behind this one: link a renewal or replacement here, or set an opening balance
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <PhysicalCards
              accountId={accountId}
              logical={logical}
              members={members}
              logicalCards={logicalCards}
              cards={cards}
              readOnly={readOnly}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
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

function Name({ accountId, logical }: { accountId: string; logical: LogicalCard }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (value: string) =>
      ok(
        api.accounts[":accountId"]["logical-cards"][":logicalCardId"].$patch({
          param: { accountId, logicalCardId: String(logical.id) },
          json: { name: value },
        }),
      ),
    onSuccess: () => {
      setName(null);
      return queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
    },
  });
  if (name === null) {
    return (
      <Group gap="xs">
        <Title order={2}>{logical.name}</Title>
        <Button size="compact-sm" variant="subtle" onClick={() => setName(logical.name)}>
          Rename
        </Button>
      </Group>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) rename.mutate(name.trim());
      }}
    >
      <Group gap="xs" align="flex-start">
        <TextInput
          autoFocus
          w={240}
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          error={rename.error?.message}
        />
        <Button type="submit" loading={rename.isPending} disabled={!name.trim()}>
          Save
        </Button>
        <Button variant="default" onClick={() => setName(null)}>
          Cancel
        </Button>
      </Group>
    </form>
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

/** The logical card's balances: its physical cards' latest, summed. */
function Balances({ logical, current }: { logical: LogicalCard; current: Card }) {
  const b = logical.balance;
  if (!b) return <Text c="dimmed">Not evaluated yet: sync the account.</Text>;
  const money = (cents: number) => formatMoney(cents, current.currency);
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Stat label="Reported by 2fiat">{money(b.reportedCents)}</Stat>
        <Stat label="Ledger">{money(b.ledgerCents)}</Stat>
        <Stat label="Held">{money(b.holdsCents)}</Stat>
        <Stat label="Gap">{formatMoney(b.gapCents, current.currency, { signed: true })}</Stat>
      </SimpleGrid>
      <Group gap="xs">
        <GapBadge cents={b.gapCents} currency={current.currency} />
        {b.transient && <TransientBadge />}
        <Text size="xs" c="dimmed">
          {current.balance && `As of ${formatDateTime(current.balance.asOf)}. `}The ledger is the opening
          balance plus every activity, holds included.
        </Text>
      </Group>
    </Stack>
  );
}

/**
 * The physical cards behind a logical card: which is current, each one's balance and opening balance, and linking
 * a renewal or replacement in, or separating a card out again.
 */
function PhysicalCards({
  accountId,
  logical,
  members,
  logicalCards,
  cards,
  readOnly,
}: {
  accountId: string;
  logical: LogicalCard;
  members: Card[];
  logicalCards: LogicalCard[];
  cards: Card[];
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const done = () => queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
  const moveCard = (cardId: number, logicalCardId: number | null) =>
    ok(
      api.accounts[":accountId"].cards[":cardId"].$patch({
        param: { accountId, cardId: String(cardId) },
        json: { logicalCardId },
      }),
    );
  const makeCurrent = useMutation({
    mutationFn: (cardId: number) =>
      ok(
        api.accounts[":accountId"]["logical-cards"][":logicalCardId"].$patch({
          param: { accountId, logicalCardId: String(logical.id) },
          json: { currentCardId: cardId },
        }),
      ),
    onSuccess: done,
  });
  const separate = useMutation({ mutationFn: (cardId: number) => moveCard(cardId, null), onSuccess: done });
  // Linking another logical card moves each of its physical cards into this one; it then no longer exists.
  const link = useMutation({
    mutationFn: async (other: LogicalCard) => {
      for (const cardId of other.cardIds) await moveCard(cardId, logical.id);
    },
    onSettled: done,
  });

  const byId = new Map(cards.map((c) => [c.id, c]));
  const others = logicalCards
    .filter((l) => l.id !== logical.id)
    .map((l) => {
      const current = l.currentCardId === null ? undefined : byId.get(l.currentCardId);
      return { value: String(l.id), label: current ? `${l.name} (${cardLabel(current)})` : l.name };
    });
  const error = makeCurrent.error ?? separate.error ?? link.error;

  return (
    <Stack gap="md">
      {members.map((card) => (
        <Paper key={card.id} withBorder p="sm" radius="md">
          <Stack gap={6}>
            <Group justify="space-between" align="flex-start">
              <Stack gap={0}>
                <Group gap="xs">
                  <Text fw={600}>{cardLabel(card)}</Text>
                  {members.length > 1 && card.isCurrent && (
                    <Badge size="xs" variant="outline">
                      Current
                    </Badge>
                  )}
                  {!isActive(card) && (
                    <Badge size="xs" color="gray">
                      Status {card.status}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  Issued {formatDate(card.issuedAt)} · expires {formatMonth(card.expiresAt)}
                </Text>
              </Stack>
              {card.balance && (
                <Group gap="xs">
                  <Text size="sm">{formatMoney(card.balance.reportedCents, card.currency)}</Text>
                  <GapBadge cents={card.balance.gapCents} currency={card.currency} />
                </Group>
              )}
            </Group>
            <OpeningBalance accountId={accountId} card={card} readOnly={readOnly} />
            {members.length > 1 && (
              <Group gap="xs">
                {!card.isCurrent && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    loading={makeCurrent.isPending && makeCurrent.variables === card.id}
                    onClick={() => makeCurrent.mutate(card.id)}
                  >
                    Make current
                  </Button>
                )}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  loading={separate.isPending && separate.variables === card.id}
                  onClick={() => separate.mutate(card.id)}
                >
                  Separate it into a card of its own
                </Button>
              </Group>
            )}
          </Stack>
        </Paper>
      ))}
      {others.length > 0 && (
        <Select
          label="Link another card into this one"
          description="For a renewal or replacement: its history and balance then count as part of this card"
          placeholder="Choose a card"
          maw={420}
          data={others}
          value={null}
          disabled={link.isPending}
          onChange={(value) => {
            const other = logicalCards.find((l) => String(l.id) === value);
            if (other) link.mutate(other);
          }}
        />
      )}
      {error && (
        <Text c="red" size="sm">
          {error.message}
        </Text>
      )}
    </Stack>
  );
}

/** For a card whose history starts with a balance (e.g. carried over from an older token). */
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

  if (draft === null) {
    return (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          Opening balance
        </Text>
        <Text size="sm">{opening ? formatMoney(opening.cents, card.currency) : "none"}</Text>
        {opening && <OpeningBadge source={opening.source} />}
        {!readOnly && (
          <>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setDraft(opening ? (opening.cents / 100).toFixed(2) : "")}
            >
              {opening ? "Change" : "Enter"}
            </Button>
            {opening?.source === "entered" && (
              <Button
                size="compact-xs"
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
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (cents !== undefined) save.mutate(cents);
      }}
    >
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          What the card held before the first row 2fiat reports. It's inferred from the gap at the first sync
          when the history is incomplete; enter it if you know better, and later gaps then measure drift.
        </Text>
        <Group gap="xs" align="flex-start">
          <TextInput
            autoFocus
            size="xs"
            w={160}
            inputMode="decimal"
            leftSection={<Text size="xs">{card.currency}</Text>}
            leftSectionWidth={44}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            error={(draft !== "" && cents === undefined ? "e.g. 120.50" : undefined) ?? save.error?.message}
          />
          <Button size="xs" type="submit" disabled={cents === undefined} loading={save.isPending}>
            Save
          </Button>
          <Button size="xs" variant="default" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
