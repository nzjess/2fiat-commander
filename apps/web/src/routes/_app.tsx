import { AppShell, Burger, Button, Group, Menu, Select, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatchRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { api, isUnauthenticated, send } from "../api.ts";
import { NavItem } from "../components/links.tsx";
import { SyncButton } from "../components/SyncButton.tsx";
import { getLastAccount } from "../lib/storage.ts";
import { accountsQuery, meQuery } from "../queries.ts";

/** Everything behind the login: the shell with the account switcher, sync and navigation. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (isUnauthenticated(error)) throw redirect({ to: "/login", search: { redirect: location.href } });
      throw error;
    }
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(accountsQuery),
  component: Layout,
});

function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { data: accounts } = useSuspenseQuery(accountsQuery);
  const params = useParams({ strict: false });
  const last = getLastAccount();
  // Off an account's pages (e.g. on /accounts), the navigation still points at the last account viewed.
  const accountId = params.accountId ?? (accounts.some((a) => String(a.id) === last) ? last : undefined);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            <Text fw={700} visibleFrom="xs">
              2fiat Commander
            </Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {params.accountId && <SyncButton accountId={params.accountId} />}
            <AccountSwitcher accountId={accountId} />
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <Nav accountId={accountId} onNavigate={close} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

function Nav({ accountId, onNavigate }: { accountId: string | undefined; onNavigate: () => void }) {
  const matchRoute = useMatchRoute();
  return (
    <>
      {accountId && (
        <>
          <NavItem
            to="/a/$accountId"
            params={{ accountId }}
            // The router would otherwise mark it current on every page of the account.
            activeOptions={{ exact: true }}
            label="Overview"
            active={
              !!matchRoute({ to: "/a/$accountId", params: { accountId } }) ||
              !!matchRoute({ to: "/a/$accountId/cards/$logicalCardId", params: { accountId }, fuzzy: true })
            }
            onClick={onNavigate}
          />
          <NavItem
            to="/a/$accountId/insights"
            params={{ accountId }}
            label="Insights"
            active={!!matchRoute({ to: "/a/$accountId/insights", params: { accountId } })}
            onClick={onNavigate}
          />
          <NavItem
            to="/a/$accountId/findings"
            params={{ accountId }}
            label="Findings"
            active={!!matchRoute({ to: "/a/$accountId/findings", params: { accountId } })}
            onClick={onNavigate}
          />
        </>
      )}
      <NavItem
        to="/accounts"
        label="Accounts"
        active={!!matchRoute({ to: "/accounts" })}
        onClick={onNavigate}
      />
    </>
  );
}

function AccountSwitcher({ accountId }: { accountId: string | undefined }) {
  const { data: accounts = [] } = useQuery(accountsQuery);
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const active = accounts.filter((a) => a.archivedAt === null);
  const archived = accounts.filter((a) => a.archivedAt !== null);
  const option = (a: (typeof accounts)[number]) => ({ value: String(a.id), label: a.label });
  const data = archived.length
    ? [
        { group: "Accounts", items: active.map(option) },
        { group: "Archived", items: archived.map(option) },
      ]
    : active.map(option);

  if (accounts.length === 0) return null;
  return (
    <Select
      aria-label="Account"
      size="xs"
      w={{ base: 130, sm: 200 }}
      placeholder="Choose an account"
      data={data}
      value={accountId ?? null}
      allowDeselect={false}
      onChange={(id) => {
        if (!id) return;
        // Stay on the findings or insights page when switching, without its card filter: cards belong to one
        // account. A card page has no counterpart in another account, so that goes to the overview.
        const to = matchRoute({ to: "/a/$accountId/findings", fuzzy: true })
          ? "/a/$accountId/findings"
          : matchRoute({ to: "/a/$accountId/insights", fuzzy: true })
            ? "/a/$accountId/insights"
            : "/a/$accountId";
        void navigate({ to, params: { accountId: id } });
      }}
    />
  );
}

function UserMenu() {
  const { data } = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => send(api.auth.logout.$post()),
    onSettled: () => {
      queryClient.clear();
      void navigate({ to: "/login" });
    },
  });
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <Button size="xs" variant="subtle" color="gray">
          {data?.user.username ?? "…"}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={() => logout.mutate()}>Log out</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
