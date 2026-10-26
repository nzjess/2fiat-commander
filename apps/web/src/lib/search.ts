// Typed search params. The router hands over whatever the URL held (numbers already parsed from JSON), so each
// parser keeps only well-formed values and drops the rest.

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

/** Where to go after logging in: only a path on this site, so a crafted link can't send the user elsewhere. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }
  return value.startsWith("/login") ? undefined : value;
}
