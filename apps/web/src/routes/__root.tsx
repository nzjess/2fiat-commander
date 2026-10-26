import { Center, Stack, Text, Title } from "@mantine/core";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { AnchorLink } from "../components/links.tsx";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => (
    <Center h="60vh">
      <Stack align="center" gap="xs">
        <Title order={2}>Not found</Title>
        <Text c="dimmed">There's nothing at this address.</Text>
        <AnchorLink to="/">Go home</AnchorLink>
      </Stack>
    </Center>
  ),
});
