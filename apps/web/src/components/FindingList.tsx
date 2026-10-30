import { Badge, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { api, type Card, type Finding, type LogicalCard, ok } from "../api.ts";
import { suggestExplanation } from "../lib/explanations.ts";
import { FINDING_KIND_LABELS, formatDate, formatMoney, lastFour } from "../lib/format.ts";
import { activityQuery } from "../queries.ts";
import { type AdjustmentDraft, AdjustmentModal } from "./Adjustments.tsx";
import { draftFromSuggestion, type FeeScheduleDraft, FeeScheduleModal } from "./FeeSchedules.tsx";
import { AnchorLink } from "./links.tsx";

/**
 * A logical card's reconciliation findings, each with when it was seen and the user's explanation. A balance gap
 * can be closed by recording the adjustment that explains it. A finding is about one physical card, since 2fiat
 * reports balances per physical card: it names the physical one when the logical card has several.
 */
export function FindingList({
  accountId,
  findings,
  cards,
  logicalCards,
  readOnly = false,
}: {
  accountId: string;
  findings: Finding[];
  cards: Card[];
  logicalCards: LogicalCard[];
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
  readOnly,
}: {
  accountId: string;
  finding: Finding;
  card: Card | undefined;
  logical: LogicalCard | undefined;
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
  // A fee above the advert can be accepted as 2fiat's practice: then only a change in what it charges is a finding.
  const feeKind =
    finding.kind === "fees-above-advertised"
      ? "transaction"
      : finding.kind === "topup-fee-above-advertised"
        ? "topup"
        : undefined;
  const canAccept = !readOnly && !resolved && feeKind && card;
  const [feeDraft, setFeeDraft] = useState<FeeScheduleDraft | null>(null);
  const accept = useMutation({
    mutationFn: (query: { cardId: string; kind: "topup" | "transaction" }) =>
      ok(api.accounts[":accountId"]["fee-schedules"].suggestion.$get({ param: { accountId }, query })),
    onSuccess: (suggestion) => setFeeDraft(draftFromSuggestion(suggestion, finding.id)),
  });
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
            {card && logical && logical.cardIds.length > 1 && (
              <Text size="xs" c="dimmed">
                on ·· {lastFour(card.maskedNumber)}
              </Text>
            )}
          </Group>
          {finding.cents !== null && card && (
            <Text fw={600} size="sm" style={{ whiteSpace: "nowrap" }}>
              {formatMoney(finding.cents, { signed: true })}
            </Text>
          )}
        </Group>
        <Text size="sm">{finding.message}</Text>
        <Text size="xs" c="dimmed">
          First seen {formatDate(finding.firstSeenAt)}
          {resolved
            ? `, resolved ${formatDate(finding.resolvedAt)}`
            : `, last seen ${formatDate(finding.lastSeenAt)}`}
          {finding.activityIds.length > 0 && logical && (
            <>
              {" · "}
              <AnchorLink
                to="/a/$accountId/c/$logicalCardId/activity"
                params={{ accountId, logicalCardId: String(logical.id) }}
                search={{ finding: finding.id }}
                size="xs"
              >
                {finding.activityIds.length} {finding.activityIds.length === 1 ? "activity" : "activities"}
              </AnchorLink>
            </>
          )}
        </Text>
        <Explanation
          accountId={accountId}
          finding={finding}
          action={
            <>
              {canAdjust && (
                <Button size="compact-xs" variant="light" onClick={() => openAdjustment(suggested.draft)}>
                  {suggested.label}
                </Button>
              )}
              {canAccept && (
                <Button
                  size="compact-xs"
                  variant="light"
                  loading={accept.isPending}
                  onClick={() => accept.mutate({ cardId: String(card.id), kind: feeKind })}
                >
                  Accept as 2fiat's practice
                </Button>
              )}
            </>
          }
        />
        {accept.error && (
          <Text c="red" size="sm">
            {accept.error.message}
          </Text>
        )}
        {canAccept && (
          <FeeScheduleModal accountId={accountId} draft={feeDraft} onClose={() => setFeeDraft(null)} />
        )}
        {canAdjust && (
          <AdjustmentModal
            accountId={accountId}
            cards={[card]}
            draft={adjustment && { ...adjustment, cardId: card.id }}
            onClose={() => setAdjustment(null)}
          />
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

/** The user's note on why a finding is fine, edited in place. `action` shares the line of its buttons. */
function Explanation({
  accountId,
  finding,
  action,
}: {
  accountId: string;
  finding: Finding;
  action?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  // A suggestion opens selected, so typing replaces it and an arrow key or a click keeps it to amend.
  const selectSuggestion = useRef(false);
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
            ref={(box) => {
              if (box && selectSuggestion.current) {
                selectSuggestion.current = false;
                box.select();
              }
            }}
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
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          // Starts from a likely reason, where there is one; the user edits it before saving.
          onClick={() => {
            const suggestion = suggestExplanation(finding);
            selectSuggestion.current = suggestion !== undefined;
            setDraft(suggestion ?? "");
          }}
        >
          Add an explanation
        </Button>
        {action}
      </Group>
    );
  }
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <Text size="sm" fs="italic" style={{ flex: 1, whiteSpace: "pre-wrap" }}>
        {finding.explanation}
      </Text>
      {action}
      <Button size="compact-xs" variant="light" onClick={() => setDraft(finding.explanation ?? "")}>
        Edit
      </Button>
      <Button
        size="compact-xs"
        variant="light"
        color="red"
        loading={save.isPending}
        onClick={() => save.mutate(null)}
      >
        Remove
      </Button>
    </Group>
  );
}
