import { Divider, Select, Stack, Text, Title } from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api, ok } from "../../api.ts";
import { CategoryManager } from "../../components/Categories.tsx";
import { ErrorView } from "../../components/status.tsx";
import { formatDate } from "../../lib/format.ts";
import { categoriesQuery, fxQuery, meQuery } from "../../queries.ts";

export const Route = createFileRoute("/_app/settings")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(fxQuery),
      context.queryClient.ensureQueryData(categoriesQuery),
    ]),
  component: Settings,
});

const currencyNames = new Intl.DisplayNames("en", { type: "currency" });

/** The user's own settings: the currency amounts are shown in, and their categories. */
function Settings() {
  const { data: fx } = useSuspenseQuery(fxQuery);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (displayCurrency: (typeof fx.currencies)[number]) =>
      ok(api.auth.me.$patch({ json: { displayCurrency } })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, me);
      return queryClient.invalidateQueries({ queryKey: fxQuery.queryKey });
    },
  });

  return (
    <Stack maw={560}>
      <Title order={2}>Settings</Title>
      <Select
        label="Display currency"
        description="2fiat works in US dollars. Amounts can be shown in your own currency instead."
        data={fx.currencies.map((c) => ({ value: c, label: `${c}: ${currencyNames.of(c) ?? c}` }))}
        value={fx.currency}
        allowDeselect={false}
        disabled={save.isPending}
        onChange={(c) => {
          const currency = fx.currencies.find((x) => x === c);
          if (currency) save.mutate(currency);
        }}
      />
      {save.error && <ErrorView error={save.error} />}
      <Text size="sm" c="dimmed">
        Activities convert at the rate of the day they happened (a purchase's authorisation, not its posting),
        and balances at the latest rate. The rates are the European Central Bank's daily reference rates. Your
        card network converted foreign purchases at its own rate and margin, and 2fiat reports only the
        dollars, so a converted amount won't exactly match a receipt. Findings, fees, adjustments and the
        balance check stay in US dollars, as 2fiat reports them.
      </Text>
      <Text size="sm" c="dimmed">
        {fx.latestDay
          ? `Latest rates: ${formatDate(`${fx.latestDay}T12:00:00Z`)}.`
          : "No exchange rates have been fetched yet, so amounts show in US dollars."}
      </Text>
      <Divider my="sm" />
      <Title order={4}>Categories</Title>
      <Text size="sm" c="dimmed">
        What your spending went on: purchases take a category, and refunds count back against theirs. Your
        categories are shared by all your accounts.
      </Text>
      <CategoryManager />
    </Stack>
  );
}
