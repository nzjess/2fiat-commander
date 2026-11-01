import { Alert, Anchor, Button, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ok } from "../api.ts";
import { AuthCard } from "../components/AuthCard.tsx";
import { useEnterApp } from "../components/useEnterApp.ts";
import { useNewPassword } from "../components/useNewPassword.tsx";

export const Route = createFileRoute("/invite")({ component: Invite });

function Invite() {
  const enterApp = useEnterApp();
  // In the fragment, so it never reaches a server's logs.
  const [token] = useState(() => window.location.hash.slice(1));
  const { password, matches, fields } = useNewPassword({ autoFocus: true });
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => ok(api.auth.invite.lookup.$post({ json: { token } })),
    enabled: token !== "",
    retry: false,
    gcTime: 0,
  });
  const accept = useMutation({
    mutationFn: () => ok(api.auth.invite.accept.$post({ json: { token, password } })),
    onSuccess: enterApp,
  });

  if (token !== "" && invite.isPending) {
    return (
      <AuthCard>
        <Loader size="sm" />
      </AuthCard>
    );
  }
  if (!invite.data) {
    return (
      <AuthCard>
        <Alert color="red" variant="light">
          {invite.error?.message ?? "This invite link isn't complete. Try opening it again."}
        </Alert>
        <Text size="sm" ta="center">
          <Anchor component={Link} to="/login">
            Go to log in
          </Anchor>
        </Text>
      </AuthCard>
    );
  }
  return (
    <AuthCard>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) accept.mutate();
        }}
      >
        <Stack>
          <Text size="sm">
            You've been invited as <strong>{invite.data.username}</strong>. Set a password to log in.
          </Text>
          {accept.error && (
            <Alert color="red" variant="light">
              {accept.error.message}
            </Alert>
          )}
          {/* For password managers, which save the username beside the new password. */}
          <input type="hidden" autoComplete="username" value={invite.data.username} />
          {fields}
          <Button type="submit" loading={accept.isPending} disabled={!matches}>
            Set password and log in
          </Button>
        </Stack>
      </form>
    </AuthCard>
  );
}
