import { Tooltip } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Money } from "../lib/fx.ts";
import { fxQuery } from "../queries.ts";

/** Money in the user's display currency. The shell loads the rates, so this never suspends inside a page. */
export function useMoney(): Money {
  const { data } = useSuspenseQuery(fxQuery);
  return useMemo(() => new Money(data.currency, data.rates), [data]);
}

/**
 * USD cents in the display currency, with the dollars and rate on hover. `at` is when the money moved (it converts
 * at that day's rate); null is a balance now (the latest rate).
 */
export function Amount({
  cents,
  at,
  signed = false,
}: {
  cents: number;
  at: string | null;
  signed?: boolean;
}) {
  const money = useMoney();
  const converted = money.convert(cents, at);
  const text = money.format(converted.cents, { signed });
  const origin = money.describe(converted, { signed });
  if (!origin) return text;
  return (
    <Tooltip label={origin}>
      <span>{text}</span>
    </Tooltip>
  );
}
