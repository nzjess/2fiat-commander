import { Alert, Button, Group, Modal, Select, Stack, Table, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Adjustment, api, type Card, ok, send } from "../api.ts";
import {
  cardLabel,
  formatDate,
  formatMoney,
  isoToLocalDate,
  localDateToIso,
  toCents,
} from "../lib/format.ts";
import { adjustmentsQuery } from "../queries.ts";

/** What the form starts with: an adjustment to edit, or a suggestion such as a gap's amount. */
export interface AdjustmentDraft {
  id?: number;
  /** The physical card the money moved on: fixed when set, else the user picks (the current card first). */
  cardId?: number;
  cents?: number;
  occurredAt?: string;
  note?: string;
  /** A new adjustment completes this top-up's order. */
  topupActivityId?: number;
  /** A new adjustment's note also explains this finding. */
  findingId?: number;
}

/**
 * Records money 2fiat moved without a row (e.g. a balance support credited by hand). The server re-evaluates on
 * save, so everything about the account is refetched.
 */
export function AdjustmentModal({
  accountId,
  cards,
  draft,
  onClose,
}: {
  accountId: string;
  /** The physical cards it can be on, the current one first. */
  cards: Card[];
  /** Opens the modal when set. */
  draft: AdjustmentDraft | null;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={draft !== null}
      onClose={onClose}
      title={draft?.id === undefined ? "Record an adjustment" : "Edit adjustment"}
    >
      {draft && <AdjustmentForm accountId={accountId} cards={cards} draft={draft} onDone={onClose} />}
    </Modal>
  );
}

function AdjustmentForm({
  accountId,
  cards,
  draft,
  onDone,
}: {
  accountId: string;
  cards: Card[];
  draft: AdjustmentDraft;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [cardId, setCardId] = useState(draft.cardId ?? cards[0]?.id);
  const card = cards.find((c) => c.id === cardId);
  // Only a new adjustment, not tied to a finding, can choose its card.
  const chooseCard = draft.id === undefined && draft.cardId === undefined && cards.length > 1;
  const [amount, setAmount] = useState(draft.cents === undefined ? "" : (draft.cents / 100).toFixed(2));
  const [date, setDate] = useState(isoToLocalDate(draft.occurredAt ?? new Date().toISOString()));
  const [note, setNote] = useState(draft.note ?? "");
  const cents = toCents(amount);
  const occurredAt = localDateToIso(date);
  const endpoint = api.accounts[":accountId"].adjustments;
  const save = useMutation({
    mutationFn: async (json: { cents: number; occurredAt: string; note: string }) => {
      if (draft.id !== undefined) {
        return ok(
          endpoint[":adjustmentId"].$patch({ param: { accountId, adjustmentId: String(draft.id) }, json }),
        );
      }
      const created = await ok(
        endpoint.$post({
          param: { accountId },
          json: { cardId: cardId ?? 0, topupActivityId: draft.topupActivityId, ...json },
        }),
      );
      // The finding this came from is explained by the same note, even once the adjustment resolves it.
      if (draft.findingId !== undefined) {
        await ok(
          api.accounts[":accountId"].findings[":findingId"].$patch({
            param: { accountId, findingId: String(draft.findingId) },
            json: { explanation: json.note },
          }),
        );
      }
      return created;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["accounts", accountId] });
      onDone();
    },
  });
  const valid =
    card !== undefined &&
    cents !== undefined &&
    cents !== 0 &&
    occurredAt !== undefined &&
    note.trim() !== "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ cents, occurredAt, note: note.trim() });
      }}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          For money 2fiat moved without a row to show for it, such as a balance support credited by hand. It
          counts in the ledger like any activity, marked as yours.
        </Text>
        {draft.topupActivityId !== undefined && (
          <Text size="sm">It completes the short top-up, so the top-up counts as fully credited.</Text>
        )}
        {save.error && (
          <Alert color="red" variant="light">
            {save.error.message}
          </Alert>
        )}
        {chooseCard ? (
          <Select
            label="Card"
            description="The physical card the money moved on"
            data={cards.map((c) => ({ value: String(c.id), label: cardLabel(c) }))}
            value={cardId === undefined ? null : String(cardId)}
            allowDeselect={false}
            onChange={(v) => v && setCardId(Number(v))}
          />
        ) : (
          card &&
          cards.length > 1 && (
            <Text size="sm">
              On <b>{cardLabel(card)}</b>
            </Text>
          )
        )}
        <TextInput
          label="Amount"
          description="Positive for money added to the card, negative for money taken from it"
          required
          autoFocus
          inputMode="decimal"
          leftSection={<Text size="sm">$</Text>}
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          error={amount !== "" && (cents === undefined || cents === 0) ? "e.g. 499.99 or -12.00" : undefined}
        />
        <TextInput
          label="Date"
          description="When the money moved"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
        />
        <Textarea
          label="Note"
          required
          autosize
          minRows={2}
          maxLength={2000}
          placeholder="e.g. Support credited the top-up my wallet underpaid"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={save.isPending}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * A logical card's adjustments, oldest first, with editing unless the account is archived. Each is on one of its
 * physical cards, named when it has more than one.
 */
export function AdjustmentList({
  accountId,
  logicalCardId,
  cards,
  readOnly,
}: {
  accountId: string;
  logicalCardId: number;
  /** Its physical cards, the current one first. */
  cards: Card[];
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: adjustments } = useSuspenseQuery(adjustmentsQuery(accountId, logicalCardId));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const [draft, setDraft] = useState<AdjustmentDraft | null>(null);
  const remove = useMutation({
    mutationFn: (a: Adjustment) =>
      send(
        api.accounts[":accountId"].adjustments[":adjustmentId"].$delete({
          param: { accountId, adjustmentId: String(a.id) },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts", accountId] }),
  });

  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Money 2fiat moved with no row to show for it, as you recorded it. These count in the ledger.
      </Text>
      {adjustments.length > 0 && (
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing={4} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th ta="right">Amount</Table.Th>
                <Table.Th>Note</Table.Th>
                {cards.length > 1 && <Table.Th>Card</Table.Th>}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {adjustments.map((a) => {
                const card = byId.get(a.cardId);
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>{formatDate(a.occurredAt)}</Table.Td>
                    <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
                      {formatMoney(a.cents, { signed: true })}
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "pre-wrap" }}>
                      {a.note}
                      {a.order && (
                        <Text size="xs" c="dimmed">
                          Completes the top-up of {formatDate(a.order.createdAt)}
                        </Text>
                      )}
                    </Table.Td>
                    {cards.length > 1 && (
                      <Table.Td style={{ whiteSpace: "nowrap" }}>{card ? cardLabel(card) : ""}</Table.Td>
                    )}
                    <Table.Td>
                      {!readOnly && (
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Button size="compact-xs" variant="light" onClick={() => setDraft(a)}>
                            Edit
                          </Button>
                          <Button
                            size="compact-xs"
                            variant="light"
                            color="red"
                            loading={remove.isPending && remove.variables?.id === a.id}
                            onClick={() => remove.mutate(a)}
                          >
                            Delete
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {remove.error && (
        <Text c="red" size="sm">
          {remove.error.message}
        </Text>
      )}
      {!readOnly && (
        <Group>
          <Button size="xs" variant="light" onClick={() => setDraft({})}>
            Record an adjustment
          </Button>
        </Group>
      )}
      <AdjustmentModal accountId={accountId} cards={cards} draft={draft} onClose={() => setDraft(null)} />
    </Stack>
  );
}
