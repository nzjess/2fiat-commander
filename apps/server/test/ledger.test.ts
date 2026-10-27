import { authorization, CARD_A, card, fee, posting } from "@twofiat/client/fixtures";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { activityAnnotations, cards, categories, logicalCards } from "../src/db/schema.ts";
import { renormalize } from "../src/ledger.ts";
import { setup } from "./setup.ts";

const DAY = 86_400_000;
const daysBefore = (iso: string, days: number) => new Date(Date.parse(iso) - days * DAY).toISOString();

/** An authorisation, its posting 14 hours later, and a fee in between. */
function purchaseRows() {
  const a = authorization({
    at: "2026-10-10T08:00:00.000Z",
    amount: "-20.00",
    description: "SHOP SPRINGFIELD USA",
  });
  const p = posting({ at: "2026-10-10T22:00:00.000Z", amount: "-20.00", description: "SHOP" });
  const f = fee({ at: "2026-10-10T08:00:01.000Z" });
  return { a, p, f };
}

function annotate(
  s: ReturnType<typeof setup>,
  activityId: number,
  category: string | null,
  note: string | null,
) {
  const categoryId =
    category === null
      ? null
      : s.db.insert(categories).values({ userId: s.userId, name: category, color: "blue" }).returning().get()
          .id;
  s.db.insert(activityAnnotations).values({ activityId, categoryId, note }).run();
}

function annotationOf(s: ReturnType<typeof setup>, activityId: number) {
  const row = s.db
    .select({ note: activityAnnotations.note, category: categories.name })
    .from(activityAnnotations)
    .leftJoin(categories, eq(categories.id, activityAnnotations.categoryId))
    .where(eq(activityAnnotations.activityId, activityId))
    .get();
  return row ?? null;
}

describe("renormalize", () => {
  test("puts every raw row into exactly one activity", () => {
    const s = setup();
    const { a, p, f } = purchaseRows();
    s.addRows([a, p, f]);

    expect(renormalize(s.db, s.accountId)).toEqual({ from: "", inserted: 2, updated: 0, deleted: 0 });
    expect(s.ledger().map((x) => [x.key, x.status, x.sources])).toEqual([
      [`purchase:${a.id}`, "settled", [a.id, p.id].sort()],
      [`fee:${f.id}`, "settled", [f.id]],
    ]);
  });

  test("changes no ids when run again", () => {
    const s = setup();
    const { a, p, f } = purchaseRows();
    s.addRows([a, p, f]);
    renormalize(s.db, s.accountId);
    const before = s.ledger();

    expect(renormalize(s.db, s.accountId)).toMatchObject({ inserted: 0, updated: 2, deleted: 0 });
    expect(s.ledger()).toEqual(before);
  });

  test("an activity keeps its id and annotation when its posting arrives", () => {
    const s = setup();
    const { a, p } = purchaseRows();
    s.addRows([a]);
    renormalize(s.db, s.accountId);
    const [pending] = s.ledger();
    expect(pending?.status).toBe("pending");
    annotate(s, pending?.id as number, "Food", "lunch");

    s.addRows([p]);
    renormalize(s.db, s.accountId, daysBefore(p.createdAt, 7));

    const [settled, ...rest] = s.ledger();
    expect(rest).toEqual([]);
    expect(settled).toMatchObject({ id: pending?.id, status: "settled", sources: [a.id, p.id].sort() });
    expect(annotationOf(s, settled?.id as number)).toEqual({ category: "Food", note: "lunch" });
  });

  test("widens the slice to whole activities and leaves older ones alone", () => {
    const s = setup();
    const { a, p } = purchaseRows();
    const old = fee({ at: "2026-09-01T00:00:00.000Z" });
    s.addRows([old, a, p]);
    const oldId = s.seedActivity("old:fee", [old.id]);
    renormalize(s.db, s.accountId, a.createdAt);
    const before = s.ledger();

    // Starting between the authorisation and its posting must not split the purchase.
    const result = renormalize(s.db, s.accountId, p.createdAt);
    expect(result).toMatchObject({ from: a.createdAt, inserted: 0, updated: 1, deleted: 0 });
    expect(s.ledger()).toEqual(before);
    expect(s.ledger()[0]).toMatchObject({ id: oldId, key: "old:fee", normalizerVersion: 0 });
  });

  test("when activities merge, the oldest id survives and the notes are joined", () => {
    const s = setup();
    const { a, p } = purchaseRows();
    s.addRows([a, p]);
    const first = s.seedActivity("old:a", [a.id]);
    const second = s.seedActivity("old:p", [p.id]);
    annotate(s, first, "Food", "lunch");
    annotate(s, second, "Travel", "with Sam");

    expect(renormalize(s.db, s.accountId)).toMatchObject({ inserted: 0, updated: 1, deleted: 1 });
    expect(s.ledger().map((x) => [x.id, x.key])).toEqual([[first, `purchase:${a.id}`]]);
    expect(annotationOf(s, first)).toEqual({ category: "Food", note: "lunch\n\nwith Sam" });
  });

  test("when activities merge, a dropped one's annotation moves to an unannotated survivor", () => {
    const s = setup();
    const { a, p } = purchaseRows();
    s.addRows([a, p]);
    const first = s.seedActivity("old:a", [a.id]);
    const second = s.seedActivity("old:p", [p.id]);
    annotate(s, second, "Travel", "taxi");

    renormalize(s.db, s.accountId);
    expect(annotationOf(s, first)).toEqual({ category: "Travel", note: "taxi" });
  });

  test("when an activity splits, the part with the most of its rows keeps the id", () => {
    const s = setup();
    const { a, p, f } = purchaseRows();
    s.addRows([a, p, f]);
    const id = s.seedActivity("old:all", [a.id, p.id, f.id]);
    annotate(s, id, "Food", null);

    expect(renormalize(s.db, s.accountId)).toMatchObject({ inserted: 1, updated: 1, deleted: 0 });
    const [purchase, charge] = s.ledger();
    expect(purchase).toMatchObject({ id, kind: "purchase" });
    expect(charge?.id).toBeGreaterThan(id);
    expect(annotationOf(s, id)).toEqual({ category: "Food", note: null });
  });

  test("keys can move between kept activities", () => {
    const s = setup();
    const { a, p, f } = purchaseRows();
    s.addRows([a, p, f]);
    const purchase = s.seedActivity(`fee:${f.id}`, [a.id, p.id]);
    const charge = s.seedActivity(`purchase:${a.id}`, [f.id]);

    renormalize(s.db, s.accountId);
    expect(s.ledger().map((x) => [x.id, x.key])).toEqual([
      [purchase, `purchase:${a.id}`],
      [charge, `fee:${f.id}`],
    ]);
  });
});

describe("schema", () => {
  test("a card can't belong to a logical card in another account", () => {
    const s = setup();
    const other = s.addAccount("other");
    const theirs = s.db
      .insert(logicalCards)
      .values({ accountId: other, name: "Theirs" })
      .returning()
      .get().id;

    expect(() =>
      s.db.update(cards).set({ logicalCardId: theirs }).where(eq(cards.twofiatId, CARD_A)).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(s.addCard(card({ id: CARD_A, balance: 0 }), other).accountId).toBe(other);
  });
});
