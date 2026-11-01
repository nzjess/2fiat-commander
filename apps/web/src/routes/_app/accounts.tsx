import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type Account, api, ok, send } from "../../api.ts";
import { AnchorLink } from "../../components/links.tsx";
import { accessLabel, accessOf } from "../../lib/access.ts";
import { formatDate, timeAgo } from "../../lib/format.ts";
import { accountsQuery } from "../../queries.ts";

export const Route = createFileRoute("/_app/accounts")({
  loader: ({ context }) => context.queryClient.ensureQueryData(accountsQuery),
  component: Accounts,
});

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; account: Account }
  | { kind: "replace"; account: Account }
  | { kind: "leave"; account: Account };

function Accounts() {
  const { data: accounts } = useSuspenseQuery(accountsQuery);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Accounts</Title>
        <Button onClick={() => setDialog({ kind: "add" })}>Add account</Button>
      </Group>
      <Text c="dimmed" size="sm">
        Each account is one 2fiat login link's token. Commander only ever reads from 2fiat.
      </Text>
      {accounts.length === 0 ? (
        <Text>No accounts yet. Add one with the token from your 2fiat login link.</Text>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Label</Table.Th>
                <Table.Th>Your role</Table.Th>
                <Table.Th>Added</Table.Th>
                <Table.Th>Last sync</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {accounts.map((a) => {
                const replacement =
                  a.replacedByAccountId === null ? undefined : byId.get(a.replacedByAccountId);
                const access = accessOf(a.access);
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Group gap="xs">
                        <AnchorLink to="/a/$accountId" params={{ accountId: String(a.id) }}>
                          {a.label}
                        </AnchorLink>
                        {a.archivedAt !== null && (
                          <Badge color="gray" variant="light">
                            Archived{replacement ? `, replaced by ${replacement.label}` : ""}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{accessLabel(a.access)}</Table.Td>
                    <Table.Td>{formatDate(a.createdAt)}</Table.Td>
                    <Table.Td>
                      {a.lastSync === null ? (
                        "Never"
                      ) : (
                        <Text size="sm" c={a.lastSync.status === "failed" ? "red" : undefined}>
                          {a.lastSync.status === "running"
                            ? "Running"
                            : `${a.lastSync.status === "failed" ? "Failed" : "OK"}, ${timeAgo(a.lastSync.startedAt)}`}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end" wrap="nowrap">
                        {access.can("account.rename") && (
                          <Button
                            size="compact-sm"
                            variant="light"
                            onClick={() => setDialog({ kind: "rename", account: a })}
                          >
                            Rename
                          </Button>
                        )}
                        {a.archivedAt === null && access.can("account.replace") && (
                          <Button
                            size="compact-sm"
                            variant="light"
                            color="orange"
                            onClick={() => setDialog({ kind: "replace", account: a })}
                          >
                            Replace token
                          </Button>
                        )}
                        <Button
                          size="compact-sm"
                          variant="light"
                          color="red"
                          onClick={() => setDialog({ kind: "leave", account: a })}
                        >
                          Leave
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Modal opened={dialog?.kind === "add"} onClose={close} title="Add a 2fiat account">
        {dialog?.kind === "add" && <AddAccount onDone={close} />}
      </Modal>
      <Modal opened={dialog?.kind === "rename"} onClose={close} title="Rename account">
        {dialog?.kind === "rename" && <RenameAccount account={dialog.account} onDone={close} />}
      </Modal>
      <Modal opened={dialog?.kind === "replace"} onClose={close} title="Replace the account's token">
        {dialog?.kind === "replace" && <ReplaceToken account={dialog.account} onDone={close} />}
      </Modal>
      <Modal opened={dialog?.kind === "leave"} onClose={close} title="Leave this account">
        {dialog?.kind === "leave" && <LeaveAccount account={dialog.account} onDone={close} />}
      </Modal>
    </Stack>
  );
}

function LeaveAccount({ account, onDone }: { account: Account; onDone: () => void }) {
  const queryClient = useQueryClient();
  const leave = useMutation({
    mutationFn: () =>
      send(api.accounts[":accountId"].grants.mine.$delete({ param: { accountId: String(account.id) } })),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["accounts", String(account.id)] });
      await queryClient.invalidateQueries({ queryKey: ["accounts", "list"] });
      onDone();
    },
  });
  return (
    <Stack>
      <Text size="sm">
        You'll lose all access to <b>{account.label}</b> and its cards, until an owner adds you again.
      </Text>
      {leave.error && (
        <Alert color="red" variant="light">
          {leave.error.message}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          Cancel
        </Button>
        <Button color="red" loading={leave.isPending} onClick={() => leave.mutate()}>
          Leave
        </Button>
      </Group>
    </Stack>
  );
}

function TokenInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <PasswordInput
      label="Token"
      description="The token1… part of your 2fiat login link. It's stored encrypted and never shown again."
      required
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

function AddAccount({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const add = useMutation({
    mutationFn: () => ok(api.accounts.$post({ json: { label, token } })),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ["accounts", "list"] });
      onDone();
      void navigate({ to: "/a/$accountId", params: { accountId: String(account.id) } });
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <Stack>
        {add.error && (
          <Alert color="red" variant="light">
            {add.error.message}
          </Alert>
        )}
        <TextInput
          label="Label"
          required
          autoFocus
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <TokenInput value={token} onChange={setToken} />
        <Text size="xs" c="dimmed">
          Commander checks the token with 2fiat. Sync the account afterwards to fetch its cards.
        </Text>
        <Group justify="flex-end">
          <Button type="submit" loading={add.isPending}>
            Add
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function RenameAccount({ account, onDone }: { account: Account; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(account.label);
  const rename = useMutation({
    mutationFn: () =>
      ok(api.accounts[":accountId"].$patch({ param: { accountId: String(account.id) }, json: { label } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      onDone();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        rename.mutate();
      }}
    >
      <Stack>
        <TextInput
          label="Label"
          required
          autoFocus
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          error={rename.error?.message}
        />
        <Group justify="flex-end">
          <Button type="submit" loading={rename.isPending}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function ReplaceToken({ account, onDone }: { account: Account; onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [label, setLabel] = useState(account.label);
  const [token, setToken] = useState("");
  const replace = useMutation({
    mutationFn: () =>
      ok(
        api.accounts[":accountId"].replacement.$post({
          param: { accountId: String(account.id) },
          json: { label, token },
        }),
      ),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      onDone();
      void navigate({ to: "/a/$accountId", params: { accountId: String(created.id) } });
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        replace.mutate();
      }}
    >
      <Stack>
        <Text size="sm">
          Use this when 2fiat has issued a new token for <b>{account.label}</b>. The new token becomes a new
          account with its own cards. <b>{account.label}</b> is archived: it stops syncing, but its history
          stays viewable.
        </Text>
        {replace.error && (
          <Alert color="red" variant="light">
            {replace.error.message}
          </Alert>
        )}
        <TextInput
          label="Label for the new account"
          required
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <TokenInput value={token} onChange={setToken} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" color="orange" loading={replace.isPending}>
            Archive and replace
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
