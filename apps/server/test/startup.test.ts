import { NORMALIZER_VERSION } from "@twofiat/client";
import { CARD_A, posting } from "@twofiat/client/fixtures";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { databasePath, loadConfig } from "../src/config.ts";
import { activities, evaluations } from "../src/db/schema.ts";
import { rebuildOutdated } from "../src/reevaluate.ts";
import { setup } from "./setup.ts";

describe("loadConfig", () => {
  const APP_SECRET = Buffer.alloc(32, 7).toString("base64");

  test("defaults everything but the app secret, with scheduled syncs off", () => {
    const config = loadConfig({ APP_SECRET });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      syncOverlapDays: 7,
      syncIntervalMinutes: 0,
    });
    // Relative to the repo root, wherever the process started.
    expect(config.databasePath).toBe(databasePath({}));
    expect(config.databasePath).toMatch(/twofiat-commander\/data\/commander\.db$/);
  });

  test("reads and checks the env", () => {
    expect(
      loadConfig({ APP_SECRET, DATABASE_PATH: "/tmp/x.db", PORT: "8080", SYNC_INTERVAL_MINUTES: "360" }),
    ).toMatchObject({ databasePath: "/tmp/x.db", port: 8080, syncIntervalMinutes: 360 });
    expect(() => loadConfig({})).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ APP_SECRET, PORT: "nope" })).toThrow(/PORT/);
  });
});

describe("rebuildOutdated", () => {
  test("rebuilds and re-evaluates only ledgers an older normaliser wrote", () => {
    const s = setup();
    const other = s.addAccount("other");
    const row = posting({
      card: CARD_A,
      at: "2026-10-10T08:00:00.000Z",
      amount: "-5.00",
      description: "SHOP",
    });
    s.addRows([row]);
    // Seeded activities are version 0.
    s.seedActivity("purchase:old", [row.id]);
    expect(rebuildOutdated(s.db, new Date())).toEqual([s.accountId]);
    expect(
      s.db
        .select()
        .from(activities)
        .all()
        .map((a) => a.normalizerVersion),
    ).toEqual([NORMALIZER_VERSION]);
    expect(rebuildOutdated(s.db, new Date())).toEqual([]);
    expect(s.db.select().from(evaluations).where(eq(evaluations.accountId, other)).all()).toEqual([]);
  });
});
