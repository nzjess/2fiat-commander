import {
  Alert,
  Button,
  CheckIcon,
  CloseButton,
  ColorSwatch,
  Group,
  MultiSelect,
  Pill,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { Card, LogicalCard } from "../../../../api.ts";
import { ActivityDrawer } from "../../../../components/ActivityDrawer.tsx";
import { ActivityTable } from "../../../../components/ActivityTable.tsx";
import { CardPageHeader } from "../../../../components/CardPageHeader.tsx";
import { ErrorView } from "../../../../components/status.tsx";
import { ACTIVITY_KIND_LABELS, ACTIVITY_STATUS_LABELS, FINDING_KIND_LABELS } from "../../../../lib/format.ts";
import {
  type ActivitySearch,
  activitiesParams,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  type PageSize,
  parseActivitySearch,
} from "../../../../lib/search.ts";
import { groupColor, kindsByGroup } from "../../../../lib/spending.ts";
import { activitiesQuery, cardsQuery, findingsQuery, logicalCardsQuery } from "../../../../queries.ts";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * The cursors of the Activity page's earlier pages, from page 2, so Previous can go back: the server's cursor
     * only goes forward. History state survives a reload and moves with Back and Forward; a pasted link has none.
     */
    activityCursors?: string[];
  }
}

/** A logical card's ledger, a page at a time, with filters and each activity's details in a drawer. */
export const Route = createFileRoute("/_app/a/$accountId/activity")({
  validateSearch: parseActivitySearch,
  // Opening an activity's details doesn't reload the list.
  loaderDeps: ({ search: { activity: _, ...filters } }) => filters,
  loader: async ({ context: { queryClient }, params: { accountId }, deps }) => {
    const [logicalCards] = await Promise.all([
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(cardsQuery(accountId)),
    ]);
    const id = deps.card ?? logicalCards[0]?.id;
    if (id === undefined || !logicalCards.some((l) => l.id === id)) return;
    await queryClient.ensureQueryData(activitiesQuery(accountId, activitiesParams(id, deps), deps.cursor));
  },
  component: ActivityPage,
});

function ActivityPage() {
  const { accountId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const { data: cards } = useSuspenseQuery(cardsQuery(accountId));
  const logical = logicalCards.find((l) => l.id === (search.card ?? logicalCards[0]?.id));
  const { activity, page, cursor, ...filters } = search;
  const params = logical && activitiesParams(logical.id, filters);
  const earlier = useRouterState({ select: (s) => s.location.state.activityCursors });
  // A new filter, or page size, starts again from the first page.
  const update = (patch: Partial<ActivitySearch>) =>
    navigate({
      search: (prev) => ({ ...prev, ...patch, activity: undefined, page: undefined, cursor: undefined }),
    });
  // Each page is a history entry, so Back returns to the page before.
  const turn = (to: { page?: number; cursor?: string; earlier: string[] }) => {
    navigate({
      search: (prev) => ({ ...prev, activity: undefined, page: to.page, cursor: to.cursor }),
      state: (prev) => ({ ...prev, activityCursors: to.earlier }),
    });
    // A new page starts at its top, not where the buttons left the last one.
    window.scrollTo({ top: 0 });
  };

  return (
    <Stack>
      <CardPageHeader
        accountId={accountId}
        title="Activity"
        logicalCards={logicalCards}
        selected={logical}
        // A finding belongs to one card, so it doesn't carry over.
        onSelect={(card) => update({ card, finding: undefined })}
      />
      {logical && params ? (
        <>
          <Filters search={search} logical={logical} accountId={accountId} update={update} />
          <Pages
            // Only the same filters' pages fade into each other.
            key={JSON.stringify(params)}
            accountId={accountId}
            params={params}
            page={page ?? 1}
            cursor={cursor}
            earlier={earlier ?? []}
            onTurn={turn}
            cards={cards}
            logical={logical}
            selectedId={activity}
            filtered={Object.keys(filters).some((k) => k !== "card" && k !== "size")}
            pageSize={search.size ?? DEFAULT_PAGE_SIZE}
            onPageSize={(size) => update({ size: size === DEFAULT_PAGE_SIZE ? undefined : size })}
            onOpen={(id) => navigate({ search: (prev) => ({ ...prev, activity: id }) })}
          />
          <ActivityDrawer
            accountId={accountId}
            activityId={activity}
            cards={cards}
            logical={logical}
            onClose={() => navigate({ search: (prev) => ({ ...prev, activity: undefined }) })}
          />
        </>
      ) : (
        <Text c="dimmed">
          {logicalCards.length === 0 ? "No cards yet: sync the account." : "No such card."}
        </Text>
      )}
    </Stack>
  );
}

const KIND_OPTIONS = kindsByGroup(Object.keys(ACTIVITY_KIND_LABELS)).map(({ group, kinds }) => ({
  group,
  items: kinds.map((value) => ({
    value,
    label: ACTIVITY_KIND_LABELS[value as keyof typeof ACTIVITY_KIND_LABELS],
  })),
}));

function Filters({
  accountId,
  search,
  logical,
  update,
}: {
  accountId: string;
  search: ActivitySearch;
  logical: LogicalCard;
  update: (patch: Partial<ActivitySearch>) => void;
}) {
  // Typing updates the URL once it pauses, so each keystroke doesn't refetch.
  const [text, setText] = useState(search.q ?? "");
  const updateText = useDebouncedCallback((q: string) => update({ q: q.trim() || undefined }), 300);
  // When the URL's search changes some other way (Back or Forward), the box follows it. Its own debounced update
  // arrives as what's typed, trimmed, so leaves the text alone.
  const [shown, setShown] = useState(search.q);
  if (search.q !== shown) {
    setShown(search.q);
    if ((search.q ?? "") !== text.trim()) setText(search.q ?? "");
  }
  const split = (value: string | undefined) => (value ? value.split(",") : []);
  const join = (values: string[]) => (values.length ? values.join(",") : undefined);

  return (
    <Stack gap="xs">
      <Group gap="sm" align="flex-end" wrap="wrap">
        <MultiSelect
          size="xs"
          label="Kind"
          // Takes the row's spare width, so several kinds fit, but its list needn't be as wide.
          style={{ flex: 1, minWidth: 240 }}
          comboboxProps={{ width: 280, position: "bottom-start" }}
          placeholder={search.kind ? undefined : "All kinds"}
          // Under the spending chart's groups, each with its colour dot, as the table draws kinds.
          data={KIND_OPTIONS}
          // Tall enough for every kind and group heading (about 440px), so the list doesn't scroll.
          maxDropdownHeight={460}
          renderOption={({ option, checked }) => (
            <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
              <ColorSwatch color={groupColor(option.value)} size={8} withShadow={false} />
              <Text size="xs" style={{ flex: 1 }}>
                {option.label}
              </Text>
              {checked && <CheckIcon size={10} />}
            </Group>
          )}
          renderPill={({ option, onRemove, disabled }) => (
            <Pill withRemoveButton onRemove={onRemove} disabled={disabled}>
              <Group gap={6} wrap="nowrap" component="span">
                <ColorSwatch color={groupColor(String(option.value))} size={8} withShadow={false} />
                {option.label}
              </Group>
            </Pill>
          )}
          value={split(search.kind)}
          // Choosing fees shows them again.
          onChange={(values) =>
            update({ kind: join(values), ...(values.includes("fee") && { hideFees: undefined }) })
          }
          clearable
        />
        <MultiSelect
          size="xs"
          w={200}
          label="Status"
          placeholder={search.status ? undefined : "All statuses"}
          data={Object.entries(ACTIVITY_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          value={split(search.status)}
          onChange={(values) => update({ status: join(values) })}
          clearable
        />
        <TextInput
          size="xs"
          w={240}
          label="Search"
          placeholder="Description"
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            updateText(e.currentTarget.value);
          }}
          rightSection={
            text && (
              <CloseButton
                size="sm"
                aria-label="Clear the search"
                onClick={() => {
                  setText("");
                  update({ q: undefined });
                }}
              />
            )
          }
        />
      </Group>
      <Group gap="sm" align="flex-end">
        <TextInput
          size="xs"
          type="date"
          label="From"
          value={search.from ?? ""}
          onChange={(e) => update({ from: e.currentTarget.value || undefined })}
        />
        <TextInput
          size="xs"
          type="date"
          label="To"
          value={search.to ?? ""}
          onChange={(e) => update({ to: e.currentTarget.value || undefined })}
        />
        <Switch
          size="xs"
          mb={6}
          label="Hide fees"
          checked={search.hideFees === true}
          onChange={(e) =>
            update(
              e.currentTarget.checked
                ? // Hidden fees can't also be chosen.
                  { hideFees: true, kind: join(split(search.kind).filter((k) => k !== "fee")) }
                : { hideFees: undefined },
            )
          }
        />
        <Switch
          size="xs"
          mb={6}
          label="Stale holds only"
          checked={search.stale === true}
          onChange={(e) => update({ stale: e.currentTarget.checked || undefined })}
        />
      </Group>
      {search.finding !== undefined && (
        <FindingFilter
          accountId={accountId}
          logical={logical}
          findingId={search.finding}
          onClear={() => update({ finding: undefined })}
        />
      )}
    </Stack>
  );
}

/** Shows which finding the list is narrowed to, and clears it. */
function FindingFilter({
  accountId,
  logical,
  findingId,
  onClear,
}: {
  accountId: string;
  logical: LogicalCard;
  findingId: number;
  onClear: () => void;
}) {
  const { data: findings } = useQuery(findingsQuery(accountId, { card: logical.id, status: "all" }));
  const finding = findings?.find((f) => f.id === findingId);
  return (
    <Group gap="xs">
      <Pill withRemoveButton onRemove={onClear} size="md">
        Finding: {finding ? FINDING_KIND_LABELS[finding.kind] : `#${findingId}`}
      </Pill>
      {finding && (
        <Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1 }}>
          {finding.message}
        </Text>
      )}
    </Group>
  );
}

/**
 * The list a page at a time. The server's cursor only goes forward, so the earlier pages' cursors come along to
 * go back. Without them (a pasted link), Previous goes to the first page.
 */
function Pages({
  accountId,
  params,
  page,
  cursor,
  earlier,
  onTurn,
  cards,
  logical,
  selectedId,
  filtered,
  pageSize,
  onPageSize,
  onOpen,
}: {
  accountId: string;
  params: Record<string, string>;
  page: number;
  cursor: string | undefined;
  earlier: string[];
  onTurn: (to: { page?: number; cursor?: string; earlier: string[] }) => void;
  cards: Card[];
  logical: LogicalCard;
  selectedId: number | undefined;
  filtered: boolean;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
  onOpen: (activityId: number) => void;
}) {
  const { data, error, isPlaceholderData } = useQuery({
    ...activitiesQuery(accountId, params, cursor),
    placeholderData: keepPreviousData,
  });
  if (error) return <ErrorView error={error} />;
  if (!data) return null;
  if (data.items.length === 0 && page === 1) {
    return (
      <Alert variant="light" color="gray">
        {filtered ? "No activity matches these filters." : "No activity yet."}
      </Alert>
    );
  }
  const next = data.nextCursor;
  // Page n's cursor sits at earlier[n - 2], page 1 having none.
  const previous = () => {
    const back = page - 1;
    const at = earlier[back - 2];
    if (back > 1 && at !== undefined && earlier.length === page - 2) {
      onTurn({ page: back, cursor: at, earlier: earlier.slice(0, -1) });
    } else {
      onTurn({ earlier: [] });
    }
  };
  return (
    <Stack gap="xs" style={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
      <ActivityTable
        activities={data.items}
        cards={cards}
        logical={logical}
        selectedId={selectedId}
        onOpen={onOpen}
      />
      <Group justify="space-between">
        <Group gap="sm">
          <Text size="sm" c="dimmed">
            Page {page}
          </Text>
          <Select
            size="xs"
            w={80}
            aria-label="Rows per page"
            data={PAGE_SIZES.map(String)}
            value={String(pageSize)}
            allowDeselect={false}
            onChange={(value) => {
              const size = PAGE_SIZES.find((n) => String(n) === value);
              if (size) onPageSize(size);
            }}
          />
          <Text size="sm" c="dimmed">
            per page
          </Text>
        </Group>
        {(page > 1 || next) && (
          <Group gap="xs">
            <Button size="xs" variant="default" disabled={page === 1 || isPlaceholderData} onClick={previous}>
              Previous
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={!next || isPlaceholderData}
              onClick={() =>
                next && onTurn({ page: page + 1, cursor: next, earlier: cursor ? [...earlier, cursor] : [] })
              }
            >
              Next
            </Button>
          </Group>
        )}
      </Group>
    </Stack>
  );
}
