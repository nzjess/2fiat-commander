import {
  Button,
  CheckIcon,
  ColorSwatch,
  Group,
  Menu,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
  useComputedColorScheme,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Activity, api, type Category, type CategoryColor, ok, send } from "../api.ts";
import { CATEGORY_COLORS, CATEGORY_PALETTE, categoryHex } from "../lib/categories.ts";
import { categoriesQuery, sameMerchantQuery } from "../queries.ts";
import { RuleTag, useAlwaysForMerchant } from "./Rules.tsx";
import { ErrorView } from "./status.tsx";

/** A category colour key as the hex for the current colour scheme. */
export function useCategoryColor(): (color: CategoryColor) => string {
  const scheme = useComputedColorScheme("light");
  return (color) => categoryHex(color, scheme);
}

/** A category's colour dot and name. */
export function CategoryLabel({ category, size = "sm" }: { category: Category; size?: string }) {
  const hex = useCategoryColor();
  return (
    <Group gap={6} wrap="nowrap">
      <ColorSwatch color={hex(category.color)} size={8} withShadow={false} style={{ flexShrink: 0 }} />
      <Text size={size} lineClamp={1}>
        {category.name}
      </Text>
    </Group>
  );
}

/** What changes when an activity's annotation does: the activity lists, its details, spending, and usage counts. */
function useAnnotationChanged(accountId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["accounts", accountId, "activities"] }),
      queryClient.invalidateQueries({ queryKey: ["accounts", accountId, "cash-flow"] }),
      queryClient.invalidateQueries({ queryKey: categoriesQuery(accountId).queryKey }),
    ]);
}

const categoriesApi = api.accounts[":accountId"].categories;

type Annotated = Pick<
  Activity,
  "id" | "categorizable" | "categoryId" | "categoryRuleId" | "note" | "description"
>;

/**
 * An activity's category and note, as the drawer edits them. Spending takes a category (typing a new name creates
 * it); any activity takes a note, saved when the field loses focus. Setting a category offers it for the same
 * merchant's other uncategorised spending.
 */
export function ActivityAnnotation({ accountId, activity }: { accountId: string; activity: Annotated }) {
  const changed = useAnnotationChanged(accountId);
  const [offer, setOffer] = useState<Category | undefined>();
  const annotate = useMutation({
    mutationFn: (json: { categoryId?: number | null; note?: string | null }) =>
      ok(
        api.accounts[":accountId"].activities[":activityId"].annotation.$patch({
          param: { accountId, activityId: String(activity.id) },
          json,
        }),
      ),
    onSuccess: changed,
  });

  return (
    <Stack gap="xs">
      {activity.categorizable && (
        <CategoryPicker
          accountId={accountId}
          value={activity.categoryId}
          disabled={annotate.isPending}
          onChange={(category) =>
            annotate.mutate(
              { categoryId: category?.id ?? null },
              { onSuccess: () => setOffer(category ?? undefined) },
            )
          }
        />
      )}
      {activity.categoryRuleId !== null && <RuleTag accountId={accountId} ruleId={activity.categoryRuleId} />}
      {offer && (
        <SameMerchantOffer
          accountId={accountId}
          activity={activity}
          category={offer}
          onDone={() => setOffer(undefined)}
        />
      )}
      <NoteField
        // Starts afresh for each activity.
        key={activity.id}
        note={activity.note}
        saving={annotate.isPending}
        onSave={(note) => annotate.mutate({ note })}
      />
      {annotate.error && <ErrorView error={annotate.error} />}
    </Stack>
  );
}

const NEW = "new:";

/** Picks one of the account's categories, or creates one from what's typed. */
export function CategoryPicker({
  accountId,
  value,
  disabled,
  onChange,
}: {
  accountId: string;
  value: number | null;
  disabled?: boolean;
  onChange: (category: Category | null) => void;
}) {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useQuery(categoriesQuery(accountId));
  const hex = useCategoryColor();
  const [search, setSearch] = useState("");
  const create = useMutation({
    mutationFn: (name: string) => ok(categoriesApi.$post({ param: { accountId }, json: { name } })),
    onSuccess: async (category) => {
      await queryClient.invalidateQueries({ queryKey: categoriesQuery(accountId).queryKey });
      onChange(category);
    },
  });
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  // The search is controlled (for the create option), so it shows the chosen category's name itself, following
  // the value when it changes from outside (another activity, or the categories loading).
  const label = value === null ? "" : (byId.get(String(value))?.name ?? "");
  const [shown, setShown] = useState("");
  if (label !== shown) {
    setShown(label);
    setSearch(label);
  }
  const typed = search.trim();
  const exists = categories.some((c) => c.name.toLowerCase() === typed.toLowerCase());
  const data = [
    ...categories.map((c) => ({ value: String(c.id), label: c.name })),
    ...(typed && !exists ? [{ value: `${NEW}${typed}`, label: `Create "${typed}"` }] : []),
  ];

  return (
    <Stack gap={4}>
      <Select
        label="Category"
        placeholder="Uncategorised"
        searchable
        clearable
        nothingFoundMessage="Type a name to create a category"
        data={data}
        value={value === null ? null : String(value)}
        searchValue={search}
        onSearchChange={setSearch}
        disabled={disabled || create.isPending}
        leftSection={
          value !== null && byId.get(String(value)) ? (
            <ColorSwatch
              color={hex((byId.get(String(value)) as Category).color)}
              size={10}
              withShadow={false}
            />
          ) : undefined
        }
        renderOption={({ option }) => {
          const category = byId.get(option.value);
          return category ? (
            <CategoryLabel category={category} />
          ) : (
            <Text size="sm" c="blue">
              {option.label}
            </Text>
          );
        }}
        onChange={(v) => {
          if (v?.startsWith(NEW)) create.mutate(v.slice(NEW.length));
          else onChange(v === null ? null : (byId.get(v) ?? null));
        }}
      />
      {create.error && <ErrorView error={create.error} />}
    </Stack>
  );
}

/** A note, saved when the field loses focus and only if it changed. */
function NoteField({
  note,
  saving,
  onSave,
}: {
  note: string | null;
  saving: boolean;
  onSave: (note: string | null) => void;
}) {
  const [text, setText] = useState(note ?? "");
  return (
    <Textarea
      label="Note"
      placeholder="Add a note"
      autosize
      minRows={2}
      maxRows={8}
      maxLength={2000}
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        if (text.trim() !== (note ?? "")) onSave(text.trim() || null);
      }}
      description={saving ? "Saving…" : undefined}
    />
  );
}

/** Offers a category just set for the same merchant's other uncategorised spending, on any of the account's cards. */
function SameMerchantOffer({
  accountId,
  activity,
  category,
  onDone,
}: {
  accountId: string;
  activity: Annotated;
  category: Category;
  onDone: () => void;
}) {
  const changed = useAnnotationChanged(accountId);
  const { data } = useQuery(sameMerchantQuery(accountId, activity.id));
  const apply = useMutation({
    mutationFn: (activityIds: number[]) =>
      ok(
        api.accounts[":accountId"].activities.categorize.$post({
          param: { accountId },
          json: { activityIds, categoryId: category.id },
        }),
      ),
    onSuccess: changed,
  });
  const always = useAlwaysForMerchant(accountId, category);
  const ids = data?.activityIds ?? [];
  if (apply.isSuccess) {
    return (
      <Text size="xs" c="dimmed">
        Set {category.name} on {apply.data.count} more.
      </Text>
    );
  }
  if (always.isSuccess) {
    return (
      <Text size="xs" c="dimmed">
        New activities from this merchant will be {category.name}
        {always.data.count > 0 && `, and ${always.data.count} existing ones are now`}.
      </Text>
    );
  }
  if (!data) return null;
  const others = `${ids.length} other uncategorised ${ids.length === 1 ? "activity" : "activities"}`;
  return (
    <Paper withBorder p="xs" radius="md">
      <Text size="sm">
        {ids.length > 0 ? (
          <>
            Also set <b>{category.name}</b> on {others} from this merchant?
          </>
        ) : (
          <>
            Always use <b>{category.name}</b> for this merchant?
          </>
        )}
      </Text>
      <Text size="xs" c="dimmed">
        Matched on "{activity.description}", leaving out the country and any reference numbers.
      </Text>
      <Group gap="xs" mt="xs">
        {ids.length > 0 && (
          <Button
            size="compact-xs"
            variant="light"
            loading={apply.isPending}
            onClick={() => apply.mutate(ids)}
          >
            Set on all {ids.length}
          </Button>
        )}
        <Button
          size="compact-xs"
          variant="light"
          loading={always.isPending}
          onClick={() => always.mutate(activity.description)}
        >
          Always use {category.name} for this merchant
        </Button>
        <Button size="compact-xs" variant="light" color="gray" onClick={onDone}>
          No thanks
        </Button>
      </Group>
      {(apply.error ?? always.error) && <ErrorView error={apply.error ?? always.error} />}
    </Paper>
  );
}

/** The account's categories, to add, rename, recolour and delete. */
export function CategoryManager({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const { data: categories = [] } = useQuery(categoriesQuery(accountId));
  const [name, setName] = useState("");
  // Category changes show on the account's activities and spending.
  const changed = () => queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
  const create = useMutation({
    mutationFn: (name: string) => ok(categoriesApi.$post({ param: { accountId }, json: { name } })),
    onSuccess: async () => {
      setName("");
      await changed();
    },
  });

  return (
    <Stack gap="xs">
      {categories.length === 0 && (
        <Text size="sm" c="dimmed">
          No categories yet. Add them here, or as you set them on activities.
        </Text>
      )}
      {categories.map((c) => (
        <CategoryRow key={c.id} accountId={accountId} category={c} onChanged={changed} />
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
      >
        <Group gap="xs" mt="xs">
          <TextInput
            size="xs"
            placeholder="New category"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button
            size="compact-xs"
            variant="light"
            type="submit"
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Add a category
          </Button>
        </Group>
      </form>
      {create.error && <ErrorView error={create.error} />}
    </Stack>
  );
}

function CategoryRow({
  accountId,
  category,
  onChanged,
}: {
  accountId: string;
  category: Category;
  onChanged: () => Promise<unknown>;
}) {
  const hex = useCategoryColor();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const param = { accountId, categoryId: String(category.id) };
  const update = useMutation({
    mutationFn: (json: { name?: string; color?: CategoryColor }) =>
      ok(categoriesApi[":categoryId"].$patch({ param, json })),
    onSuccess: async () => {
      setRenaming(null);
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => send(categoriesApi[":categoryId"].$delete({ param })),
    onSuccess: onChanged,
  });
  // Only null for someone who can't see every card, who doesn't get this page.
  const activityCount = category.activityCount ?? 0;
  const ruleCount = category.ruleCount ?? 0;
  const uses = `${activityCount} ${activityCount === 1 ? "activity" : "activities"}`;

  return (
    <Stack gap={4}>
      <Group gap="sm" wrap="nowrap">
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <UnstyledButton aria-label={`Change ${category.name}'s colour`}>
              <ColorSwatch color={hex(category.color)} size={18} withShadow={false} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <SimpleGrid cols={4} spacing={6} p={4}>
              {CATEGORY_COLORS.map((color) => (
                <UnstyledButton
                  key={color}
                  aria-label={CATEGORY_PALETTE[color].label}
                  onClick={() => update.mutate({ color })}
                >
                  <ColorSwatch color={hex(color)} size={22} withShadow={false}>
                    {color === category.color && <CheckIcon size={10} color="white" />}
                  </ColorSwatch>
                </UnstyledButton>
              ))}
            </SimpleGrid>
          </Menu.Dropdown>
        </Menu>
        {renaming === null ? (
          <Text size="sm" style={{ flex: 1 }}>
            {category.name}{" "}
            <Text span size="xs" c="dimmed">
              {uses}
            </Text>
          </Text>
        ) : (
          <form
            style={{ flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming.trim()) update.mutate({ name: renaming.trim() });
            }}
          >
            <Group gap="xs" wrap="nowrap">
              <TextInput
                size="xs"
                maxLength={40}
                value={renaming}
                onChange={(e) => setRenaming(e.currentTarget.value)}
                autoFocus
              />
              <Button size="compact-xs" type="submit" loading={update.isPending}>
                Save
              </Button>
              <Button size="compact-xs" variant="default" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
            </Group>
          </form>
        )}
        {renaming === null && !confirming && (
          <Group gap={4} wrap="nowrap">
            <Button size="compact-xs" variant="light" onClick={() => setRenaming(category.name)}>
              Rename
            </Button>
            <Button size="compact-xs" variant="light" color="red" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </Group>
        )}
      </Group>
      {confirming && (
        <Paper withBorder p="xs" radius="md">
          <Text size="sm">
            Delete {category.name}?{" "}
            {activityCount > 0
              ? `Its ${uses} ${activityCount === 1 ? "becomes uncategorised, keeping its note" : "become uncategorised, keeping their notes"}`
              : "It isn't on any activity"}
            {ruleCount > 0 &&
              `, and ${ruleCount === 1 ? "the rule that sets it is" : `the ${ruleCount} rules that set it are`} deleted too`}
            .
          </Text>
          <Group gap="xs" mt="xs">
            <Button size="compact-xs" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </Button>
            <Button size="compact-xs" variant="default" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </Group>
        </Paper>
      )}
      {(update.error ?? remove.error) && <ErrorView error={update.error ?? remove.error} />}
    </Stack>
  );
}
