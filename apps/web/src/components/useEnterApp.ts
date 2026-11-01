import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { User } from "../api.ts";
import { meQuery } from "../queries.ts";

/** Goes into the app as a user just created. Anything cached belonged to whoever this browser was before. */
export function useEnterApp() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (me: { user: User }) => {
    queryClient.clear();
    queryClient.setQueryData(meQuery.queryKey, me);
    router.history.push("/");
  };
}
