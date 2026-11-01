import { Divider, Stack, Text, Title } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CategoryLabel, CategoryManager } from "../../../../components/Categories.tsx";
import { RuleManager, ruleCondition } from "../../../../components/Rules.tsx";
import { useAccess } from "../../../../components/useAccess.ts";
import { accessOf } from "../../../../lib/access.ts";
import { accountQuery, categoriesQuery, rulesQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/categories")({
  loader: async ({ context: { queryClient }, params: { accountId } }) => {
    const account = await queryClient.ensureQueryData(accountQuery(accountId));
    if (!accessOf(account.access).can("account.view")) return;
    await Promise.all([
      queryClient.ensureQueryData(categoriesQuery(accountId)),
      queryClient.ensureQueryData(rulesQuery(accountId)),
    ]);
  },
  component: CategoriesPage,
});

/** The account's own categories and rules. No other account shares them. */
function CategoriesPage() {
  const { accountId } = Route.useParams();
  const access = useAccess(accountId);
  if (!access.can("account.view")) {
    return <Text c="dimmed">Only someone with a role on the whole account can see this page.</Text>;
  }
  const manage = access.can("categories.manage");
  return (
    <Stack maw={560}>
      <Title order={2}>Categories</Title>
      <Text size="sm" c="dimmed">
        What this account's spending went on: purchases take a category, and refunds count back against
        theirs. These categories belong to this account only.
      </Text>
      {manage ? <CategoryManager accountId={accountId} /> : <CategoryList accountId={accountId} />}
      <Divider my="sm" />
      <Title order={4}>Rules</Title>
      <Text size="sm" c="dimmed">
        Rules set a category on new purchases and refunds at each sync, the first matching rule winning. They
        never change a category already set, and apply to existing activities only when you ask.
      </Text>
      {manage ? <RuleManager accountId={accountId} /> : <RuleList accountId={accountId} />}
    </Stack>
  );
}

/** For someone who can see the account's categories, but not change them. */
function CategoryList({ accountId }: { accountId: string }) {
  const { data: categories } = useSuspenseQuery(categoriesQuery(accountId));
  if (categories.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No categories yet.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {categories.map((c) => (
        <CategoryLabel key={c.id} category={c} />
      ))}
    </Stack>
  );
}

function RuleList({ accountId }: { accountId: string }) {
  const { data: rules } = useSuspenseQuery(rulesQuery(accountId));
  const { data: categories } = useSuspenseQuery(categoriesQuery(accountId));
  if (rules.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No rules yet.
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {rules.map((r) => (
        <Text key={r.id} size="sm">
          {ruleCondition(r)}: {categories.find((c) => c.id === r.categoryId)?.name}
        </Text>
      ))}
    </Stack>
  );
}
