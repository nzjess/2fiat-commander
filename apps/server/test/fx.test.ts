import { describe, expect, test, vi } from "vitest";
import { openDb } from "../src/db/db.ts";
import { fxRates } from "../src/db/schema.ts";
import {
  ecbUrl,
  FxMirror,
  latestRateDay,
  mirrorFrom,
  mirrorRates,
  parseEcbCsv,
  usdRates,
} from "../src/fx.ts";

const HEADER =
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE_COMPL,UNIT";

/** A row as the ECB's data API writes it, with a quoted title holding commas. */
const row = (currency: string, day: string, value: string) =>
  `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${day},${value},A,` +
  `"ECB reference exchange rate, ${currency}/Euro, 2.15 pm (C.E.T.)",${currency}`;

const csv = (...rows: string[]) => [HEADER, ...rows].join("\r\n");

/** A fetch that answers `body` and records the URLs asked for. */
function fakeEcb(body: string, status = 200) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe("parseEcbCsv", () => {
  test("reads currency, day and rate by column name, past quoted commas", () => {
    expect(parseEcbCsv(csv(row("GBP", "2026-10-23", "0.83728"), row("USD", "2026-10-23", "1.1188")))).toEqual(
      [
        { currency: "GBP", day: "2026-10-23", perEur: 0.83728 },
        { currency: "USD", day: "2026-10-23", perEur: 1.1188 },
      ],
    );
  });

  test("treats an empty body as no data, and skips missing observations", () => {
    expect(parseEcbCsv("")).toEqual([]);
    expect(parseEcbCsv(csv(row("BGN", "2026-01-02", ""), row("BGN", "2026-01-05", "NaN")))).toEqual([]);
  });

  test("fails loudly if the ECB changes its columns", () => {
    expect(() => parseEcbCsv("KEY,CURRENCY,DATE,VALUE\nx,GBP,2026-10-23,1")).toThrow(/TIME_PERIOD/);
  });
});

describe("mirrorRates", () => {
  test("starts from 2024 for every whitelisted currency but the euro", async () => {
    const db = openDb(":memory:");
    expect(mirrorFrom(db)).toBe("2024-01-01");
    const ecb = fakeEcb(csv(row("USD", "2024-01-02", "1.0956"), row("GBP", "2024-01-02", "0.86518")));
    expect(await mirrorRates(db, ecb.fetch)).toBe(2);
    expect(ecb.urls).toEqual([ecbUrl("2024-01-01")]);
    expect(ecb.urls[0]).toBe(
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+NZD+AUD+CAD+CHF+HKD+JPY.EUR.SP00.A" +
        "?startPeriod=2024-01-01&format=csvdata",
    );
  });

  test("refetches the last week, replacing corrected rates, and ignores what isn't whitelisted", async () => {
    const db = openDb(":memory:");
    const all = ["USD", "GBP", "NZD", "AUD", "CAD", "CHF", "HKD", "JPY"];
    await mirrorRates(db, fakeEcb(csv(...all.map((c) => row(c, "2026-10-23", "1.5")))).fetch);
    expect(mirrorFrom(db)).toBe("2026-10-16");

    const ecb = fakeEcb(
      csv(
        row("USD", "2026-10-23", "1.1188"),
        row("USD", "2026-10-26", "1.12"),
        row("SEK", "2026-10-26", "11.1"),
      ),
    );
    expect(await mirrorRates(db, ecb.fetch)).toBe(2);
    expect(ecb.urls).toEqual([ecbUrl("2026-10-16")]);
    const usd = db
      .select()
      .from(fxRates)
      .all()
      .filter((r) => r.currency === "USD");
    expect(usd).toEqual([
      { currency: "USD", day: "2026-10-23", perEur: 1.1188 },
      { currency: "USD", day: "2026-10-26", perEur: 1.12 },
    ]);
    expect(
      db
        .select()
        .from(fxRates)
        .all()
        .some((r) => r.currency === "SEK"),
    ).toBe(false);
    expect(latestRateDay(db)).toBe("2026-10-26");
  });

  test("goes back to 2024 for a currency with no rates yet", async () => {
    const db = openDb(":memory:");
    await mirrorRates(
      db,
      fakeEcb(csv(row("USD", "2026-10-23", "1.1"), row("GBP", "2026-10-23", "0.8"))).fetch,
    );
    expect(mirrorFrom(db)).toBe("2024-01-01");
  });

  test("throws on an error from the ECB, storing nothing", async () => {
    const db = openDb(":memory:");
    await expect(mirrorRates(db, fakeEcb("busy", 503).fetch)).rejects.toThrow(/503/);
    expect(db.select().from(fxRates).all()).toEqual([]);
  });
});

describe("usdRates", () => {
  test("crosses through the euro, on days with both rates", async () => {
    const db = openDb(":memory:");
    await mirrorRates(
      db,
      fakeEcb(
        csv(
          row("USD", "2026-10-22", "1.25"),
          row("GBP", "2026-10-22", "0.875"),
          row("USD", "2026-10-23", "1.2"),
          row("GBP", "2026-10-23", "0.84"),
          row("GBP", "2026-10-26", "0.9"),
        ),
      ).fetch,
    );
    expect(usdRates(db, "GBP").map((r) => [r.day, Number(r.rate.toFixed(6))])).toEqual([
      ["2026-10-22", 0.7],
      ["2026-10-23", 0.7],
    ]);
    expect(usdRates(db, "EUR")).toEqual([
      { day: "2026-10-22", rate: 0.8 },
      { day: "2026-10-23", rate: 1 / 1.2 },
    ]);
    expect(usdRates(db, "USD")).toEqual([]);
    expect(usdRates(db, "JPY")).toEqual([]);
  });
});

describe("FxMirror", () => {
  test("logs a failed run and carries on", async () => {
    const db = openDb(":memory:");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new FxMirror({ db, fetch: fakeEcb("down", 500).fetch });
    expect(await failing.run()).toBeUndefined();
    expect(error).toHaveBeenCalledWith("mirroring exchange rates failed:", expect.any(Error));
    error.mockRestore();
    const working = new FxMirror({ db, fetch: fakeEcb(csv(row("USD", "2026-10-23", "1.1"))).fetch });
    expect(await working.run()).toBe(1);
  });
});
