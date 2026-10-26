// Typed search params. The router hands over whatever the URL held (numbers already parsed from JSON), so each
// parser keeps only well-formed values and drops the rest.

import { ACTIVITY_KIND_LABELS, ACTIVITY_STATUS_LABELS, localDayStart } from "./format.ts";

// Open means not explained yet; explained findings are still unresolved.
export const FINDING_STATUSES = ["open", "explained", "resolved", "all"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface FindingsSearch {
  /** Absent means open. */
  status?: FindingStatus;
  /** A logical card. */
  card?: number;
  kind?: string;
}

/** A positive integer from a number or a numeric string, else undefined. */
export function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function parseFindingsSearch(raw: Record<string, unknown>): FindingsSearch {
  const status = FINDING_STATUSES.find((s) => s === raw.status && s !== "open");
  const card = positiveInt(raw.card);
  const kind = typeof raw.kind === "string" && /^[a-z-]+$/.test(raw.kind) ? raw.kind : undefined;
  return {
    ...(status && { status }),
    ...(card !== undefined && { card }),
    ...(kind !== undefined && { kind }),
  };
}

export interface InsightsSearch {
  /** A logical card; absent means the first. */
  card?: number;
}

export function parseInsightsSearch(raw: Record<string, unknown>): InsightsSearch {
  const card = positiveInt(raw.card);
  return card === undefined ? {} : { card };
}

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** Left out of the URL. Always sent to the server, whose own default differs. */
export const DEFAULT_PAGE_SIZE: PageSize = 10;

export interface ActivitySearch {
  /** A logical card; absent means the first. */
  card?: number;
  /** Activity kinds, comma-separated, as the server takes them. */
  kind?: string;
  /** Activity statuses, comma-separated. */
  status?: string;
  /** Local dates like "2026-10-26", both inclusive. */
  from?: string;
  to?: string;
  q?: string;
  /** Only holds that never posted. */
  stale?: true;
  /** Leave fee rows out: each purchase has one, so they double the list. */
  hideFees?: true;
  /** Only the activities this finding points at. */
  finding?: number;
  /** Rows a page; absent means `DEFAULT_PAGE_SIZE`. */
  size?: PageSize;
  /** The activity whose details are open. */
  activity?: number;
}

/** Known values from a comma-separated list, deduplicated, in the order given; undefined if none. */
function knownList(value: unknown, known: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  const items = [...new Set(value.split(",").filter((v) => known.includes(v)))];
  return items.length ? items.join(",") : undefined;
}

const localDate = (value: unknown) =>
  typeof value === "string" && localDayStart(value) !== undefined ? value : undefined;

export function parseActivitySearch(raw: Record<string, unknown>): ActivitySearch {
  // The router parses a numeric search like "1234" as a number.
  const text = typeof raw.q === "number" ? String(raw.q) : raw.q;
  const q = typeof text === "string" ? text.trim().slice(0, 200) : "";
  const fields: ActivitySearch = {
    card: positiveInt(raw.card),
    kind: knownList(raw.kind, Object.keys(ACTIVITY_KIND_LABELS)),
    status: knownList(raw.status, Object.keys(ACTIVITY_STATUS_LABELS)),
    from: localDate(raw.from),
    to: localDate(raw.to),
    q: q || undefined,
    stale: raw.stale === true || raw.stale === "true" ? true : undefined,
    hideFees: raw.hideFees === true || raw.hideFees === "true" ? true : undefined,
    finding: positiveInt(raw.finding),
    size: PAGE_SIZES.find((n) => n === positiveInt(raw.size) && n !== DEFAULT_PAGE_SIZE),
    activity: positiveInt(raw.activity),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** The activities endpoint's query for a logical card and the page's filters (`to` becomes exclusive). */
export function activitiesParams(logicalCardId: number, search: ActivitySearch): Record<string, string> {
  const fields = {
    logicalCardId: String(logicalCardId),
    kind: search.kind,
    status: search.status,
    from: search.from && localDayStart(search.from),
    to: search.to && localDayStart(search.to, 1),
    q: search.q,
    stale: search.stale && "true",
    excludeKind: search.hideFees && "fee",
    findingId: search.finding === undefined ? undefined : String(search.finding),
    limit: String(search.size ?? DEFAULT_PAGE_SIZE),
  };
  return Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Where to go after logging in: only a path on this site, so a crafted link can't send the user elsewhere. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }
  return value.startsWith("/login") ? undefined : value;
}
