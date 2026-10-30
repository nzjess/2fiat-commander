import { Group, Select, Stack, Title } from "@mantine/core";
import type { LogicalCard } from "../api.ts";
import { AnchorLink } from "./links.tsx";

/** Picks a logical card. */
export function CardSelect({
  logicalCards,
  selected,
  onSelect,
}: {
  logicalCards: LogicalCard[];
  selected: LogicalCard;
  onSelect: (logicalCardId: number) => void;
}) {
  return (
    <Select
      aria-label="Card"
      w={240}
      data={logicalCards.map((l) => ({ value: String(l.id), label: l.name }))}
      value={String(selected.id)}
      allowDeselect={false}
      onChange={(v) => {
        if (v) onSelect(Number(v));
      }}
    />
  );
}

/**
 * The top of a card's sub-page (findings, insights, activity): a link back to the card's page, the title, and the
 * card selector.
 */
export function CardPageHeader({
  accountId,
  title,
  logicalCards,
  selected,
  onSelect,
}: {
  accountId: string;
  title: string;
  logicalCards: LogicalCard[];
  selected: LogicalCard;
  onSelect: (logicalCardId: number) => void;
}) {
  return (
    <Stack gap={4}>
      <AnchorLink
        to="/a/$accountId/c/$logicalCardId"
        params={{ accountId, logicalCardId: String(selected.id) }}
        size="sm"
      >
        ← Back to {selected.name}
      </AnchorLink>
      <Group justify="space-between">
        <Title order={2}>{title}</Title>
        <CardSelect logicalCards={logicalCards} selected={selected} onSelect={onSelect} />
      </Group>
    </Stack>
  );
}
