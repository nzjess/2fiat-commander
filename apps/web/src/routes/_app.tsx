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
import { NavItem, useUrlCard } from "../components/links.tsx";
import { SyncButton } from "../components/SyncButton.tsx";
import { accessOf } from "../lib/access.ts";
import { defaultCard, getLastAccount } from "../lib/storage.ts";
import { accountsQuery, fxQuery, logicalCardsQuery, meQuery } from "../queries.ts";

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
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(accountsQuery),
      context.queryClient.ensureQueryData(fxQuery),
    ]),
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

/** A card's pages besides its own, in the sidebar. */
const CARD_PAGES = [
  { to: "/a/$accountId/c/$logicalCardId/activity", label: "Activity" },
  { to: "/a/$accountId/c/$logicalCardId/insights", label: "Insights" },
  { to: "/a/$accountId/c/$logicalCardId/findings", label: "Findings" },
] as const;

function Nav({ accountId, onNavigate }: { accountId: string | undefined; onNavigate: () => void }) {
  const matchRoute = useMatchRoute();
  // The card in view (if it exists), else the last one chosen in this account, else its first: the card pages stay
  // on it. With no cards, there are no card pages to link to.
  const { data: logicalCards } = useQuery({ ...logicalCardsQuery(accountId ?? ""), enabled: !!accountId });
  const urlCard = useUrlCard();
  const card =
    accountId && logicalCards
      ? logicalCards.some((l) => l.id === urlCard)
        ? urlCard
        : defaultCard(accountId, logicalCards)
      : undefined;
  const cardParams = accountId && card !== undefined ? { accountId, logicalCardId: String(card) } : undefined;
  const { data: accounts = [] } = useQuery(accountsQuery);
  const account = accounts.find((a) => String(a.id) === accountId);
  const access = account && accessOf(account.access);
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
              !!matchRoute({ to: "/a/$accountId/c/$logicalCardId", params: { accountId } })
            }
            onClick={onNavigate}
          />
          {cardParams &&
            CARD_PAGES.map(({ to, label }) => (
              <NavItem
                key={to}
                to={to}
                params={cardParams}
                label={label}
                active={!!matchRoute({ to, params: { accountId } })}
                onClick={onNavigate}
              />
            ))}
          {access?.can("account.view") && (
            <NavItem
              to="/a/$accountId/categories"
              params={{ accountId }}
              label="Categories"
              active={!!matchRoute({ to: "/a/$accountId/categories", params: { accountId } })}
              onClick={onNavigate}
            />
          )}
          {access?.can("grants.manage") && (
            <NavItem
              to="/a/$accountId/members"
              params={{ accountId }}
              label="Members"
              active={!!matchRoute({ to: "/a/$accountId/members", params: { accountId } })}
              onClick={onNavigate}
            />
          )}
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
  const queryClient = useQueryClient();
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
      onChange={async (id) => {
        if (!id) return;
        // Every account has these pages, showing its own, for those who may see them there.
        const other = accounts.find((a) => String(a.id) === id);
        const access = other && accessOf(other.access);
        if (matchRoute({ to: "/a/$accountId/categories" }) && access?.can("account.view")) {
          void navigate({ to: "/a/$accountId/categories", params: { accountId: id } });
          return;
        }
        if (matchRoute({ to: "/a/$accountId/members" }) && access?.can("grants.manage")) {
          void navigate({ to: "/a/$accountId/members", params: { accountId: id } });
          return;
        }
        // Stay on the findings, insights or activity page when switching, without its filters, on the other
        // account's own card (the last chosen there, else its first): cards belong to one account. A card's own
        // page has no counterpart there, so that goes to the overview, as does an account without cards.
        const page = CARD_PAGES.find(({ to }) => matchRoute({ to }))?.to;
        const card = page && defaultCard(id, await queryClient.ensureQueryData(logicalCardsQuery(id)));
        if (page && card !== undefined) {
          void navigate({ to: page, params: { accountId: id, logicalCardId: String(card) } });
        } else {
          void navigate({ to: "/a/$accountId", params: { accountId: id } });
        }
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
        <Menu.Item onClick={() => void navigate({ to: "/settings" })}>Settings</Menu.Item>
        <Menu.Item onClick={() => logout.mutate()}>Log out</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
