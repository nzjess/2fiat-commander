import { Divider, Stack, Text, Title } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BalanceChart } from "../../../../../../components/BalanceChart.tsx";
import { CardPageHeader } from "../../../../../../components/CardPageHeader.tsx";
import { CashFlowChart } from "../../../../../../components/CashFlowChart.tsx";
import { FeesPanel } from "../../../../../../components/FeeSchedules.tsx";
import { SpendingChart } from "../../../../../../components/SpendingChart.tsx";
import {
  accountQuery,
  balanceHistoryQuery,
  cashFlowQuery,
  categoriesQuery,
  feeSchedulesQuery,
  feesQuery,
  logicalCardsQuery,
} from "../../../../../../queries.ts";

/** Every chart, graph and table about a logical card, in one place. */
export const Route = createFileRoute("/_app/a/$accountId/c/$logicalCardId/insights")({
  loader: async ({ context: { queryClient }, params: { accountId, logicalCardId } }) => {
    const id = Number(logicalCardId);
    await Promise.all([
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(cashFlowQuery(accountId, id)),
      queryClient.ensureQueryData(balanceHistoryQuery(accountId, id)),
      queryClient.ensureQueryData(feesQuery(accountId, id)),
      queryClient.ensureQueryData(feeSchedulesQuery(accountId)),
      queryClient.ensureQueryData(categoriesQuery(accountId)),
    ]);
  },
  component: Insights,
});

function Insights() {
  const { accountId, logicalCardId } = Route.useParams();
  const navigate = Route.useNavigate();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const logical = logicalCards.find((l) => l.id === Number(logicalCardId));
  // E.g. just after its last physical card moved into another logical card.
  if (!logical) return <Text c="dimmed">This card no longer exists.</Text>;

  return (
    <Stack gap="lg">
      <CardPageHeader
        accountId={accountId}
        title="Insights"
        logicalCards={logicalCards}
        selected={logical}
        onSelect={(other) =>
          navigate({
            to: "/a/$accountId/c/$logicalCardId/insights",
            params: { accountId, logicalCardId: String(other) },
          })
        }
      />
      {/* Keyed by card, so each chart starts afresh for another card. */}
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
