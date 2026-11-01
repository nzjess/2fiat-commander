import { Center, Paper, Stack, Title } from "@mantine/core";
import type { ReactNode } from "react";

/** The card logging in, signing up and accepting an invite all happen on. */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <Center h="100vh" px="md">
      <Paper withBorder p="xl" radius="md" w={360} maw="100%">
        <Stack>
          <Title order={2}>2fiat Commander</Title>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}
