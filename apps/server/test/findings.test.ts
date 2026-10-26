import type { Finding } from "@twofiat/client";
import { authorization, CARD_A } from "@twofiat/client/fixtures";
import { describe, expect, test } from "vitest";
import { findings } from "../src/db/schema.ts";
import { findingFingerprint, recordFindings } from "../src/findings.ts";
import { renormalize } from "../src/ledger.ts";
import { setup } from "./setup.ts";

describe("findingFingerprint", () => {
  test("card-level kinds ignore the activities involved", () => {
    expect(findingFingerprint("balance-gap", [])).toBe("balance-gap");
    expect(findingFingerprint("fees-above-advertised", [3, 1])).toBe("fees-above-advertised");
  });

  test("other kinds are identified by their activity ids, in any order", () => {
    expect(findingFingerprint("credit-shortfall", [9, 2])).toBe("credit-shortfall:2,9");
    expect(findingFingerprint("credit-shortfall", [2, 9])).toBe(
      findingFingerprint("credit-shortfall", [9, 2]),
    );
  });
});

describe("recordFindings", () => {
  test("tracks a finding's identity across evaluations", () => {
    const s = setup();
    const a = authorization({ at: "2026-10-01T00:00:00.000Z", amount: "-5.00" });
    s.addRows([a]);
    renormalize(s.db, s.accountId);
    const activityId = s.ledger()[0]?.id;

    const gap = (cents: number): Finding => ({
      kind: "balance-gap",
      cents,
      activityKeys: [],
      message: "gap",
    });
    const stale: Finding = {
      kind: "stale-authorization",
      cents: -500,
      activityKeys: [`purchase:${a.id}`],
      message: "stale",
    };
    const record = (fs: Finding[]) =>
      recordFindings(s.db, s.accountId, s.addEvaluation(), [{ cardId: CARD_A, findings: fs }]);
    const rows = () =>
      s.db
        .select()
        .from(findings)
        .all()
        .map((f) => [
          f.fingerprint,
          f.cents,
          f.firstSeenEvaluationId,
          f.lastSeenEvaluationId,
          f.resolvedEvaluationId,
        ]);

    expect(record([gap(-1200), stale])).toEqual({ opened: 2, continued: 0, resolved: 0 });
    // The gap's amount changes but it stays the same finding; the stale authorisation is gone.
    expect(record([gap(-1500)])).toEqual({ opened: 0, continued: 1, resolved: 1 });
    expect(rows()).toEqual([
      ["balance-gap", -1500, 1, 2, null],
      [`stale-authorization:${activityId}`, -500, 1, 1, 2],
    ]);
    // It comes back as the same finding.
    expect(record([gap(-1500), stale])).toEqual({ opened: 1, continued: 1, resolved: 0 });
    expect(rows()[1]).toEqual([`stale-authorization:${activityId}`, -500, 1, 3, null]);
  });

  test("rejects a finding about an unknown activity", () => {
    const s = setup();
    const f: Finding = { kind: "credit-shortfall", activityKeys: ["topup:nope"], message: "" };
    expect(() =>
      recordFindings(s.db, s.accountId, s.addEvaluation(), [{ cardId: CARD_A, findings: [f] }]),
    ).toThrow(/unknown activity/);
  });
});
