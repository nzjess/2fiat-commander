import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`server listening on http://127.0.0.1:${info.port}`);
});
