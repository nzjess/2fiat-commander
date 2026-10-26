import { CARD_A, CARD_B, card } from "@twofiat/client/fixtures";
import { describe, expect, test } from "vitest";
import { createAccount, replaceAccount } from "../src/accounts.ts";
import { openDb } from "../src/db/db.ts";
import { syncs, users } from "../src/db/schema.ts";
import { Scheduler } from "../src/scheduler.ts";
import { Secrets } from "../src/secrets.ts";
import { SyncRunner } from "../src/sync.ts";
import { fake2fiat } from "./fake-2fiat.ts";

function setup() {
  const db = openDb(":memory:");
  const secrets = new Secrets(Buffer.alloc(32, 7).toString("base64"));
  const userId = db.insert(users).values({ username: "u", passwordHash: "x" }).returning().get().id;
  const twofiat = fake2fiat({ cards: [card({ id: CARD_A, balance: 0 }), card({ id: CARD_B, balance: 0 })] });
  const clock = { now: new Date("2026-10-20T12:00:00.000Z") };
  const runner = new SyncRunner({
    db,
    secrets,
    session: { fetch: twofiat.fetch, sleep: async () => {} },
    now: () => clock.now,
  });
  const scheduler = new Scheduler({ db, runner, intervalMinutes: 60, now: () => clock.now });
  const add = (label: string, token: string) => createAccount(db, secrets, { userId, label, token });
  return { db, secrets, runner, scheduler, clock, add };
}

describe("Scheduler", () => {
  test("syncs accounts that never synced or whose last sync started an interval ago, one at a time", async () => {
    const s = setup();
    const a = s.add("a", "token1aaa");
    const b = s.add("b", "token1bbb");
    expect(await s.scheduler.tick()).toEqual([a, b]);
    expect(
      s.db
        .select()
        .from(syncs)
        .all()
        .map((x) => [x.accountId, x.trigger, x.status]),
    ).toEqual([
      [a, "scheduled", "ok"],
      [b, "scheduled", "ok"],
    ]);

    s.clock.now = new Date("2026-10-20T12:59:00.000Z");
    expect(await s.scheduler.tick()).toEqual([]);
    await s.runner.sync(a, "manual");
    s.clock.now = new Date("2026-10-20T13:00:00.000Z");
    // A manual sync counts as a sync too.
    expect(s.scheduler.due()).toEqual([b]);
  });

  test("skips archived accounts", async () => {
    const s = setup();
    const a = s.add("a", "token1aaa");
    const b = replaceAccount(s.db, s.secrets, a, { token: "token1bbb" });
    expect(s.scheduler.due()).toEqual([b]);
  });

  test("a tick while one is running joins it", async () => {
    const s = setup();
    s.add("a", "token1aaa");
    const first = s.scheduler.tick();
    expect(s.scheduler.tick()).toBe(first);
    await first;
    expect(s.db.select().from(syncs).all()).toHaveLength(1);
  });

  test("refuses an interval of 0", () => {
    const s = setup();
    expect(() => new Scheduler({ db: s.db, runner: s.runner, intervalMinutes: 0 })).toThrow();
  });
});
