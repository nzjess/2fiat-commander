const STOP_WORDS = new Set(["and", "the"]);

export const normalizeText = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (s: string): string[] =>
  normalizeText(s)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

const tokensMatch = (a: string, b: string): boolean =>
  a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * How well a pending authorisation's description matches a settled one, from 0 to 1. The two are written by
 * different systems: the settled one is usually the pending one plus city and country, but often the merchant name
 * differs too ("BIGSTORE* QX7R20LM4" vs "BIGSTORE.CO.EX SPRINGFIELD USA", "RIDEAPP *TRIP" vs "RDA* PENDING.RIDEAPP.COM Springfield USA").
 * So it's the share of the pending description's words found in the settled one.
 */
export function descriptionSimilarity(pending: string, settled: string): number {
  if (normalizeText(settled).startsWith(normalizeText(pending))) return 1;
  const p = tokens(pending);
  if (p.length === 0) return 0;
  const s = tokens(settled);
  return p.filter((t) => s.some((u) => tokensMatch(t, u))).length / p.length;
}
