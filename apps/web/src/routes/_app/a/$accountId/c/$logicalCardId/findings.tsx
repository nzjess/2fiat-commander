import { Group, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CardPageHeader } from "../../../../../../components/CardPageHeader.tsx";
import { FindingList } from "../../../../../../components/FindingList.tsx";
import { FINDING_KIND_LABELS } from "../../../../../../lib/format.ts";
import { FINDING_STATUSES, type FindingStatus, parseFindingsSearch } from "../../../../../../lib/search.ts";
import { accountQuery, cardsQuery, findingsQuery, logicalCardsQuery } from "../../../../../../queries.ts";

/** A logical card's reconciliation findings, open ones by default. */
export const Route = createFileRoute("/_app/a/$accountId/c/$logicalCardId/findings")({
  validateSearch: parseFindingsSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, params: { accountId, logicalCardId }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(cardsQuery(accountId)),
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(findingsQuery(accountId, { ...deps, card: Number(logicalCardId) })),
    ]),
  component: Findings,
});

function Findings() {
  const { accountId, logicalCardId } = Route.useParams();
  const id = Number(logicalCardId);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: account } = useSuspenseQuery(accountQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: findings } = useSuspenseQuery(findingsQuery(accountId, { ...search, card: id }));
  const logical = logicalCards.find((l) => l.id === id);
  // E.g. just after its last physical card moved into another logical card.
  if (!logical) return <Text c="dimmed">This card no longer exists.</Text>;

  return (
    <Stack>
      <CardPageHeader
        accountId={accountId}
        title="Findings"
        logicalCards={logicalCards}
        selected={logical}
        // The status and kind filters carry over to the other card.
        onSelect={(other) =>
          navigate({
            to: "/a/$accountId/c/$logicalCardId/findings",
            params: { accountId, logicalCardId: String(other) },
            search: (prev) => prev,
          })
        }
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
        readOnly={account.archivedAt !== null}
      />
    </Stack>
  );
}
