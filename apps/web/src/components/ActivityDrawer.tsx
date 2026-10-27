import {
  Accordion,
  Badge,
  Code,
  Drawer,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ActivityDetail, Card, LogicalCard } from "../api.ts";
import {
  ACTIVITY_FLAG_LABELS,
  cardLabel,
  FINDING_KIND_LABELS,
  formatDateTime,
  formatMoney,
} from "../lib/format.ts";
import { activityQuery, findingsQuery } from "../queries.ts";
import { ActivityAmount, ActivityStatusBadge, isOwnTransfer, KindTag } from "./ActivityTable.tsx";
import { AnchorLink } from "./links.tsx";
import { useMoney } from "./Money.tsx";
import { ErrorView } from "./status.tsx";

/** One activity in full: every field and flag, 2fiat's rows (or the user's adjustment) behind it, its findings. */
export function ActivityDrawer({
  accountId,
  activityId,
  cards,
  logical,
  onClose,
}: {
  accountId: string;
  activityId: number | undefined;
  cards: Card[];
  logical: LogicalCard;
  onClose: () => void;
}) {
  return (
    <Drawer opened={activityId !== undefined} onClose={onClose} position="right" size="lg" title="Activity">
      {activityId !== undefined && (
        <Details accountId={accountId} activityId={activityId} cards={cards} logical={logical} />
      )}
    </Drawer>
  );
}

function Details({
  accountId,
  activityId,
  cards,
  logical,
}: {
  accountId: string;
  activityId: number;
  cards: Card[];
  logical: LogicalCard;
}) {
  const { data: a, error } = useQuery(activityQuery(accountId, activityId));
  const display = useMoney();
  if (error) return <ErrorView error={error} />;
  if (!a) return <Loader size="sm" />;

  const byId = new Map(cards.map((c) => [c.id, c]));
  const card = byId.get(a.cardId);
  const counterpart = a.counterpartCardId === null ? undefined : byId.get(a.counterpartCardId);
  const money = (cents: number | null) => cents !== null && formatMoney(cents, { signed: true });
  // The amount in the display currency, and how it was converted; the fields below stay in 2fiat's dollars.
  const converted = display.convert(a.amountCents, a.occurredAt);

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Title order={4}>{a.description}</Title>
            {a.postedDescription && (
              <Text size="xs" c="dimmed">
                Posted as {a.postedDescription}
              </Text>
            )}
          </Stack>
          <ActivityAmount activity={a} size="lg" />
        </Group>
        <Group gap="xs">
          <KindTag kind={a.kind} />
          <ActivityStatusBadge activity={a} />
          {a.flags.map((flag) => (
            <Tooltip key={flag} label={ACTIVITY_FLAG_LABELS[flag].description} multiline maw={280}>
              <Badge variant="outline" color="gray">
                {ACTIVITY_FLAG_LABELS[flag].label}
              </Badge>
            </Tooltip>
          ))}
        </Group>
      </Stack>

      <Table variant="vertical" layout="fixed" withTableBorder>
        <Table.Tbody>
          <Field label="Occurred">{formatDateTime(a.occurredAt)}</Field>
          <Field label="Posted">{a.settledAt && formatDateTime(a.settledAt)}</Field>
          <Field label="Card">{card && cardLabel(card)}</Field>
          <Field label="Amount">{money(a.amountCents)}</Field>
          {display.converts && a.amountCents !== 0 && (
            <Field label={`In ${display.currency}`}>
              {display.format(converted.cents, { signed: true })}
              <Text span size="xs" c="dimmed">
                {" "}
                ({display.describe(converted, { signed: true })})
              </Text>
            </Field>
          )}
          <Field label="Authorised">
            {a.authorizedAmountCents !== a.amountCents && money(a.authorizedAmountCents)}
          </Field>
          <Field label="Attempted">{money(a.attemptedAmountCents)}</Field>
          <Field label="Requested">{money(a.requestedAmountCents)}</Field>
          <Field label="Fee charged">
            {a.feeCents !== null && a.feeCents !== 0 && formatMoney(a.feeCents)}
          </Field>
          <Field label={a.kind === "transfer_in" ? "From" : "To"}>
            {counterpart &&
              `${cardLabel(counterpart)}${isOwnTransfer(a, logical) ? " (this card's own)" : ""}`}
          </Field>
          <Field label="Transfer">{a.transferId}</Field>
        </Table.Tbody>
      </Table>

      <Findings accountId={accountId} logical={logical} findingIds={a.findingIds} />
      <Sources sources={a.sources} />
    </Stack>
  );
}

/** A row of the field table, left out when there's nothing to show. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return (
    <Table.Tr>
      <Table.Th w={130}>{label}</Table.Th>
      <Table.Td style={{ overflowWrap: "anywhere" }}>{children}</Table.Td>
    </Table.Tr>
  );
}

function Findings({
  accountId,
  logical,
  findingIds,
}: {
  accountId: string;
  logical: LogicalCard;
  findingIds: number[];
}) {
  const { data: findings } = useQuery({
    ...findingsQuery(accountId, { card: logical.id, status: "all" }),
    enabled: findingIds.length > 0,
  });
  if (findingIds.length === 0) return null;
  const mine = findings?.filter((f) => findingIds.includes(f.id)) ?? [];
  return (
    <Stack gap="xs">
      <Title order={5}>Findings</Title>
      {mine.map((f) => (
        <Paper key={f.id} withBorder p="xs" radius="md">
          <Group gap="xs" justify="space-between">
            <Group gap="xs">
              <Badge color={f.resolvedAt === null ? "orange" : "gray"} variant="light">
                {FINDING_KIND_LABELS[f.kind]}
              </Badge>
              {f.resolvedAt !== null && (
                <Badge color="green" variant="outline">
                  Resolved
                </Badge>
              )}
              {f.explanation !== null && (
                <Badge color="blue" variant="outline">
                  Explained
                </Badge>
              )}
            </Group>
            <AnchorLink
              to="/a/$accountId/findings"
              params={{ accountId }}
              search={{ card: logical.id, kind: f.kind, status: "all" }}
              size="xs"
            >
              In findings
            </AnchorLink>
          </Group>
          <Text size="sm" mt={4}>
            {f.message}
          </Text>
        </Paper>
      ))}
    </Stack>
  );
}

/** 2fiat's original rows behind the activity, as stored (minus PII), or the adjustment the user entered. */
function Sources({ sources }: { sources: ActivityDetail["sources"] }) {
  const { adjustment, transactions, orders } = sources;
  if (adjustment) {
    return (
      <Stack gap="xs">
        <Title order={5}>Your adjustment</Title>
        <Text size="sm">
          {formatMoney(adjustment.cents, { signed: true })} on {formatDateTime(adjustment.occurredAt)}
        </Text>
        {adjustment.note && (
          <Text size="sm" fs="italic" style={{ whiteSpace: "pre-wrap" }}>
            {adjustment.note}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Entered {formatDateTime(adjustment.createdAt)}. Edit it under the card's adjustments.
        </Text>
      </Stack>
    );
  }
  const rows = [
    ...transactions.map((t) => ({ ...t, type: "Transaction" })),
    ...orders.map((o) => ({ ...o, type: "Order" })),
  ];
  return (
    <Stack gap="xs">
      <Title order={5}>2fiat's rows ({rows.length})</Title>
      <Accordion variant="contained" multiple>
        {rows.map((r) => (
          <Accordion.Item key={`${r.type}:${r.id}`} value={`${r.type}:${r.id}`}>
            <Accordion.Control>
              <Text size="sm">
                {r.type} {r.twofiatId}
              </Text>
              <Text size="xs" c="dimmed">
                {formatDateTime(r.createdAt)} · last seen {formatDateTime(r.lastSeenAt)}
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Code block fz="xs">
                {JSON.stringify(r.raw, null, 2)}
              </Code>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </Stack>
  );
}
