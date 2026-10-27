import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, isUnauthenticated } from "./api.ts";
import { ErrorView, PageLoader } from "./components/status.tsx";
import { routeTree } from "./routeTree.gen.ts";

// An expired session can surface from any query or mutation: send the user to log in, then back.
function onError(error: unknown) {
  if (!isUnauthenticated(error) || router.state.location.pathname === "/login") return;
  queryClient.removeQueries({ queryKey: ["me"] });
  void router.navigate({ to: "/login", search: { redirect: router.state.location.href } });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      // Our 4xx answers won't change on a retry.
      retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // Queries cache the data, so the router needn't.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingComponent: PageLoader,
  defaultErrorComponent: ErrorView,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// biome-ignore lint/style/noNonNullAssertion: root element is in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
