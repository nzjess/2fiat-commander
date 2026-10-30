import { Stack, Text } from "@mantine/core";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AnchorLink } from "../../../../../components/links.tsx";
import { positiveInt } from "../../../../../lib/search.ts";
import { setLastCard } from "../../../../../lib/storage.ts";
import { logicalCardsQuery } from "../../../../../queries.ts";

/**
 * One logical card's pages: its own, and its activity, insights and findings. Remembers the card, so the sidebar
 * comes back to it from pages without one (the overview, accounts, settings).
 */
export const Route = createFileRoute("/_app/a/$accountId/c/$logicalCardId")({
  // Before the pages' loaders, which run in parallel with a layout's: they can count on the card existing.
  beforeLoad: async ({ context: { queryClient }, params: { accountId, logicalCardId } }) => {
    const id = positiveInt(logicalCardId);
    if (id === undefined) throw notFound();
    const logicalCards = await queryClient.ensureQueryData(logicalCardsQuery(accountId));
    if (!logicalCards.some((l) => l.id === id)) throw notFound();
  },
  component: CardLayout,
  notFoundComponent: CardNotFound,
});

function CardLayout() {
  const { accountId, logicalCardId } = Route.useParams();
  useEffect(() => setLastCard(accountId, Number(logicalCardId)), [accountId, logicalCardId]);
  return <Outlet />;
}

// E.g. a link to a card whose physical cards have since moved into another logical card.
function CardNotFound() {
  const { accountId } = Route.useParams();
  return (
    <Stack gap="xs">
      <Text c="dimmed">This card doesn't exist, or no longer does.</Text>
      <AnchorLink to="/a/$accountId" params={{ accountId }} size="sm">
        See the account's cards
      </AnchorLink>
    </Stack>
  );
}
