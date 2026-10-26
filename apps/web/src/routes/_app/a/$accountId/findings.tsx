import { Group, SegmentedControl, Select, Stack, Title } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FindingList } from "../../../../components/FindingList.tsx";
import { cardLabel, FINDING_KIND_LABELS } from "../../../../lib/format.ts";
import { FINDING_STATUSES, type FindingStatus, parseFindingsSearch } from "../../../../lib/search.ts";
import { cardsQuery, findingsQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/findings")({
  validateSearch: parseFindingsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, params: { accountId }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(findingsQuery(accountId, deps)),
    ]),
  component: Findings,
});

function Findings() {
  const { accountId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, search));

  return (
    <Stack>
      <Title order={2}>Findings</Title>
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
          w={220}
          placeholder="All cards"
          clearable
          data={cards.map((c) => ({ value: String(c.id), label: cardLabel(c) }))}
          value={search.cardId === undefined ? null : String(search.cardId)}
          onChange={(value) =>
            navigate({ search: (prev) => ({ ...prev, cardId: value ? Number(value) : undefined }) })
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
      <FindingList accountId={accountId} findings={findings} cards={cards} />
    </Stack>
  );
}
