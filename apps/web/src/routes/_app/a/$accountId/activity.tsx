import {
  Alert,
  Button,
  CheckIcon,
  CloseButton,
  ColorSwatch,
  Group,
  Input,
  MultiSelect,
  Pill,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDebouncedCallback, useMediaQuery } from "@mantine/hooks";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import type { Card, LogicalCard } from "../../../../api.ts";
import { ActivityDrawer } from "../../../../components/ActivityDrawer.tsx";
import { ActivityTable } from "../../../../components/ActivityTable.tsx";
import { CardPageHeader } from "../../../../components/CardPageHeader.tsx";
import { useCategoryColor } from "../../../../components/Categories.tsx";
import { ErrorView } from "../../../../components/status.tsx";
import { groupColor, kindsByGroup } from "../../../../lib/cashflow.ts";
import {
  ACTIVITY_KIND_LABELS,
  ACTIVITY_STATUS_FILTERS,
  FINDING_KIND_LABELS,
  isoToLocalDate,
} from "../../../../lib/format.ts";
import {
  type ActivitySearch,
  activitiesParams,
  DEFAULT_PAGE_SIZE,
  datePresets,
  PAGE_SIZES,
  type PageSize,
  parseActivitySearch,
} from "../../../../lib/search.ts";
import { defaultCard } from "../../../../lib/storage.ts";
import {
  activitiesQuery,
  cardsQuery,
  categoriesQuery,
  findingsQuery,
  logicalCardsQuery,
} from "../../../../queries.ts";

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
    const id = deps.card ?? defaultCard(accountId, logicalCards);
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
  const logical = logicalCards.find((l) => l.id === (search.card ?? defaultCard(accountId, logicalCards)));
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
      {/* One row, wrapping on a narrow screen, its labels in line however tall several kinds make Kind. */}
      <Group gap="sm" align="flex-start" wrap="wrap">
        <MultiSelect
          size="xs"
          label="Kind"
          // Takes the row's spare width, so the filters span the page; its list needn't be as wide.
          style={{ flex: 1, minWidth: 260 }}
          comboboxProps={{ width: 280, position: "bottom-start" }}
          placeholder={search.kind ? undefined : "All kinds"}
          // Under the cash flow chart's groups, each with its colour dot, as the table draws kinds.
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
          data={Object.entries(ACTIVITY_STATUS_FILTERS).map(([value, label]) => ({ value, label }))}
          value={split(search.status)}
          onChange={(values) => update({ status: join(values) })}
          clearable
        />
        <CategoryFilter
          value={split(search.category)}
          onChange={(values) => update({ category: join(values) })}
        />
        <TextInput
          size="xs"
          w={240}
          label="Search"
          placeholder="Description or note"
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
        <DateRange from={search.from} to={search.to} onChange={(from, to) => update({ from, to })} />
        {/* Labelled above, like the fields beside it, and centred in a field's height. */}
        <Input.Wrapper size="xs" label="Hide fees" labelElement="div">
          <Group h={30}>
            <Switch
              size="xs"
              aria-label="Hide fees"
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
          </Group>
        </Input.Wrapper>
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

/** Narrows to some categories, or to spending with none yet. */
function CategoryFilter({ value, onChange }: { value: string[]; onChange: (values: string[]) => void }) {
  const { data: categories = [] } = useQuery(categoriesQuery);
  const hex = useCategoryColor();
  const colorOf = new Map(categories.map((c) => [String(c.id), hex(c.color)]));
  const swatch = (v: string) =>
    v === "none" ? undefined : (
      <ColorSwatch color={colorOf.get(v) ?? "transparent"} size={8} withShadow={false} />
    );
  return (
    <MultiSelect
      size="xs"
      w={200}
      label="Category"
      placeholder={value.length ? undefined : "All categories"}
      data={[
        { value: "none", label: "Uncategorised" },
        ...categories.map((c) => ({ value: String(c.id), label: c.name })),
      ]}
      value={value}
      onChange={onChange}
      renderOption={({ option, checked }) => (
        <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
          {swatch(option.value)}
          <Text size="xs" style={{ flex: 1 }} fs={option.value === "none" ? "italic" : undefined}>
            {option.label}
          </Text>
          {checked && <CheckIcon size={10} />}
        </Group>
      )}
      renderPill={({ option, onRemove, disabled }) => (
        <Pill withRemoveButton onRemove={onRemove} disabled={disabled}>
          <Group gap={6} wrap="nowrap" component="span">
            {option && swatch(String(option.value))}
            {option?.label}
          </Group>
        </Pill>
      )}
      clearable
    />
  );
}

/**
 * The date filter as one range, picked like a booking site's: a click for the first day, another for the last (the
 * same day twice for one day), or a quick pick. The URL changes only once both ends are chosen, or on clearing.
 */
function DateRange({
  from,
  to,
  onChange,
}: {
  from: string | undefined;
  to: string | undefined;
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  const wide = useMediaQuery("(min-width: 48em)");
  const [range, setRange] = useState<[string | null, string | null]>([from ?? null, to ?? null]);
  // When the URL changes some other way (Back or Forward), the field follows it.
  const [shown, setShown] = useState(`${from}|${to}`);
  if (`${from}|${to}` !== shown) {
    setShown(`${from}|${to}`);
    setRange([from ?? null, to ?? null]);
  }
  const today = new Date();

  return (
    <DatePickerInput
      type="range"
      size="xs"
      w={210}
      label="Dates"
      placeholder="Any time"
      valueFormat="D MMM YYYY"
      value={range}
      onChange={(value) => {
        setRange(value);
        const [start, end] = value;
        if (start && end) onChange(start, end);
        else if (!start && !end) onChange(undefined, undefined);
      }}
      allowSingleDateInRange
      maxDate={today}
      numberOfColumns={wide ? 2 : 1}
      // Opens on the range, or on last month and this one: there's nothing to pick after today.
      defaultDate={
        range[0] ??
        isoToLocalDate(new Date(today.getFullYear(), today.getMonth() - (wide ? 1 : 0), 1).toISOString())
      }
      // Red weekends would read as a warning here.
      weekendDays={[]}
      presets={datePresets(today)}
      clearable
    />
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
