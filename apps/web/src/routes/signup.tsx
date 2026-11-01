import { Alert, Anchor, Button, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ok } from "../api.ts";
import { AuthCard } from "../components/AuthCard.tsx";
import { useEnterApp } from "../components/useEnterApp.ts";
import { useNewPassword } from "../components/useNewPassword.tsx";
import { authOptionsQuery } from "../queries.ts";

export const Route = createFileRoute("/signup")({ component: SignUp });

function SignUp() {
  const enterApp = useEnterApp();
  const { data: options } = useQuery(authOptionsQuery);
  const [username, setUsername] = useState("");
  const { password, matches, fields } = useNewPassword();
  const signup = useMutation({
    mutationFn: () => ok(api.auth.signup.$post({ json: { username, password } })),
    onSuccess: enterApp,
  });
  const logIn = (
    <Text size="sm" ta="center">
      Already have a login?{" "}
      <Anchor component={Link} to="/login">
        Log in
      </Anchor>
    </Text>
  );

  if (options && !options.signupEnabled) {
    return (
      <AuthCard>
        <Text size="sm">Signing up is turned off here.</Text>
        {logIn}
      </AuthCard>
    );
  }
  return (
    <AuthCard>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) signup.mutate();
        }}
      >
        <Stack>
          {signup.error && (
            <Alert color="red" variant="light">
              {signup.error.message}
            </Alert>
          )}
          <TextInput
            label="Username"
            description="Letters, digits, dots, underscores and hyphens"
            autoComplete="username"
            required
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          {fields}
          <Button type="submit" loading={signup.isPending} disabled={!matches}>
            Sign up
          </Button>
          {logIn}
        </Stack>
      </form>
    </AuthCard>
  );
}
