import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { api, ok } from "../api.ts";
import { AuthCard } from "../components/AuthCard.tsx";
import { safeRedirect } from "../lib/search.ts";
import { authOptionsQuery, meQuery } from "../queries.ts";

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
  const { data: options } = useQuery(authOptionsQuery);
  const login = useMutation({
    mutationFn: () => ok(api.auth.login.$post({ json: { username, password } })),
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, me);
      router.history.push(redirect ?? "/");
    },
  });

  return (
    <AuthCard>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Stack>
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
          {options?.signupEnabled && (
            <Text size="sm" ta="center">
              New here?{" "}
              <Anchor component={Link} to="/signup">
                Sign up
              </Anchor>
            </Text>
          )}
        </Stack>
      </form>
    </AuthCard>
  );
}
