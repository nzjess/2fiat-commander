import { TwoFiatAuthError, TwoFiatError } from "./errors.ts";

export const DEFAULT_BASE_URL = "https://2fiat.com/api/v1/";

// 2fiat has dropped connections from requests without a browser-like user agent.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

export type Query = Record<string, string | number | undefined>;

export interface SessionOptions {
  /** The account secret: the `token1…` segment of the account's login link. */
  token: string;
  /** A previously issued `sid` cookie value, to skip the exchange while it's still valid. */
  sid?: string;
  /** Called whenever a new `sid` is issued, so the caller can persist it. */
  onSid?: (sid: string) => void;
  baseUrl?: string;
  userAgent?: string;
  /** Retries for network errors and 5xx responses. */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * An authenticated connection to one 2fiat account. The API authenticates with an HttpOnly `sid` cookie,
 * which `POST auth/exchange` issues for the account token; on a 401 we exchange again and retry once.
 */
export class TwoFiatSession {
  readonly #token: string;
  readonly #onSid: ((sid: string) => void) | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #sid: string | undefined;

  constructor(options: SessionOptions) {
    this.#token = options.token;
    this.#sid = options.sid;
    this.#onSid = options.onSid;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get sid(): string | undefined {
    return this.#sid;
  }

  async exchange(): Promise<string> {
    const res = await this.#send("auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: this.#token, nextPath: "/wallet/my-cards" }),
    });
    if (!res.ok) throw new TwoFiatAuthError(`token exchange failed with ${res.status}`, res.status);
    const sid = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]?.trim() ?? "")
      .find((kv) => kv.startsWith("sid="))
      ?.slice("sid=".length);
    if (!sid) throw new TwoFiatAuthError("token exchange returned no sid cookie", res.status);
    this.#sid = sid;
    this.#onSid?.(sid);
    return sid;
  }

  /** GET a JSON endpoint, path relative to the API base (e.g. `cards`). */
  async get(path: string, query: Query = {}): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

    let reauthed = false;
    if (!this.#sid) {
      await this.exchange();
      reauthed = true;
    }
    for (;;) {
      const res = await this.#send(url, { headers: { cookie: `sid=${this.#sid}` } });
      if (res.status === 401 && !reauthed) {
        await this.exchange();
        reauthed = true;
        continue;
      }
      if (!res.ok) throw new TwoFiatError(`GET ${path} failed with ${res.status}`, res.status);
      return res.json();
    }
  }

  async #send(url: string | URL, init: RequestInit): Promise<Response> {
    const target = typeof url === "string" ? new URL(url, this.#baseUrl) : url;
    const headers = { "user-agent": this.#userAgent, accept: "application/json", ...init.headers };
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.#fetch(target, { ...init, headers });
        if (res.status < 500 || attempt >= this.#maxRetries) return res;
      } catch (err) {
        if (attempt >= this.#maxRetries)
          throw new TwoFiatError(`request to ${target.pathname} failed`, undefined, { cause: err });
      }
      await this.#sleep(500 * 2 ** attempt);
    }
  }
}
