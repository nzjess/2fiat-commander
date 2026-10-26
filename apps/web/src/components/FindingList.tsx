import { Badge, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Card, type Finding, type LogicalCard, ok } from "../api.ts";
import { FINDING_KIND_LABELS, formatDate, formatMoney, lastFour } from "../lib/format.ts";
import { activityQuery } from "../queries.ts";
import { type AdjustmentDraft, AdjustmentModal } from "./Adjustments.tsx";
import { AnchorLink } from "./links.tsx";

/**
 * Reconciliation findings, each with its card, when it was seen, and the user's explanation. A balance gap can be
 * closed by recording the adjustment that explains it. A finding is about one physical card, since 2fiat reports
 * balances per physical card: it shows under its logical card, naming the physical one when there are several.
 */
export function FindingList({
  accountId,
  findings,
  cards,
  logicalCards,
  showCard = true,
  readOnly = false,
}: {
  accountId: string;
  findings: Finding[];
  cards: Card[];
  logicalCards: LogicalCard[];
  /** Name the logical card on each finding (off on a logical card's own page). */
  showCard?: boolean;
  readOnly?: boolean;
}) {
  if (findings.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No findings.
      </Text>
    );
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  const logicalById = new Map(logicalCards.map((l) => [l.id, l]));
  return (
    <Stack gap="sm">
      {findings.map((f) => (
        <FindingItem
          key={f.id}
          accountId={accountId}
          finding={f}
          card={byId.get(f.cardId)}
          logical={logicalById.get(byId.get(f.cardId)?.logicalCardId ?? 0)}
          showCard={showCard}
          readOnly={readOnly}
        />
      ))}
    </Stack>
  );
}

function FindingItem({
  accountId,
  finding,
  card,
  logical,
  showCard,
  readOnly,
}: {
  accountId: string;
  finding: Finding;
  card: Card | undefined;
  logical: LogicalCard | undefined;
  showCard: boolean;
  readOnly: boolean;
}) {
  const resolved = finding.resolvedAt !== null;
  const [adjustment, setAdjustment] = useState<AdjustmentDraft | null>(null);
  const queryClient = useQueryClient();
  // A top-up's missing credit starts on the order's date; if the top-up can't be fetched, on today's.
  const openAdjustment = async (draft: AdjustmentDraft) => {
    if (draft.topupActivityId === undefined) return setAdjustment(draft);
    const topup = await queryClient
      .fetchQuery(activityQuery(accountId, draft.topupActivityId))
      .catch(() => undefined);
    setAdjustment({ ...draft, occurredAt: topup?.occurredAt });
  };
  // A gap, or a top-up's missing credit, can be made good with an adjustment: the money 2fiat moved with no row.
  const suggested = adjustmentFor(finding);
  const canAdjust = !readOnly && !resolved && suggested && card;
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
            {showCard && logical && (
              <AnchorLink
                to="/a/$accountId/cards/$logicalCardId"
                params={{ accountId, logicalCardId: String(logical.id) }}
                size="sm"
              >
                {logical.name}
              </AnchorLink>
            )}
            {card && logical && logical.cardIds.length > 1 && (
              <Text size="xs" c="dimmed">
                on ·· {lastFour(card.maskedNumber)}
              </Text>
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
        {canAdjust && (
          <>
            <Group>
              <Button size="compact-xs" variant="subtle" onClick={() => openAdjustment(suggested.draft)}>
                {suggested.label}
              </Button>
            </Group>
            <AdjustmentModal
              accountId={accountId}
              cards={[card]}
              draft={adjustment && { ...adjustment, cardId: card.id }}
              onClose={() => setAdjustment(null)}
            />
          </>
        )}
      </Stack>
    </Paper>
  );
}

/** The adjustment that would make good a finding, if one can: a gap's amount, or a top-up's missing credit. */
function adjustmentFor(finding: Finding): { label: string; draft: AdjustmentDraft } | undefined {
  if (finding.cents === null) return undefined;
  if (finding.kind === "balance-gap") {
    return { label: "Record an adjustment", draft: { cents: finding.cents, findingId: finding.id } };
  }
  const topupActivityId = finding.activityIds[0];
  if (finding.kind === "credit-shortfall" && topupActivityId !== undefined) {
    return {
      label: "Record the missing credit",
      draft: { cents: -finding.cents, topupActivityId, findingId: finding.id },
    };
  }
  return undefined;
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
