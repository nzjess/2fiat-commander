import { and, asc, eq, gte, inArray, max, sql } from "drizzle-orm";
import type { Db } from "./db/db.ts";
import { fxRates } from "./db/schema.ts";
import { addDays } from "./time.ts";

// Display currencies. 2fiat is USD-native and every stored amount stays in USD; the web app converts for display
// with the ECB's daily reference rates, which we mirror here. The ECB quotes against the euro, so USD→X is a cross
// rate: X per euro ÷ USD per euro.

/** The currencies a user can show amounts in (a short list; each has an ECB rate on every working day). */
export const CURRENCIES = ["USD", "GBP", "EUR", "NZD", "AUD", "CAD", "CHF", "HKD", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (value: string): value is Currency =>
  (CURRENCIES as readonly string[]).includes(value);

/** Rates are kept from this day on: nothing earlier is needed. */
export const FX_FROM = "2024-01-01";

/** Every supported currency but the euro, which the ECB quotes against. */
const MIRRORED = CURRENCIES.filter((c) => c !== "EUR");

/** Re-fetched each run, so the ECB's corrections to recent rates land. */
const REFETCH_DAYS = 7;

const ECB_DATA = "https://data-api.ecb.europa.eu/service/data/EXR/";

/** The ECB data API's daily reference rates for `currencies` from `from` on, as CSV. */
export const ecbUrl = (from: string, currencies: readonly string[] = MIRRORED): string =>
  `${ECB_DATA}D.${currencies.join("+")}.EUR.SP00.A?startPeriod=${from}&format=csvdata`;

export interface EcbRate {
  currency: string;
  day: string;
  perEur: number;
}

/** The rates in the ECB's CSV (columns `CURRENCY`, `TIME_PERIOD`, `OBS_VALUE`). No data is an empty body. */
export function parseEcbCsv(text: string): EcbRate[] {
  const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!header) return [];
  const columns = splitCsvLine(header);
  const at = (name: string) => {
    const index = columns.indexOf(name);
    if (index < 0) throw new Error(`the ECB's CSV has no ${name} column`);
    return index;
  };
  const [currencyAt, dayAt, valueAt] = [at("CURRENCY"), at("TIME_PERIOD"), at("OBS_VALUE")];
  const rates: EcbRate[] = [];
  for (const line of lines) {
    const fields = splitCsvLine(line);
    const currency = fields[currencyAt] ?? "";
    const day = fields[dayAt] ?? "";
    const perEur = Number(fields[valueAt]);
    // A missing observation (e.g. a currency the ECB stopped quoting) is left out.
    if (!/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !(perEur > 0)) continue;
    rates.push({ currency, day, perEur });
  }
  return rates;
}

/** One CSV line's fields; a quoted field may hold commas and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * The day to fetch from: a week before the least up-to-date currency's latest rate (so corrections land), or
 * `FX_FROM` for a currency with none yet (e.g. one just added to the whitelist).
 */
export function mirrorFrom(db: Db): string {
  const latest = new Map(
    db
      .select({ currency: fxRates.currency, day: max(fxRates.day) })
      .from(fxRates)
      .groupBy(fxRates.currency)
      .all()
      .map((r) => [r.currency, r.day]),
  );
  const days = MIRRORED.map((c) => latest.get(c) ?? FX_FROM).sort();
  const from = addDays(days[0] ?? FX_FROM, -REFETCH_DAYS);
  return from < FX_FROM ? FX_FROM : from;
}

/** Fetches the ECB's rates since `mirrorFrom` and stores them, replacing any it corrected. Returns the count. */
export async function mirrorRates(
  db: Db,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  const res = await fetch(ecbUrl(mirrorFrom(db)), { headers: { accept: "text/csv" } });
  if (!res.ok) throw new Error(`the ECB answered ${res.status}`);
  const rates = parseEcbCsv(await res.text()).filter(
    (r) => (MIRRORED as readonly string[]).includes(r.currency) && r.day >= FX_FROM,
  );
  db.transaction((q) => {
    for (const rate of rates) {
      q.insert(fxRates)
        .values(rate)
        .onConflictDoUpdate({
          target: [fxRates.currency, fxRates.day],
          set: { perEur: sql`excluded.per_eur` },
        })
        .run();
    }
  });
  return rates.length;
}

/**
 * USD→`currency` on each ECB working day since `FX_FROM`, oldest first: how many units of it a dollar bought.
 * Empty for USD itself, which needs no rate.
 */
export function usdRates(db: Db, currency: Currency): { day: string; rate: number }[] {
  if (currency === "USD") return [];
  const rows = db
    .select()
    .from(fxRates)
    .where(and(inArray(fxRates.currency, ["USD", currency]), gte(fxRates.day, FX_FROM)))
    .orderBy(asc(fxRates.day))
    .all();
  const usdPerEur = new Map(rows.filter((r) => r.currency === "USD").map((r) => [r.day, r.perEur]));
  if (currency === "EUR") return [...usdPerEur].map(([day, usd]) => ({ day, rate: 1 / usd }));
  return rows
    .filter((r) => r.currency === currency && usdPerEur.has(r.day))
    .map((r) => ({ day: r.day, rate: r.perEur / (usdPerEur.get(r.day) as number) }));
}

/** The latest day with a USD rate, or null before the first mirror. */
export function latestRateDay(db: Db): string | null {
  return (
    db
      .select({ day: max(fxRates.day) })
      .from(fxRates)
      .where(eq(fxRates.currency, "USD"))
      .get()?.day ?? null
  );
}

const MIRROR_EVERY_MS = 6 * 3_600_000;

/** Mirrors the ECB's rates at start and every 6 hours. A failure is logged, and the next run catches up. */
export class FxMirror {
  readonly #db: Db;
  readonly #fetch: typeof globalThis.fetch;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<number | undefined> | undefined;

  constructor(options: { db: Db; fetch?: typeof globalThis.fetch }) {
    this.#db = options.db;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.run(), MIRROR_EVERY_MS);
    void this.run();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One mirror run: the number of rates stored, or undefined if it failed. A run while one is going joins it. */
  run(): Promise<number | undefined> {
    this.#running ??= mirrorRates(this.#db, this.#fetch)
      .catch((err: unknown) => {
        console.error("mirroring exchange rates failed:", err);
        return undefined;
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }
}
