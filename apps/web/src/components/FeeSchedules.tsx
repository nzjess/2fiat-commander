import { Alert, Button, Group, Modal, Stack, Table, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CardFees, type FeeSchedule, type FeeSuggestion, ok, send } from "../api.ts";
import {
  formatDate,
  formatMoney,
  formatRate,
  isoToLocalDate,
  localDayStart,
  toBps,
  toCents,
} from "../lib/format.ts";
import { feeSchedulesQuery, feesQuery } from "../queries.ts";

type FeeKind = FeeSchedule["kind"];

/** What the form starts with: a schedule to edit, or 2fiat's observed fees to accept. */
export interface FeeScheduleDraft {
  id?: number;
  product: string;
  kind: FeeKind;
  effectiveFrom: string;
  rateBps?: number | null;
  authorizationFeeCents?: number | null;
  postingFeeCents?: number | null;
  note?: string;
  /** A new schedule's note also explains this finding. */
  findingId?: number;
}

/** A schedule's values in one line, e.g. "6.5% per top-up". */
export function describeSchedule(
  s: Pick<FeeScheduleDraft, "kind" | "rateBps" | "authorizationFeeCents" | "postingFeeCents">,
) {
  return s.kind === "topup"
    ? `${formatRate(s.rateBps ?? 0)} per top-up`
    : `${formatMoney(s.authorizationFeeCents ?? 0)} per authorisation, ${formatMoney(s.postingFeeCents ?? 0)} per posting`;
}

/** The form for accepting what 2fiat suggests it charges, as the explanation of a finding. */
export function draftFromSuggestion(suggestion: FeeSuggestion, findingId: number): FeeScheduleDraft {
  return {
    ...suggestion,
    findingId,
    note: `Accepted as 2fiat's practice: ${describeSchedule(suggestion)}.`,
  };
}

/**
 * Accepts, or edits, a fee schedule: what 2fiat actually charges for a card product, from a date on. Fees are then
 * checked against it rather than the advert. The server re-evaluates on save, so everything is refetched.
 */
export function FeeScheduleModal({
  accountId,
  draft,
  onClose,
}: {
  accountId: string;
  /** Opens the modal when set. */
  draft: FeeScheduleDraft | null;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={draft !== null}
      onClose={onClose}
      title={draft?.id === undefined ? "Accept 2fiat's fees" : "Edit accepted fees"}
    >
      {draft && <FeeScheduleForm accountId={accountId} draft={draft} onDone={onClose} />}
    </Modal>
  );
}

function FeeScheduleForm({
  accountId,
  draft,
  onDone,
}: {
  accountId: string;
  draft: FeeScheduleDraft;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const dollars = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));
  const [date, setDate] = useState(isoToLocalDate(draft.effectiveFrom));
  const [rate, setRate] = useState(draft.rateBps == null ? "" : String(draft.rateBps / 100));
  const [authorization, setAuthorization] = useState(dollars(draft.authorizationFeeCents));
  const [posting, setPosting] = useState(dollars(draft.postingFeeCents));
  const [note, setNote] = useState(draft.note ?? "");

  // An unchanged date keeps the exact start (e.g. the first fee's time); a new one starts at that local midnight.
  const effectiveFrom =
    date === isoToLocalDate(draft.effectiveFrom) ? draft.effectiveFrom : localDayStart(date);
  const rateBps = toBps(rate);
  const authorizationFeeCents = toCents(authorization);
  const postingFeeCents = toCents(posting);
  const values =
    draft.kind === "topup"
      ? rateBps === undefined
        ? undefined
        : { rateBps }
      : authorizationFeeCents === undefined ||
          postingFeeCents === undefined ||
          authorizationFeeCents < 0 ||
          postingFeeCents < 0
        ? undefined
        : { authorizationFeeCents, postingFeeCents };

  const endpoint = api.accounts[":accountId"]["fee-schedules"];
  const save = useMutation({
    mutationFn: async ({ from, text }: { from: string; text: string }) => {
      if (draft.id !== undefined) {
        return ok(
          endpoint[":scheduleId"].$patch({
            param: { accountId, scheduleId: String(draft.id) },
            json: { effectiveFrom: from, note: text, ...values },
          }),
        );
      }
      const common = { product: draft.product, effectiveFrom: from, note: text };
      const created = await ok(
        endpoint.$post({
          param: { accountId },
          json:
            draft.kind === "topup"
              ? { kind: "topup", ...common, rateBps: rateBps ?? 0 }
              : {
                  kind: "transaction",
                  ...common,
                  authorizationFeeCents: authorizationFeeCents ?? 0,
                  postingFeeCents: postingFeeCents ?? 0,
                },
        }),
      );
      // The finding this came from is explained by the same note, whether it resolves or not.
      if (draft.findingId !== undefined) {
        await ok(
          api.accounts[":accountId"].findings[":findingId"].$patch({
            param: { accountId, findingId: String(draft.findingId) },
            json: { explanation: text },
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
  const valid = values !== undefined && effectiveFrom !== undefined && note.trim() !== "";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ from: effectiveFrom, text: note.trim() });
      }}
    >
      <Stack>
        <Text size="sm" c="dimmed">
          What 2fiat actually charges on {draft.product} cards, even where its advert says otherwise. From
          this date, fees are checked against it instead: the known difference stops being a finding, but any
          change in what 2fiat charges, up or down, becomes one.
        </Text>
        {save.error && (
          <Alert color="red" variant="light">
            {save.error.message}
          </Alert>
        )}
        {draft.kind === "topup" ? (
          <TextInput
            label="Top-up fee"
            required
            autoFocus
            inputMode="decimal"
            rightSection={<Text size="sm">%</Text>}
            value={rate}
            onChange={(e) => setRate(e.currentTarget.value)}
            error={rate !== "" && rateBps === undefined ? "e.g. 6.5" : undefined}
          />
        ) : (
          <Group grow align="flex-start">
            <TextInput
              label="Per authorisation"
              description="Approved, reversed or declined"
              required
              autoFocus
              inputMode="decimal"
              leftSection={<Text size="sm">$</Text>}
              value={authorization}
              onChange={(e) => setAuthorization(e.currentTarget.value)}
              error={authorization !== "" && values === undefined ? "e.g. 0.50" : undefined}
            />
            <TextInput
              label="Per posting"
              description="When the final amount posts"
              required
              inputMode="decimal"
              leftSection={<Text size="sm">$</Text>}
              value={posting}
              onChange={(e) => setPosting(e.currentTarget.value)}
              error={posting !== "" && values === undefined ? "e.g. 0.50" : undefined}
            />
          </Group>
        )}
        <TextInput
          label="From"
          description="Starts at the first fee 2fiat charged, so the whole history is checked"
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

/** A kind of fee summed over a logical card's physical cards. */
function total(cards: CardFees[], kind: FeeKind) {
  const comparisons = cards.map((c) => (kind === "topup" ? c.topup : c.transaction));
  const advertised = comparisons.map((c) => c.advertisedCents);
  const accepted = comparisons.flatMap((c) => (c.accepted ? [c.accepted] : []));
  return {
    chargedCents: comparisons.reduce((s, c) => s + c.chargedCents, 0),
    advertisedCents: advertised.every((a) => a != null)
      ? advertised.reduce<number>((s, a) => s + (a ?? 0), 0)
      : undefined,
    accepted: accepted.length
      ? {
          since: accepted.map((a) => a.since).sort()[0] ?? "",
          chargedCents: accepted.reduce((s, a) => s + a.chargedCents, 0),
          expectedCents: accepted.reduce((s, a) => s + a.expectedCents, 0),
        }
      : undefined,
  };
}

/**
 * A logical card's fees: what 2fiat charged, what its advert says they'd be, and what the schedules accepted as its
 * practice say. With the schedules that apply, to edit or remove.
 */
export function FeesPanel({
  accountId,
  logicalCardId,
  readOnly,
}: {
  accountId: string;
  logicalCardId: number;
  readOnly: boolean;
}) {
  const { data: fees } = useSuspenseQuery(feesQuery(accountId, logicalCardId));
  const { data: allSchedules } = useSuspenseQuery(feeSchedulesQuery(accountId));
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FeeScheduleDraft | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) =>
      send(
        api.accounts[":accountId"]["fee-schedules"][":scheduleId"].$delete({
          param: { accountId, scheduleId: String(id) },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts", accountId] }),
  });

  const products = new Set(fees.cards.map((c) => c.product));
  const schedules = allSchedules.filter((s) => products.has(s.product));
  const rows: [string, ReturnType<typeof total>][] = [
    ["Transaction fees", total(fees.cards, "transaction")],
    ["Top-up fees", total(fees.cards, "topup")],
  ];
  const signed = (cents: number) => formatMoney(cents, { signed: true });

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        What 2fiat charged in fees, against what its advert says they'd be and the fees you accepted as its
        practice.
      </Text>
      <Table.ScrollContainer minWidth={640}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th />
              <Table.Th ta="right">Charged</Table.Th>
              <Table.Th ta="right">As advertised</Table.Th>
              <Table.Th ta="right">Above advertised</Table.Th>
              <Table.Th ta="right">As accepted</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map(([label, t]) => {
              const above = t.advertisedCents === undefined ? undefined : t.chargedCents - t.advertisedCents;
              const off = t.accepted && t.accepted.chargedCents - t.accepted.expectedCents;
              return (
                <Table.Tr key={label}>
                  <Table.Td>{label}</Table.Td>
                  <Table.Td ta="right">{formatMoney(t.chargedCents)}</Table.Td>
                  <Table.Td ta="right">
                    {t.advertisedCents === undefined ? "—" : formatMoney(t.advertisedCents)}
                  </Table.Td>
                  <Table.Td ta="right" c={above !== undefined && above > 0 ? "red.7" : undefined}>
                    {above === undefined ? "—" : signed(above)}
                  </Table.Td>
                  <Table.Td ta="right">
                    {t.accepted ? (
                      <Stack gap={0} align="flex-end">
                        <Text size="sm">{formatMoney(t.accepted.expectedCents)}</Text>
                        <Text size="xs" c="dimmed">
                          since {formatDate(t.accepted.since)}
                          {off ? `, charged ${signed(off)}` : ""}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        Not accepted
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Stack gap="xs">
        <Text fw={600} size="sm">
          Accepted fees
        </Text>
        {schedules.length === 0 ? (
          <Text size="sm" c="dimmed">
            None yet. Accept 2fiat's fees from a "fees above advertised" finding.
          </Text>
        ) : (
          schedules.map((s) => (
            <Group key={s.id} justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={0}>
                <Text size="sm">
                  {describeSchedule(s)} on {s.product} cards, from {formatDate(s.effectiveFrom)}
                </Text>
                <Text size="xs" c="dimmed" fs="italic">
                  {s.note}
                </Text>
              </Stack>
              {!readOnly && (
                <Group gap="xs" wrap="nowrap">
                  <Button size="compact-xs" variant="light" onClick={() => setDraft(s)}>
                    Edit
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="red"
                    loading={remove.isPending && remove.variables === s.id}
                    onClick={() => remove.mutate(s.id)}
                  >
                    Remove
                  </Button>
                </Group>
              )}
            </Group>
          ))
        )}
        {remove.error && (
          <Text c="red" size="sm">
            {remove.error.message}
          </Text>
        )}
      </Stack>
      <FeeScheduleModal accountId={accountId} draft={draft} onClose={() => setDraft(null)} />
    </Stack>
  );
}
