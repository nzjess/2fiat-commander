import { Alert, Badge, Center, Loader, Stack, Text, Title, Tooltip } from "@mantine/core";
import { ApiError } from "../api.ts";
import { formatMoney } from "../lib/format.ts";
import { AnchorLink } from "./links.tsx";

export function PageLoader() {
  return (
    <Center h="40vh">
      <Loader />
    </Center>
  );
}

/** A route's or a query's error. A 404 reads as "not found"; anything else shows its message. */
export function ErrorView({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Stack align="center" gap="xs" py="xl">
        <Title order={3}>Not found</Title>
        <Text c="dimmed">{error.message}.</Text>
        <AnchorLink to="/accounts">Your accounts</AnchorLink>
      </Stack>
    );
  }
  return (
    <Alert color="red" variant="light" title="Something went wrong">
      {error instanceof Error ? error.message : String(error)}
    </Alert>
  );
}

/** A balance gap: quiet at zero, red otherwise. */
export function GapBadge({ cents, currency }: { cents: number; currency: string }) {
  if (cents === 0) {
    return (
      <Badge color="green" variant="light">
        No gap
      </Badge>
    );
  }
  return (
    <Tooltip label="What 2fiat reports, minus what its rows explain">
      <Badge color="red" variant="light">
        Gap {formatMoney(cents, currency, { signed: true })}
      </Badge>
    </Tooltip>
  );
}

/** Marks a balance that moved during its sync, so its gap may not be real. */
export function TransientBadge() {
  return (
    <Tooltip label="The balance changed while syncing, so this gap may be a timing artefact">
      <Badge color="yellow" variant="light">
        Moving
      </Badge>
    </Tooltip>
  );
}

export function OpeningBadge({ source }: { source: "inferred" | "entered" }) {
  return source === "inferred" ? (
    <Tooltip label="Inferred from the gap at the first sync: 2fiat has no history before it">
      <Badge color="gray" variant="light">
        Inferred
      </Badge>
    </Tooltip>
  ) : (
    <Badge color="blue" variant="light">
      Entered
    </Badge>
  );
}
