import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Divider,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Grant, ok, send } from "../../../../api.ts";
import { useAccess } from "../../../../components/useAccess.ts";
import { accessOf, inviteLink, type Role, roleLabel, roleOptions } from "../../../../lib/access.ts";
import { logicalCardLabel } from "../../../../lib/format.ts";
import { accountQuery, cardsQuery, grantsQuery, logicalCardsQuery, meQuery } from "../../../../queries.ts";

export const Route = createFileRoute("/_app/a/$accountId/members")({
  loader: async ({ context: { queryClient }, params: { accountId } }) => {
    const account = await queryClient.ensureQueryData(accountQuery(accountId));
    if (!accessOf(account.access).can("grants.manage")) return;
    await Promise.all([
      queryClient.ensureQueryData(grantsQuery(accountId)),
      queryClient.ensureQueryData(logicalCardsQuery(accountId)),
      queryClient.ensureQueryData(cardsQuery(accountId)),
    ]);
  },
  component: MembersPage,
});

const grantsApi = api.accounts[":accountId"].grants;
const invitesApi = api.accounts[":accountId"].invites;

/** The one link on show, in the row of the grant it was made from. The server can't show it again. */
interface ShownLink {
  grantId: number;
  token: string;
  expiresAt: string;
}

/** The link for someone invited, with what they need to know to share it. */
function InviteLinkPanel({
  username,
  token,
  expiresAt,
}: {
  username: string;
  token: string;
  expiresAt: string;
}) {
  const link = inviteLink(window.location.origin, token);
  const panel = useRef<HTMLDivElement>(null);
  // The button that made it can be far from the row it shows in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: for each new link
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [token]);
  return (
    <Alert ref={panel} color="blue" variant="light" title={`Send this link to ${username}`}>
      <Stack gap="xs">
        <Text size="sm">
          It lets whoever opens it first set the password for {username}, so share it somewhere private. It
          works once, until {new Date(expiresAt).toLocaleDateString()}, and won't be shown again.
        </Text>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            aria-label={`Invite link for ${username}`}
            readOnly
            size="xs"
            flex={1}
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <CopyButton value={link}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Stack>
    </Alert>
  );
}

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
  const { data: physicalCards } = useSuspenseQuery(cardsQuery(accountId));
  const labelled = logicalCards.map((card) => ({
    id: card.id,
    name: logicalCardLabel(card, physicalCards),
  }));
  const [link, setLink] = useState<ShownLink | null>(null);
  const tableProps = { accountId, link, onLink: setLink };
  const whole = grants.filter((g) => g.logicalCardId === null);
  const cards = labelled
    .map((card) => ({ card, grants: grants.filter((g) => g.logicalCardId === card.id) }))
    .filter((c) => c.grants.length > 0);
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        Someone with a role on the whole account sees every card; someone with a role on a card sees only that
        card. A person can have both, and can do whatever either role allows.
      </Text>
      <Stack gap="xs">
        <Title order={4}>Account</Title>
        <GrantTable {...tableProps} grants={whole} />
      </Stack>
      {cards.length > 0 && <Divider />}
      {cards.map(({ card, grants }) => (
        <Stack gap="xs" key={card.id}>
          <Title order={4}>{card.name}</Title>
          <GrantTable {...tableProps} grants={grants} />
        </Stack>
      ))}
      <AddMember accountId={accountId} cards={labelled} onLink={setLink} />
    </Stack>
  );
}

interface LinkProps {
  accountId: string;
  link: ShownLink | null;
  onLink: (link: ShownLink) => void;
}

function GrantTable({ grants, ...props }: LinkProps & { grants: Grant[] }) {
  return (
    <Table layout="fixed">
      <Table.Tbody>
        {grants.map((g) => (
          <GrantRow key={g.id} {...props} grant={g} />
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** A change an owner is making to their own ownership, which they couldn't undo themselves. */
type Pending = { kind: "demote"; role: Role } | { kind: "remove" };

function GrantRow({ accountId, link, onLink, grant }: LinkProps & { grant: Grant }) {
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
  const newLink = useMutation({
    mutationFn: () => ok(invitesApi[":userId"].$post({ param: { accountId, userId: String(grant.userId) } })),
    onSuccess: ({ token, expiresAt }) => onLink({ grantId: grant.id, token, expiresAt }),
  });
  const onCard = grant.logicalCardId !== null;
  const ownOwnership = !onCard && grant.role === "owner" && grant.userId === me?.user.id;
  const error = change.error ?? remove.error ?? newLink.error;

  return (
    <>
      <Table.Tr>
        <Table.Td>
          <Group gap="xs">
            {grant.username}
            {grant.pending && (
              <Badge size="xs" variant="light" color="gray">
                Invited
              </Badge>
            )}
          </Group>
        </Table.Td>
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
          <Group justify="flex-end" gap="xs">
            {grant.canMakeLink && (
              <Button
                size="compact-xs"
                variant="light"
                loading={newLink.isPending}
                onClick={() => newLink.mutate()}
              >
                New link
              </Button>
            )}
            {grant.pending && !grant.canMakeLink && (
              <Text size="xs" c="dimmed" flex={1}>
                Invited to another account too, so only someone who owns both can make a new link.
              </Text>
            )}
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
      {link?.grantId === grant.id && grant.pending && (
        <Table.Tr>
          <Table.Td colSpan={3}>
            <InviteLinkPanel username={grant.username} token={link.token} expiresAt={link.expiresAt} />
          </Table.Td>
        </Table.Tr>
      )}
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
                  <Button
                    size="compact-xs"
                    variant="light"
                    color="gray"
                    onClick={() => {
                      setPending(null);
                      change.reset();
                      remove.reset();
                    }}
                  >
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

function AddMember({
  accountId,
  cards,
  onLink,
}: {
  accountId: string;
  cards: { id: number; name: string }[];
  onLink: (link: ShownLink) => void;
}) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [where, setWhere] = useState(WHOLE);
  const [role, setRole] = useState<Role>("member");
  const onCard = where !== WHOLE;
  const newGrant = { username: username.trim(), logicalCardId: onCard ? Number(where) : null, role };
  const added = () => {
    setUsername("");
    return queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };
  const add = useMutation({
    mutationFn: () => ok(grantsApi.$post({ param: { accountId }, json: newGrant })),
    onSuccess: added,
  });
  const invite = useMutation({
    mutationFn: () => ok(invitesApi.$post({ param: { accountId }, json: newGrant })),
    onSuccess: ({ grant, token, expiresAt }) => {
      add.reset();
      if (grant) onLink({ grantId: grant.id, token, expiresAt });
      return added();
    },
  });
  const unknownUser = add.error instanceof ApiError && add.error.code === "unknown_user";
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
            <Alert color={unknownUser ? "blue" : "red"} variant="light">
              <Stack gap="xs" align="flex-start">
                <Text size="sm">
                  {unknownUser
                    ? `Nobody here is called ${newGrant.username}. Invite them? They'll get this role, and you'll get a link to send them.`
                    : add.error.message}
                </Text>
                {unknownUser && (
                  <Button size="compact-xs" loading={invite.isPending} onClick={() => invite.mutate()}>
                    Invite them
                  </Button>
                )}
              </Stack>
            </Alert>
          )}
          {invite.error && (
            <Alert color="red" variant="light">
              {invite.error.message}
            </Alert>
          )}
          <Group align="flex-start" gap="xs">
            <TextInput
              label="Username"
              description="Existing, or new to invite"
              required
              autoComplete="off"
              w={200}
              value={username}
              onChange={(e) => {
                setUsername(e.currentTarget.value);
                // What's shown is about the name that was tried.
                add.reset();
                invite.reset();
              }}
            />
            <Select
              label="On"
              description="The account, or one card"
              w={200}
              allowDeselect={false}
              data={[
                { value: WHOLE, label: "Account" },
                ...(cards.length > 0
                  ? [{ group: "Cards", items: cards.map((c) => ({ value: String(c.id), label: c.name })) }]
                  : []),
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
            <Button type="submit" size="xs" loading={add.isPending} disabled={!newGrant.username}>
              Add
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
