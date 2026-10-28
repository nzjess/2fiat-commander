import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

/**
 * The API plus the built web app from `webDist`, on one origin. Files are served as they are, and any other GET
 * outside `/api` gets `index.html`, so the client-side routes load on a reload or a bookmark. Vite's hashed `/assets`
 * never change, so they're cached for good, while `index.html` is revalidated each time so an update shows at once.
 */
export function withWeb(api: { fetch: (request: Request) => Response | Promise<Response> }, webDist: string) {
  const files = serveStatic({ root: webDist });
  return new Hono()
    .all("/api/*", (c) => api.fetch(c.req.raw))
    .use("*", async (c, next) => {
      await next();
      if (!c.res.ok) return;
      if (c.req.path.startsWith("/assets/")) c.header("Cache-Control", "public, max-age=31536000, immutable");
      else if (c.res.headers.get("Content-Type")?.startsWith("text/html"))
        c.header("Cache-Control", "no-cache");
    })
    .get("/assets/*", files, (c) => c.notFound())
    .get("*", files, serveStatic({ root: webDist, path: "index.html" }));
}
