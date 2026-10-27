import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Category, ok, type Rule, type RuleMatch, send } from "../api.ts";
import { categoriesQuery, rulesQuery } from "../queries.ts";
import { CategoryLabel } from "./Categories.tsx";
import { ErrorView } from "./status.tsx";

// Category rules: each sets a category on new uncategorised spending that matches it (the first match wins), and
// on existing spending only when asked. Shared by all the user's accounts.

/** A rule's condition in words: `Merchant "GROCER STORES SPRINGFIELD"`, `Description contains "bigstore"`. */
export function ruleCondition(rule: Pick<Rule, "match" | "pattern">): string {
  return rule.match === "merchant"
    ? `Merchant "${rule.pattern.toUpperCase()}"`
    : `Description contains "${rule.pattern}"`;
}

/** Rules and categories changed: refresh both, and every account's activities and spending. */
function useRulesChanged() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: categoriesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    ]);
}

/** Says which rule set an activity's category, in the drawer. */
export function RuleTag({ ruleId }: { ruleId: number }) {
  const { data: rules } = useQuery(rulesQuery);
  const rule = rules?.find((r) => r.id === ruleId);
  return (
    <Text size="xs" c="dimmed">
      Set by a rule{rule ? `: ${ruleCondition(rule)}` : ""}. Changing it here makes it your own.
    </Text>
  );
}

/** Makes a merchant rule from an activity's description, and applies it to the existing uncategorised spending. */
export function useAlwaysForMerchant(category: Category) {
  const changed = useRulesChanged();
  return useMutation({
    mutationFn: async (description: string) => {
      const rule = await ok(
        api.categories.rules.$post({
          json: { categoryId: category.id, match: "merchant", pattern: description },
        }),
      );
      return ok(api.categories.rules[":ruleId"].apply.$post({ param: { ruleId: String(rule.id) } }));
    },
    onSuccess: changed,
  });
}

/** Offers a rule's category for the existing uncategorised spending it matches, when there is any. */
function ApplyOffer({ rule, onDone }: { rule: Rule; onDone: () => void }) {
  const changed = useRulesChanged();
  const param = { param: { ruleId: String(rule.id) } };
  const { data } = useQuery({
    queryKey: ["categories", "rules", rule.id, "matches"],
    queryFn: () => ok(api.categories.rules[":ruleId"].matches.$get(param)),
    staleTime: 0,
  });
  const apply = useMutation({
    mutationFn: () => ok(api.categories.rules[":ruleId"].apply.$post(param)),
    onSuccess: changed,
  });
  if (apply.isSuccess) {
    return (
      <Text size="xs" c="dimmed">
        Set on {apply.data.count} existing {apply.data.count === 1 ? "activity" : "activities"}.
      </Text>
    );
  }
  if (!data || data.count === 0) return null;
  return (
    <Paper withBorder p="xs" radius="md">
      <Text size="sm">
        Also apply it to {data.count} existing uncategorised {data.count === 1 ? "activity" : "activities"}?
        New ones get it at each sync either way.
      </Text>
      <Group gap="xs" mt="xs">
        <Button size="compact-xs" variant="light" loading={apply.isPending} onClick={() => apply.mutate()}>
          Apply to {data.count}
        </Button>
        <Button size="compact-xs" variant="light" color="gray" onClick={onDone}>
          Not now
        </Button>
      </Group>
      {apply.error && <ErrorView error={apply.error} />}
    </Paper>
  );
}

const MATCHES: { value: RuleMatch; label: string }[] = [
  { value: "contains", label: "Description contains" },
  { value: "merchant", label: "Merchant is" },
];

/** The user's rules in order, to add, edit, reorder and delete. */
export function RuleManager() {
  const { data: rules = [] } = useQuery(rulesQuery);
  const { data: categories = [] } = useQuery(categoriesQuery);
  const changed = useRulesChanged();
  // The rule just added or edited, offered for the existing spending it matches; `at` starts each offer afresh.
  const [offer, setOffer] = useState<{ ruleId: number; at: number } | undefined>();
  const offerFor = (ruleId: number) => setOffer({ ruleId, at: Date.now() });
  const reorder = useMutation({
    mutationFn: (ids: number[]) => send(api.categories.rules.order.$put({ json: { ids } })),
    onSuccess: changed,
  });
  const move = (index: number, by: -1 | 1) => {
    const ids = rules.map((r) => r.id);
    const [id] = ids.splice(index, 1);
    if (id !== undefined) ids.splice(index + by, 0, id);
    reorder.mutate(ids);
  };
  const offered = rules.find((r) => r.id === offer?.ruleId);

  return (
    <Stack gap="xs">
      {rules.length === 0 && (
        <Text size="sm" c="dimmed">
          No rules yet. Add one here, or choose "Always use…" after setting a purchase's category.
        </Text>
      )}
      {rules.map((rule, i) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          categories={categories}
          first={i === 0}
          last={i === rules.length - 1}
          moving={reorder.isPending}
          onMove={(by) => move(i, by)}
          onSaved={() => offerFor(rule.id)}
        />
      ))}
      {reorder.error && <ErrorView error={reorder.error} />}
      {offered && <ApplyOffer key={offer?.at} rule={offered} onDone={() => setOffer(undefined)} />}
      <NewRule categories={categories} onAdded={offerFor} />
    </Stack>
  );
}

function RuleRow({
  rule,
  categories,
  first,
  last,
  moving,
  onMove,
  onSaved,
}: {
  rule: Rule;
  categories: Category[];
  first: boolean;
  last: boolean;
  moving: boolean;
  onMove: (by: -1 | 1) => void;
  onSaved: () => void;
}) {
  const changed = useRulesChanged();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clear, setClear] = useState(false);
  const param = { ruleId: String(rule.id) };
  const remove = useMutation({
    mutationFn: () =>
      send(api.categories.rules[":ruleId"].$delete({ param, query: clear ? { clear: "true" } : {} })),
    onSuccess: changed,
  });
  const category = categories.find((c) => c.id === rule.categoryId);
  const set = `${rule.activityCount} ${rule.activityCount === 1 ? "activity" : "activities"}`;

  if (editing) {
    return (
      <RuleForm
        rule={rule}
        categories={categories}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onSaved();
        }}
      />
    );
  }
  return (
    <Stack gap={4}>
      <Group gap="sm" wrap="nowrap">
        <Group gap={2} wrap="nowrap">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Move up"
            disabled={first || moving}
            onClick={() => onMove(-1)}
          >
            ↑
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Move down"
            disabled={last || moving}
            onClick={() => onMove(1)}
          >
            ↓
          </ActionIcon>
        </Group>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" lineClamp={1}>
            {ruleCondition(rule)}
          </Text>
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed">
              →
            </Text>
            {category && <CategoryLabel category={category} size="xs" />}
            <Text size="xs" c="dimmed">
              · set on {set}
            </Text>
          </Group>
        </Stack>
        {!confirming && (
          <Group gap={4} wrap="nowrap">
            <Button size="compact-xs" variant="light" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="compact-xs" variant="light" color="red" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </Group>
        )}
      </Group>
      {confirming && (
        <Paper withBorder p="xs" radius="md">
          <Text size="sm">Delete this rule? New activities won't get its category.</Text>
          {rule.activityCount > 0 && (
            <Checkbox
              mt="xs"
              size="xs"
              label={`Also clear the category from the ${set} it set`}
              checked={clear}
              onChange={(e) => setClear(e.currentTarget.checked)}
            />
          )}
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
      {remove.error && <ErrorView error={remove.error} />}
    </Stack>
  );
}

/** Adds a rule, with a live count of the existing uncategorised spending it would match. */
function NewRule({ categories, onAdded }: { categories: Category[]; onAdded: (ruleId: number) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Group mt="xs">
        <Button
          size="compact-xs"
          variant="light"
          onClick={() => setOpen(true)}
          disabled={categories.length === 0}
        >
          Add a rule
        </Button>
        {categories.length === 0 && (
          <Text size="xs" c="dimmed">
            Add a category first
          </Text>
        )}
      </Group>
    );
  }
  return (
    <RuleForm
      categories={categories}
      onCancel={() => setOpen(false)}
      onSaved={(id) => {
        setOpen(false);
        onAdded(id);
      }}
    />
  );
}

/** Edits a rule, or makes a new one when there's none. */
function RuleForm({
  rule,
  categories,
  onCancel,
  onSaved,
}: {
  rule?: Rule;
  categories: Category[];
  onCancel: () => void;
  onSaved: (ruleId: number) => void;
}) {
  const changed = useRulesChanged();
  const [match, setMatch] = useState<RuleMatch>(rule?.match ?? "contains");
  // A merchant shows as 2fiat writes it, in capitals; it's stored as matched, in lower case.
  const [pattern, setPattern] = useState(
    rule ? (rule.match === "merchant" ? rule.pattern.toUpperCase() : rule.pattern) : "",
  );
  const [categoryId, setCategoryId] = useState<number | undefined>(rule?.categoryId);
  const [moveSet, setMoveSet] = useState(true);
  const [typed] = useDebouncedValue(pattern.trim(), 300);
  const { data: preview } = useQuery({
    queryKey: ["categories", "rules", "preview", match, typed],
    queryFn: () => ok(api.categories.rules.preview.$get({ query: { match, pattern: typed } })),
    enabled: typed.length > 0,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (categoryId === undefined) throw new Error("Choose a category");
      const json = { categoryId, match, pattern: pattern.trim() };
      if (!rule) return ok(api.categories.rules.$post({ json }));
      const moving = categoryId !== rule.categoryId && rule.activityCount > 0 && moveSet;
      return ok(
        api.categories.rules[":ruleId"].$patch({
          param: { ruleId: String(rule.id) },
          json: { ...json, ...(moving && { move: true }) },
        }),
      );
    },
    onSuccess: async (saved) => {
      await changed();
      if (saved) onSaved(saved.id);
    },
  });
  const recategorising = rule !== undefined && categoryId !== rule.categoryId && rule.activityCount > 0;

  return (
    <Paper withBorder p="xs" radius="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Stack gap="xs">
          <SegmentedControl
            size="xs"
            data={MATCHES}
            value={match}
            onChange={(v) => setMatch(v as RuleMatch)}
            style={{ alignSelf: "flex-start" }}
          />
          <Group gap="xs" align="flex-start" wrap="wrap">
            <TextInput
              size="xs"
              w={260}
              placeholder={match === "merchant" ? "e.g. GROCER STORES SPRINGFIELD USA" : "e.g. bigstore"}
              description={
                match === "merchant"
                  ? "A description as 2fiat writes it: the country and reference numbers are left out"
                  : "Matched without regard to case, in the description or what it posted as"
              }
              maxLength={200}
              value={pattern}
              onChange={(e) => setPattern(e.currentTarget.value)}
              autoFocus
            />
            <Select
              size="xs"
              w={200}
              placeholder="Category"
              data={categories.map((c) => ({ value: String(c.id), label: c.name }))}
              value={categoryId === undefined ? null : String(categoryId)}
              onChange={(v) => setCategoryId(v === null ? undefined : Number(v))}
              renderOption={({ option }) => {
                const c = categories.find((x) => String(x.id) === option.value);
                return c ? <CategoryLabel category={c} /> : option.label;
              }}
              allowDeselect={false}
            />
          </Group>
          {typed && preview && (
            <Text size="xs" c="dimmed">
              Matches {preview.count} uncategorised {preview.count === 1 ? "activity" : "activities"} now.
            </Text>
          )}
          {recategorising && (
            <Checkbox
              size="xs"
              label={`Move the ${rule.activityCount} ${rule.activityCount === 1 ? "activity" : "activities"} it set to the new category`}
              checked={moveSet}
              onChange={(e) => setMoveSet(e.currentTarget.checked)}
            />
          )}
          <Group gap="xs">
            <Button
              size="compact-xs"
              type="submit"
              loading={save.isPending}
              disabled={!pattern.trim() || categoryId === undefined}
            >
              {rule ? "Save" : "Add"}
            </Button>
            <Button size="compact-xs" variant="default" onClick={onCancel}>
              Cancel
            </Button>
          </Group>
          {save.error && <ErrorView error={save.error} />}
        </Stack>
      </form>
    </Paper>
  );
}
