import { Divider, Stack, Text, Title } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BalanceChart } from "../../../../components/BalanceChart.tsx";
import { CardPageHeader } from "../../../../components/CardPageHeader.tsx";
import { CashFlowChart } from "../../../../components/CashFlowChart.tsx";
import { FeesPanel } from "../../../../components/FeeSchedules.tsx";
import { SpendingChart } from "../../../../components/SpendingChart.tsx";
import { parseInsightsSearch } from "../../../../lib/search.ts";
import {
  accountQuery,
  balanceHistoryQuery,
  cashFlowQuery,
  categoriesQuery,
  feeSchedulesQuery,
  feesQuery,
  logicalCardsQuery,
} from "../../../../queries.ts";

/** Every chart, graph and table about a logical card, in one place. */
export const Route = createFileRoute("/_app/a/$accountId/insights")({
  validateSearch: parseInsightsSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, params: { accountId }, deps }) => {
    const logicalCards = await queryClient.ensureQueryData(logicalCardsQuery(accountId));
    const id = deps.card ?? logicalCards[0]?.id;
    if (id === undefined || !logicalCards.some((l) => l.id === id)) return;
    await Promise.all([
      queryClient.ensureQueryData(cashFlowQuery(accountId, id)),
      queryClient.ensureQueryData(balanceHistoryQuery(accountId, id)),
      queryClient.ensureQueryData(feesQuery(accountId, id)),
      queryClient.ensureQueryData(feeSchedulesQuery(accountId)),
      queryClient.ensureQueryData(categoriesQuery),
    ]);
  },
  component: Insights,
});

function Insights() {
  const { accountId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const logical = logicalCards.find((l) => l.id === (search.card ?? logicalCards[0]?.id));

  return (
    <Stack gap="lg">
      <CardPageHeader
        accountId={accountId}
        title="Insights"
        logicalCards={logicalCards}
        selected={logical}
        onSelect={(card) => navigate({ search: card === undefined ? {} : { card } })}
      />
      {logical ? (
        // Keyed by card, so each chart starts afresh for another card.
        <Stack gap="xl" key={logical.id}>
          <Section title="Spending by category">
            <SpendingChart accountId={accountId} logicalCardId={logical.id} />
          </Section>
          <Section title="Cash flow">
            <CashFlowChart accountId={accountId} logicalCardId={logical.id} />
          </Section>
          <Section title="Balance over time">
            <BalanceChart accountId={accountId} logicalCardId={logical.id} />
          </Section>
          <Section title="Fees">
            <FeesPanel
              accountId={accountId}
              logicalCardId={logical.id}
              readOnly={account.archivedAt !== null}
            />
          </Section>
        </Stack>
      ) : (
        <Text c="dimmed">
          {logicalCards.length === 0 ? "No cards yet: sync the account." : "No such card."}
        </Text>
      )}
    </Stack>
  );
}

/** A titled part of the page, set off from the one above by a rule (as on the card page). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Divider mb="sm" />
      <Title order={4}>{title}</Title>
      {children}
    </Stack>
  );
}
