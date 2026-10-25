import { Container, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await api.health.$get()).json(),
  });

  return (
    <Container py="xl">
      <Title>2fiat Commander</Title>
      <Text c="dimmed">server: {health.data?.ok ? "ok" : health.isError ? "unreachable" : "…"}</Text>
    </Container>
  );
}
