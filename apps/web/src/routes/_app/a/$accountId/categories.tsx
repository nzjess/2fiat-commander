import { Divider, Stack, Text, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { CategoryManager } from "../../../../components/Categories.tsx";
import { RuleManager } from "../../../../components/Rules.tsx";
import { categoriesQuery, rulesQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/categories")({
  loader: ({ context: { queryClient }, params: { accountId } }) =>
    Promise.all([
      queryClient.ensureQueryData(categoriesQuery(accountId)),
      queryClient.ensureQueryData(rulesQuery(accountId)),
    ]),
  component: CategoriesPage,
});

/** The account's own categories and rules. No other account shares them. */
function CategoriesPage() {
  const { accountId } = Route.useParams();
  return (
    <Stack maw={560}>
      <Title order={2}>Categories</Title>
      <Text size="sm" c="dimmed">
        What this account's spending went on: purchases take a category, and refunds count back against
        theirs. These categories belong to this account only.
      </Text>
      <CategoryManager accountId={accountId} />
      <Divider my="sm" />
      <Title order={4}>Rules</Title>
      <Text size="sm" c="dimmed">
        Rules set a category on new purchases and refunds at each sync, the first matching rule winning. They
        never change a category already set, and apply to existing activities only when you ask.
      </Text>
      <RuleManager accountId={accountId} />
    </Stack>
  );
}
