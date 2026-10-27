import { Badge, ColorSwatch, Group, Table, Text, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { Activity, ActivityKind, Card, LogicalCard } from "../api.ts";
import { groupColor } from "../lib/cashflow.ts";
import { ACTIVITY_KIND_LABELS, ACTIVITY_STATUS_LABELS, formatDateTime, lastFour } from "../lib/format.ts";
import { categoriesQuery } from "../queries.ts";
import { CategoryLabel } from "./Categories.tsx";
import { Amount } from "./Money.tsx";

/**
 * An activity's kind, drawn like the cash flow chart's toggles: its group's colour dot, then the kind. So the same
 * colour means the same thing on the chart and in the ledger.
 */
export function KindTag({ kind }: { kind: ActivityKind }) {
  return (
    <Badge
      variant="default"
      radius="xl"
      tt="none"
      fw={500}
      fz="xs"
      h={22}
      leftSection={<ColorSwatch color={groupColor(kind)} size={8} withShadow={false} />}
    >
      {ACTIVITY_KIND_LABELS[kind]}
    </Badge>
  );
}

/** A transfer between two physical cards of the same logical card: money moved within the card, not in or out. */
export const isOwnTransfer = (activity: Pick<Activity, "counterpartCardId">, logical: LogicalCard) =>
  activity.counterpartCardId !== null && logical.cardIds.includes(activity.counterpartCardId);

/** An activity's status: quiet when settled, a badge otherwise ("Stale" for a hold that never posted). */
export function ActivityStatusBadge({ activity }: { activity: Pick<Activity, "status" | "stale"> }) {
  if (activity.stale) {
    return (
      <Tooltip label="Authorised over a week ago and never posted">
        <Badge size="sm" color="orange" variant="light">
          Stale
        </Badge>
      </Tooltip>
    );
  }
  if (activity.status === "settled") {
    return (
      <Text size="sm" c="dimmed">
        Settled
      </Text>
    );
  }
  const color = activity.status === "pending" ? "yellow" : "gray";
  return (
    <Tooltip label="Authorised, not yet posted" disabled={activity.status !== "pending"}>
      <Badge size="sm" color={color} variant="light">
        {ACTIVITY_STATUS_LABELS[activity.status]}
      </Badge>
    </Tooltip>
  );
}

/** A signed amount: green in, red out. A declined charge shows what it tried, struck through. */
export function ActivityAmount({
  activity,
  size = "sm",
}: {
  activity: Pick<Activity, "amountCents" | "attemptedAmountCents" | "occurredAt">;
  size?: string;
}) {
  const { amountCents, attemptedAmountCents, occurredAt } = activity;
  if (amountCents === 0 && attemptedAmountCents !== null) {
    return (
      <Text size={size} c="dimmed" td="line-through" style={{ whiteSpace: "nowrap" }}>
        <Amount cents={attemptedAmountCents} at={occurredAt} signed />
      </Text>
    );
  }
  return (
    <Text
      size={size}
      fw={600}
      c={amountCents > 0 ? "teal.7" : amountCents < 0 ? "red.7" : "dimmed"}
      style={{ whiteSpace: "nowrap" }}
    >
      <Amount cents={amountCents} at={occurredAt} signed />
    </Text>
  );
}

/**
 * A logical card's activities, one row per resolved activity (a purchase is one row, not 2fiat's authorisation and
 * posting). Names the physical card when the logical card has several.
 */
export function ActivityTable({
  activities,
  cards,
  logical,
  selectedId,
  onOpen,
}: {
  activities: Activity[];
  cards: Card[];
  logical: LogicalCard;
  selectedId?: number;
  onOpen: (activityId: number) => void;
}) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const { data: categories = [] } = useQuery(categoriesQuery);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const several = logical.cardIds.length > 1;
  return (
    <Table.ScrollContainer minWidth={1100}>
      {/* Fixed widths, so the columns don't move with what a page holds; the description takes the rest. */}
      <Table highlightOnHover verticalSpacing={6} layout="fixed">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={170}>When</Table.Th>
            <Table.Th>Description</Table.Th>
            <Table.Th w={230}>Kind</Table.Th>
            <Table.Th w={150}>Category</Table.Th>
            <Table.Th w={100}>Status</Table.Th>
            <Table.Th w={130} ta="right">
              Amount
            </Table.Th>
            <Table.Th w={90} ta="right">
              Fee
            </Table.Th>
            {several && <Table.Th w={80}>Card</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {activities.map((a) => {
            const card = byId.get(a.cardId);
            const category = a.categoryId === null ? undefined : categoryById.get(a.categoryId);
            return (
              <Table.Tr
                key={a.id}
                onClick={() => onOpen(a.id)}
                bg={a.id === selectedId ? "var(--mantine-color-blue-light)" : undefined}
                style={{ cursor: "pointer" }}
              >
                <Table.Td style={{ whiteSpace: "nowrap" }}>
                  <Text size="sm">{formatDateTime(a.occurredAt)}</Text>
                </Table.Td>
                <Table.Td>
                  {/* One line, so every row has the same height; the drawer shows what it posted as. */}
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" lineClamp={1}>
                      {a.description}
                    </Text>
                    {a.note && <NoteMark note={a.note} />}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <KindTag kind={a.kind} />
                    {isOwnTransfer(a, logical) && (
                      <Tooltip label="Between this card's own physical cards: money moved within the card">
                        <Badge size="xs" variant="outline" color="gray">
                          Own card
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {category ? (
                    <CategoryLabel category={category} />
                  ) : (
                    a.categorizable && (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )
                  )}
                </Table.Td>
                <Table.Td>
                  <ActivityStatusBadge activity={a} />
                </Table.Td>
                <Table.Td ta="right">
                  <ActivityAmount activity={a} />
                </Table.Td>
                <Table.Td ta="right">
                  {a.feeCents !== null && a.feeCents !== 0 && (
                    <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                      <Amount cents={a.feeCents} at={a.occurredAt} />
                    </Text>
                  )}
                </Table.Td>
                {several && (
                  <Table.Td style={{ whiteSpace: "nowrap" }}>
                    <Text size="sm" c="dimmed">
                      {card ? `·· ${lastFour(card.maskedNumber)}` : ""}
                    </Text>
                  </Table.Td>
                )}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Marks an activity with a note, which shows on hover. */
function NoteMark({ note }: { note: string }) {
  return (
    <Tooltip label={note} multiline maw={320} style={{ whiteSpace: "pre-wrap" }}>
      <svg
        role="img"
        aria-label="Has a note"
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--mantine-color-dimmed)"
        strokeWidth={1.5}
        strokeLinecap="round"
        style={{ flexShrink: 0 }}
      >
        <path d="M3 2.5h10v8l-3 3H3z M10 13.5v-3h3 M5.5 6h5 M5.5 8.5h3" />
      </svg>
    </Tooltip>
  );
}
