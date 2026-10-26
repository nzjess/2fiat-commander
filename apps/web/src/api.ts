import type { App } from "@twofiat/server/app";
import { hc } from "hono/client";

// Annotated so the declaration names only `App`, not the server's internals.
type Client = ReturnType<typeof hc<App>>;

export const api: Client["api"] = hc<App>("/").api;
