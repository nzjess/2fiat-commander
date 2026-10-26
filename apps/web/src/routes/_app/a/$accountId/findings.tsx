import { Group, SegmentedControl, Select, Stack } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CardPageHeader } from "../../../../components/CardPageHeader.tsx";
import { FindingList } from "../../../../components/FindingList.tsx";
import { FINDING_KIND_LABELS } from "../../../../lib/format.ts";
import { FINDING_STATUSES, type FindingStatus, parseFindingsSearch } from "../../../../lib/search.ts";
import { accountQuery, cardsQuery, findingsQuery, logicalCardsQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/findings")({
  validateSearch: parseFindingsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, params: { accountId }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(findingsQuery(accountId, deps)),
    ]),
  component: Findings,
});

function Findings() {
  const { accountId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, search));

  return (
    <Stack>
      <CardPageHeader
        accountId={accountId}
        title="Findings"
        logicalCards={logicalCards}
        selected={logicalCards.find((l) => l.id === search.card)}
        onSelect={(card) => navigate({ search: (prev) => ({ ...prev, card }) })}
        allowAll
      />
      <Group gap="sm">
        <SegmentedControl
          size="xs"
          value={search.status ?? "open"}
          data={FINDING_STATUSES.map((s) => ({ value: s, label: s[0]?.toUpperCase() + s.slice(1) }))}
          onChange={(value) =>
            navigate({
              search: (prev) => ({
                ...prev,
                status: value === "open" ? undefined : (value as FindingStatus),
              }),
            })
          }
        />
        <Select
          size="xs"
          w={240}
          placeholder="All kinds"
          clearable
          data={Object.entries(FINDING_KIND_LABELS).map(([value, label]) => ({ value, label }))}
          value={search.kind ?? null}
          onChange={(value) => navigate({ search: (prev) => ({ ...prev, kind: value ?? undefined }) })}
        />
      </Group>
      <FindingList
        accountId={accountId}
        findings={findings}
        cards={cards}
        logicalCards={logicalCards}
        showCard={search.card === undefined}
        readOnly={account.archivedAt !== null}
      />
    </Stack>
  );
}
