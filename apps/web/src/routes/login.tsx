import { Alert, Button, Center, Paper, PasswordInput, Stack, TextInput, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { api, ok } from "../api.ts";
import { safeRedirect } from "../lib/search.ts";
import { meQuery } from "../queries.ts";

export const Route = createFileRoute("/login")({
  validateSearch: (raw): { redirect?: string } => {
    const redirect = safeRedirect(raw.redirect);
    return redirect === undefined ? {} : { redirect };
  },
  component: Login,
});

function Login() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => ok(api.auth.login.$post({ json: { username, password } })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, me);
      router.history.push(redirect ?? "/");
    },
  });

  return (
    <Center h="100vh" px="md">
      <Paper withBorder p="xl" radius="md" w={360} maw="100%">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <Stack>
            <Title order={2}>2fiat Commander</Title>
            {login.error && (
              <Alert color="red" variant="light">
                {login.error.message}
              </Alert>
            )}
            <TextInput
              label="Username"
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <Button type="submit" loading={login.isPending}>
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
