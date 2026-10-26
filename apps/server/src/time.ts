const DAY_MS = 86_400_000;

/** A UTC day, `YYYY-MM-DD`. */
export const utcDay = (time: Date | string): string => new Date(time).toISOString().slice(0, 10);

/** Shifts a UTC day (`YYYY-MM-DD`) by whole days. */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);

/** Shifts an ISO timestamp back by whole days. */
export const daysBefore = (iso: string, days: number): string =>
  new Date(Date.parse(iso) - days * DAY_MS).toISOString();
