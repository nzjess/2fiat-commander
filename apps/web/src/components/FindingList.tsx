import { Badge, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Card, type Finding, ok } from "../api.ts";
import { cardLabel, FINDING_KIND_LABELS, formatDate, formatMoney } from "../lib/format.ts";
import { AnchorLink } from "./links.tsx";

/** Reconciliation findings, each with its card, when it was seen, and the user's explanation. */
export function FindingList({
  accountId,
  findings,
  cards,
  showCard = true,
}: {
  accountId: string;
  findings: Finding[];
  cards: Card[];
  showCard?: boolean;
}) {
  if (findings.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No findings.
      </Text>
    );
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  return (
    <Stack gap="sm">
      {findings.map((f) => (
        <FindingItem
          key={f.id}
          accountId={accountId}
          finding={f}
          card={byId.get(f.cardId)}
          showCard={showCard}
        />
      ))}
    </Stack>
  );
}

function FindingItem({
  accountId,
  finding,
  card,
  showCard,
}: {
  accountId: string;
  finding: Finding;
  card: Card | undefined;
  showCard: boolean;
}) {
  const resolved = finding.resolvedAt !== null;
  return (
    <Paper withBorder p="sm" radius="md" opacity={resolved ? 0.75 : 1}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="xs">
            <Badge color={resolved ? "gray" : "orange"} variant="light">
              {FINDING_KIND_LABELS[finding.kind] ?? finding.kind}
            </Badge>
            {resolved && (
              <Badge color="green" variant="outline">
                Resolved
              </Badge>
            )}
            {finding.explanation !== null && (
              <Badge color="blue" variant="outline">
                Explained
              </Badge>
            )}
            {showCard && card && (
              <AnchorLink
                to="/a/$accountId/cards/$cardId"
                params={{ accountId, cardId: String(card.id) }}
                size="sm"
              >
                {cardLabel(card)}
              </AnchorLink>
            )}
          </Group>
          {finding.cents !== null && card && (
            <Text fw={600} size="sm" style={{ whiteSpace: "nowrap" }}>
              {formatMoney(finding.cents, card.currency, { signed: true })}
            </Text>
          )}
        </Group>
        <Text size="sm">{finding.message}</Text>
        <Text size="xs" c="dimmed">
          First seen {formatDate(finding.firstSeenAt)}
          {resolved
            ? `, resolved ${formatDate(finding.resolvedAt)}`
            : `, last seen ${formatDate(finding.lastSeenAt)}`}
          {finding.activityIds.length > 0 &&
            ` · ${finding.activityIds.length} ${finding.activityIds.length === 1 ? "activity" : "activities"}`}
        </Text>
        <Explanation accountId={accountId} finding={finding} />
      </Stack>
    </Paper>
  );
}

/** The user's note on why a finding is fine, edited in place. */
function Explanation({ accountId, finding }: { accountId: string; finding: Finding }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (explanation: string | null) =>
      ok(
        api.accounts[":accountId"].findings[":findingId"].$patch({
          param: { accountId, findingId: String(finding.id) },
          json: { explanation },
        }),
      ),
    onSuccess: () => {
      setDraft(null);
      return queryClient.invalidateQueries({ queryKey: ["accounts", accountId, "findings"] });
    },
  });

  if (draft !== null) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft.trim() || null);
        }}
      >
        <Stack gap={6}>
          <Textarea
            autoFocus
            autosize
            minRows={2}
            maxLength={2000}
            placeholder="Why this is expected, e.g. a refund 2fiat never recorded"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            error={save.error?.message}
          />
          <Group gap="xs">
            <Button size="xs" type="submit" loading={save.isPending}>
              Save
            </Button>
            <Button size="xs" variant="default" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </form>
    );
  }
  if (finding.explanation === null) {
    return (
      <Group>
        <Button size="compact-xs" variant="subtle" onClick={() => setDraft("")}>
          Explain
        </Button>
      </Group>
    );
  }
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <Text size="sm" fs="italic" style={{ flex: 1, whiteSpace: "pre-wrap" }}>
        {finding.explanation}
      </Text>
      <Button size="compact-xs" variant="subtle" onClick={() => setDraft(finding.explanation ?? "")}>
        Edit
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        loading={save.isPending}
        onClick={() => save.mutate(null)}
      >
        Remove
      </Button>
    </Group>
  );
}
