import { formatMoney, isoToLocalDate } from "./format.ts";

// The display currency. Money is stored and reported in USD; this converts it for display only, with the ECB's
// daily rates the server mirrors. An activity converts at the rate of its own local day (a purchase's authorisation,
// not its posting), a balance at the latest rate. Amounts are "cents" in either currency: hundredths of a unit.

/** USD→the display currency on one ECB working day: how many units a dollar bought. */
export interface Rate {
  day: string;
  rate: number;
}

/**
 * The rate for a local day (`YYYY-MM-DD`): the latest on or before it, as the ECB publishes working days only. A
 * day before the first rate takes the first. Undefined with no rates at all.
 */
export function rateOn(rates: readonly Rate[], day: string): Rate | undefined {
  let lo = 0;
  let hi = rates.length - 1;
  let found: Rate | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rate = rates[mid] as Rate;
    if (rate.day <= day) {
      found = rate;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found ?? rates[0];
}

/** An amount in the display currency, with what it came from. */
export interface Converted {
  cents: number;
  usdCents: number;
  /** Absent when the amount wasn't converted (USD, or no rates). */
  rate?: Rate;
}

const formats = new Map<string, Intl.NumberFormat>();

/** Cents in any currency, en-US style so other dollars read as such: "£9.84", "NZ$9.84", "¥1,575". */
function formatIn(currency: string, cents: number, signed: boolean): string {
  if (currency === "USD") return formatMoney(cents, { signed });
  const key = `${currency}:${signed}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      signDisplay: signed ? "exceptZero" : "auto",
    });
    formats.set(key, format);
  }
  return format.format(cents / 100);
}

/** A day (`YYYY-MM-DD`) as e.g. "3 Oct 2026", whatever the time zone. */
const formatDay = (day: string) =>
  new Date(day).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Converts and formats money for one display currency. With no rates, everything shows in USD. */
export class Money {
  /** What amounts are shown in: the user's currency, or USD when there are no rates for it. */
  readonly currency: string;
  readonly #rates: readonly Rate[];

  constructor(currency: string, rates: readonly Rate[]) {
    this.#rates = currency === "USD" ? [] : rates;
    this.currency = this.#rates.length > 0 ? currency : "USD";
  }

  get converts(): boolean {
    return this.currency !== "USD";
  }

  /** USD cents in the display currency: at the rate of `at`'s local day, or the latest rate when `at` is null. */
  convert(usdCents: number, at: string | null): Converted {
    const rate = at === null ? this.#rates.at(-1) : rateOn(this.#rates, isoToLocalDate(at));
    return rate ? { cents: usdCents * rate.rate, usdCents, rate } : { cents: usdCents, usdCents };
  }

  /** Cents already in the display currency (e.g. a sum of converted amounts). */
  format(cents: number, { signed = false }: { signed?: boolean } = {}): string {
    return formatIn(this.currency, cents, signed);
  }

  /** USD cents converted (see `convert`) and formatted. */
  show(usdCents: number, at: string | null, { signed = false }: { signed?: boolean } = {}): string {
    return this.format(this.convert(usdCents, at).cents, { signed });
  }

  /** Where a converted amount came from, e.g. "$12.50 at 0.78701 on 3 Oct 2026"; undefined if it wasn't. */
  describe(converted: Converted, { signed = false }: { signed?: boolean } = {}): string | undefined {
    const { rate } = converted;
    if (!rate) return undefined;
    return `${formatMoney(converted.usdCents, { signed })} at ${Number(rate.rate.toPrecision(5))} on ${formatDay(rate.day)}`;
  }
}
