export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

export const sidCookie = (sid: string) => ({
  "set-cookie": `sid=${sid}; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Lax`,
});

/** A fetch stand-in that records calls and answers from a handler. */
export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Routes by `METHOD path` relative to the API base, e.g. `GET cards`. */
export function routes(table: Record<string, Handler>): Handler {
  return (call) => {
    const key = `${call.method} ${call.url.pathname.replace(/^\/api\/v1\//, "")}`;
    const handler = table[key];
    if (!handler) throw new Error(`no route for ${key}`);
    return handler(call);
  };
}

/** Accepts only requests carrying `sid=<sid>`, 401 otherwise. */
export const requireSid =
  (sid: string, handler: Handler): Handler =>
  (call) =>
    call.headers.cookie === `sid=${sid}` ? handler(call) : json({ error: "Unauthorized" }, { status: 401 });
