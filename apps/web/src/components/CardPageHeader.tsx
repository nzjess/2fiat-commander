import { Group, Select, Stack, Text, Title } from "@mantine/core";
import type { LogicalCard } from "../api.ts";
import { AnchorLink } from "./links.tsx";

/** Picks a logical card. With `allowAll`, it can be cleared to mean every card. */
export function CardSelect({
  logicalCards,
  selected,
  onSelect,
  allowAll = false,
}: {
  logicalCards: LogicalCard[];
  selected: LogicalCard | undefined;
  onSelect: (logicalCardId: number | undefined) => void;
  allowAll?: boolean;
}) {
  if (logicalCards.length === 0) return null;
  return (
    <Select
      aria-label="Card"
      w={240}
      placeholder={allowAll ? "All cards" : "Choose a card"}
      data={logicalCards.map((l) => ({ value: String(l.id), label: l.name }))}
      value={selected ? String(selected.id) : null}
      clearable={allowAll}
      allowDeselect={allowAll}
      onChange={(v) => {
        if (v || allowAll) onSelect(v ? Number(v) : undefined);
      }}
    />
  );
}

/**
 * The top of a card's sub-page (findings, insights, activity): a link back to the selected card's page, the
 * title, and the card selector. With `allowAll`, the selector can be cleared to show every card.
 */
export function CardPageHeader({
  accountId,
  title,
  logicalCards,
  selected,
  onSelect,
  allowAll = false,
}: {
  accountId: string;
  title: string;
  logicalCards: LogicalCard[];
  selected: LogicalCard | undefined;
  onSelect: (logicalCardId: number | undefined) => void;
  allowAll?: boolean;
}) {
  return (
    <Stack gap={4}>
      {selected ? (
        <AnchorLink
          to="/a/$accountId/cards/$logicalCardId"
          params={{ accountId, logicalCardId: String(selected.id) }}
          size="sm"
        >
          ← Back to {selected.name}
        </AnchorLink>
      ) : (
        // Holds the link's line, so the page doesn't shift when "All cards" is chosen.
        <Text size="sm" aria-hidden>
          &nbsp;
        </Text>
      )}
      <Group justify="space-between">
        <Title order={2}>{title}</Title>
        <CardSelect logicalCards={logicalCards} selected={selected} onSelect={onSelect} allowAll={allowAll} />
      </Group>
    </Stack>
  );
}
