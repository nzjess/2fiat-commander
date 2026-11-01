import { Alert, Button, Group, Paper, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Grant, ok, send } from "../../../../api.ts";
import { useAccess } from "../../../../components/useAccess.ts";
import { accessOf, type Role, roleLabel, roleOptions } from "../../../../lib/access.ts";
import { accountQuery, grantsQuery, logicalCardsQuery, meQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/members")({
  loader: async ({ context: { queryClient }, params: { accountId } }) => {
    const account = await queryClient.ensureQueryData(accountQuery(accountId));
    if (!accessOf(account.access).can("grants.manage")) return;
    await Promise.all([
      queryClient.ensureQueryData(grantsQuery(accountId)),
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
    ]);
  },
  component: MembersPage,
});

const grantsApi = api.accounts[":accountId"].grants;

function MembersPage() {
  const { accountId } = Route.useParams();
  const access = useAccess(accountId);
  return (
    <Stack maw={720}>
      <Title order={2}>Members</Title>
      {access.can("grants.manage") ? (
        <Members accountId={accountId} />
      ) : (
        <Text c="dimmed">Only this account's owners can manage its members.</Text>
      )}
    </Stack>
  );
}

function Members({ accountId }: { accountId: string }) {
  const { data: grants } = useSuspenseQuery(grantsQuery(accountId));
  const { data: logicalCards } = useSuspenseQuery(logicalCardsQuery(accountId));
  const whole = grants.filter((g) => g.logicalCardId === null);
  const cards = logicalCards
    .map((card) => ({ card, grants: grants.filter((g) => g.logicalCardId === card.id) }))
    .filter((c) => c.grants.length > 0);
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        Someone with a role on the whole account sees every card; someone with a role on a card sees only that
        card. A person can have both, and can do whatever either role allows.
      </Text>
      <Stack gap="xs">
        <Title order={4}>Whole account</Title>
        <GrantTable accountId={accountId} grants={whole} />
      </Stack>
      {cards.map(({ card, grants }) => (
        <Stack gap="xs" key={card.id}>
          <Title order={4}>{card.name}</Title>
          <GrantTable accountId={accountId} grants={grants} />
        </Stack>
      ))}
      <AddMember accountId={accountId} cards={logicalCards.map((c) => ({ id: c.id, name: c.name }))} />
    </Stack>
  );
}

function GrantTable({ accountId, grants }: { accountId: string; grants: Grant[] }) {
  return (
    <Table layout="fixed">
      <Table.Tbody>
        {grants.map((g) => (
          <GrantRow key={g.id} accountId={accountId} grant={g} />
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** A change an owner is making to their own ownership, which they couldn't undo themselves. */
type Pending = { kind: "demote"; role: Role } | { kind: "remove" };

function GrantRow({ accountId, grant }: { accountId: string; grant: Grant }) {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const [pending, setPending] = useState<Pending | null>(null);
  const param = { accountId, grantId: String(grant.id) };
  // Grants change what the user themselves may do too, so everything about the account is refetched.
  const done = () => {
    setPending(null);
    return queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };
  const change = useMutation({
    mutationFn: (role: Role) => ok(grantsApi[":grantId"].$patch({ param, json: { role } })),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => send(grantsApi[":grantId"].$delete({ param })),
    onSuccess: done,
  });
  const onCard = grant.logicalCardId !== null;
  const ownOwnership = !onCard && grant.role === "owner" && grant.userId === me?.user.id;
  const error = change.error ?? remove.error;

  return (
    <>
      <Table.Tr>
        <Table.Td>{grant.username}</Table.Td>
        <Table.Td>
          <Select
            aria-label={`${grant.username}'s role`}
            size="xs"
            maw={160}
            allowDeselect={false}
            data={roleOptions(onCard)}
            value={grant.role}
            disabled={change.isPending}
            onChange={(value) => {
              const role = value as Role | null;
              if (!role || role === grant.role) return;
              if (ownOwnership) setPending({ kind: "demote", role });
              else change.mutate(role);
            }}
          />
        </Table.Td>
        <Table.Td>
          <Group justify="flex-end">
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              loading={remove.isPending}
              onClick={() => (ownOwnership ? setPending({ kind: "remove" }) : remove.mutate())}
            >
              Remove
            </Button>
          </Group>
        </Table.Td>
      </Table.Tr>
      {(pending || error) && (
        <Table.Tr>
          <Table.Td colSpan={3}>
            {pending && (
              <Paper withBorder p="xs" radius="md">
                <Text size="sm">
                  {pending.kind === "demote"
                    ? `Make yourself ${roleLabel(pending.role, false)}?`
                    : "Remove yourself from the whole account?"}{" "}
                  You won't be able to manage this account's members any more, and only another owner could
                  change that back.
                </Text>
                <Group gap="xs" mt="xs">
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="red"
                    loading={change.isPending || remove.isPending}
                    onClick={() =>
                      pending.kind === "demote" ? change.mutate(pending.role) : remove.mutate()
                    }
                  >
                    {pending.kind === "demote" ? "Change my role" : "Remove me"}
                  </Button>
                  <Button size="compact-xs" variant="light" color="gray" onClick={() => setPending(null)}>
                    Cancel
                  </Button>
                </Group>
              </Paper>
            )}
            {error && (
              <Text c="red" size="sm" mt={pending ? "xs" : 0}>
                {error.message}
              </Text>
            )}
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

const WHOLE = "account";

function AddMember({ accountId, cards }: { accountId: string; cards: { id: number; name: string }[] }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [where, setWhere] = useState(WHOLE);
  const [role, setRole] = useState<Role>("member");
  const onCard = where !== WHOLE;
  const add = useMutation({
    mutationFn: () =>
      ok(
        grantsApi.$post({
          param: { accountId },
          json: { username: username.trim(), logicalCardId: onCard ? Number(where) : null, role },
        }),
      ),
    onSuccess: () => {
      setUsername("");
      return queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  return (
    <Paper withBorder p="sm" radius="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Stack gap="xs">
          <Title order={5}>Add someone</Title>
          {add.error && (
            <Alert color="red" variant="light">
              {add.error.message}
            </Alert>
          )}
          <Group align="flex-start" gap="xs">
            <TextInput
              label="Username"
              description="Someone with a login here"
              required
              autoComplete="off"
              w={200}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
            <Select
              label="On"
              description="The whole account, or one card"
              w={200}
              allowDeselect={false}
              data={[
                { value: WHOLE, label: "Whole account" },
                ...cards.map((c) => ({ value: String(c.id), label: c.name })),
              ]}
              value={where}
              onChange={(value) => {
                const next = value ?? WHOLE;
                setWhere(next);
                // Owner only applies to the whole account.
                if (next !== WHOLE && role === "owner") setRole("manager");
              }}
            />
            <Select
              label="Role"
              description="What they can do there"
              w={160}
              allowDeselect={false}
              data={roleOptions(onCard)}
              value={role}
              onChange={(value) => value && setRole(value as Role)}
            />
          </Group>
          <Group>
            <Button type="submit" size="xs" loading={add.isPending} disabled={!username.trim()}>
              Add
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
