import type { App } from "@twofiat/server/app";
import { type ClientResponse, hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";

// Annotated so the declaration names only `App`, not the server's internals.
type Client = ReturnType<typeof hc<App>>;

export const api: Client["api"] = hc<App>("/").api;

/** A failed API call: our `{ error, message }` body, or the HTTP status when there's no such body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The `ApiError` for a failed response's status and (parsed, possibly absent) body. */
export function apiError(status: number, body: unknown, statusText = ""): ApiError {
  if (typeof body === "object" && body !== null) {
    const { error, message } = body as Record<string, unknown>;
    if (typeof error === "string" && typeof message === "string") return new ApiError(status, error, message);
  }
  return new ApiError(status, "http_error", statusText ? `${status} ${statusText}` : `HTTP ${status}`);
}

/** Whether the error means the session is missing or expired. */
export const isUnauthenticated = (error: unknown) =>
  error instanceof ApiError && error.code === "unauthenticated";

type OkBody<R> =
  R extends ClientResponse<infer T, infer U, "json"> ? (U extends SuccessStatusCode ? T : never) : never;

interface AnyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

async function failure(r: AnyResponse): Promise<ApiError> {
  const body = await r.json().catch(() => undefined);
  return apiError(r.status, body, r.statusText);
}

/** The body of a successful response; anything else throws an `ApiError`. */
export async function ok<R extends ClientResponse<unknown, number, "json">>(
  res: Promise<R>,
): Promise<OkBody<R>> {
  const r = await res;
  if (!r.ok) throw await failure(r);
  return (await r.json()) as OkBody<R>;
}

/** For responses without a body: throws an `ApiError` unless the call succeeded. */
export async function send(res: Promise<AnyResponse>): Promise<void> {
  const r = await res;
  if (!r.ok) throw await failure(r);
}

// biome-ignore lint/suspicious/noExplicitAny: matches any client method, as `ReturnType` requires
type Body<F extends (...args: any) => any> = OkBody<Awaited<ReturnType<F>>>;
type AccountApi = (typeof api.accounts)[":accountId"];

export type User = Body<typeof api.auth.me.$get>["user"];
export type Account = Body<typeof api.accounts.$get>[number];
export type Sync = Body<AccountApi["syncs"]["$post"]>;
export type Card = Body<AccountApi["cards"]["$get"]>[number];
export type LogicalCard = Body<AccountApi["logical-cards"]["$get"]>[number];
export type Snapshot = Body<AccountApi["snapshots"]["$get"]>[number];
export type Finding = Body<AccountApi["findings"]["$get"]>[number];
export type FindingKind = Finding["kind"];
export type Adjustment = Body<AccountApi["adjustments"]["$get"]>[number];
export type Activity = Body<AccountApi["activities"]["$get"]>["items"][number];
export type ActivityKind = Activity["kind"];
export type ActivityStatus = Activity["status"];
export type ActivityFlag = Activity["flags"][number];
export type FeeSchedule = Body<AccountApi["fee-schedules"]["$get"]>[number];
export type FeeSuggestion = Body<AccountApi["fee-schedules"]["suggestion"]["$get"]>;
export type CardFees = Body<AccountApi["logical-cards"][":logicalCardId"]["fees"]["$get"]>["cards"][number];
export type ActivityDetail = Body<AccountApi["activities"][":activityId"]["$get"]>;
export type Category = Body<AccountApi["categories"]["$get"]>[number];
export type CategoryColor = Category["color"];
export type Rule = Body<AccountApi["categories"]["rules"]["$get"]>[number];
export type RuleMatch = Rule["match"];
