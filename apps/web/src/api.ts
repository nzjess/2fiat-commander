import type { App } from "@twofiat/server/app";
import { hc } from "hono/client";

export const api = hc<App>("/").api;
