import { Box, Group, Stack, Text } from "@mantine/core";
import type { Card } from "../api.ts";
import { isActive } from "../lib/format.ts";
import { CardChip } from "./CardChip.tsx";
import { Amount } from "./Money.tsx";

/** The network from a card number's first digit: 4 is Visa, 2 and 5 are Mastercard. */
export function cardNetwork(maskedNumber: string): "visa" | "mastercard" | undefined {
  const first = maskedNumber.trim()[0];
  if (first === "4") return "visa";
  if (first === "2" || first === "5") return "mastercard";
  return undefined;
}

/** Expiry as on the card, e.g. "06/29". */
export function expiryLabel(iso: string | null): string {
  if (!iso) return "--/--";
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}

const GRADIENTS = {
  mastercard: "linear-gradient(135deg, #1f2937 0%, #111827 55%, #3b2f1e 100%)",
  visa: "linear-gradient(135deg, #1e3a8a 0%, #172554 60%, #0f172a 100%)",
  other: "linear-gradient(135deg, #334155 0%, #0f172a 100%)",
};

function NetworkMark({ network }: { network: ReturnType<typeof cardNetwork> }) {
  if (network === "mastercard") {
    return (
      <svg width="44" height="28" viewBox="0 0 44 28" role="img" aria-label="Mastercard">
        <circle cx="15" cy="14" r="13" fill="#eb001b" />
        <circle cx="29" cy="14" r="13" fill="#f79e1b" fillOpacity="0.9" />
      </svg>
    );
  }
  if (network === "visa") {
    return (
      <Text fw={900} fs="italic" fz={22} c="white" lh={1}>
        VISA
      </Text>
    );
  }
  return null;
}

/**
 * A card drawn like the real thing: product, alias, masked number, expiry and network, with the balance where
 * the chip's label would be. Credit-card proportions (85.6 × 54 mm), scaled to `width`.
 */
export function CardFace({
  card,
  balanceCents,
  width = 320,
}: {
  card: Pick<Card, "alias" | "maskedNumber" | "expiresAt" | "product" | "status">;
  balanceCents?: number | null;
  width?: number;
}) {
  const network = cardNetwork(card.maskedNumber);
  const inactive = !isActive(card);
  return (
    <Box
      w={width}
      maw="100%"
      style={{
        aspectRatio: "85.6 / 54",
        borderRadius: width * 0.045,
        background: GRADIENTS[network ?? "other"],
        color: "white",
        padding: width * 0.06,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        opacity: inactive ? 0.55 : 1,
        filter: inactive ? "grayscale(0.8)" : undefined,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        flexShrink: 0,
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={0}>
          <Text fz="xs" tt="uppercase" opacity={0.7} lh={1.2}>
            2fiat {card.product}
          </Text>
          <Text fw={600} lh={1.3} lineClamp={1}>
            {card.alias}
          </Text>
        </Stack>
        {balanceCents != null && (
          <Text fw={700} fz="lg" lh={1.2}>
            <Amount cents={balanceCents} at={null} />
          </Text>
        )}
      </Group>
      <CardChip width={width * 0.14} />
      <Stack gap={4}>
        <Text ff="monospace" fz={width * 0.058} lts={1.5} lh={1} style={{ whiteSpace: "nowrap" }}>
          {card.maskedNumber}
        </Text>
        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Stack gap={0}>
            <Text fz={9} tt="uppercase" opacity={0.7}>
              {inactive ? `Status ${card.status}` : "Valid thru"}
            </Text>
            <Text ff="monospace" fz="sm">
              {expiryLabel(card.expiresAt)}
            </Text>
          </Stack>
          <NetworkMark network={network} />
        </Group>
      </Stack>
    </Box>
  );
}
