import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  ACCOUNT_PERMISSIONS,
  accountsOfUser,
  CARD_PERMISSIONS,
  type Grant,
  loadAccess,
  ROLES,
  type Role,
  resolveAccess,
} from "../src/access.ts";
import { createAccount, replaceAccount } from "../src/accounts.ts";
import { accounts, grants, logicalCards, users } from "../src/db/schema.ts";
import { Secrets } from "../src/secrets.ts";
import { setup } from "./setup.ts";

const CARD = 1;
const OTHER_CARD = 2;

const onAccount = (role: Role): Grant => ({ logicalCardId: null, role });
const onCard = (role: Role, logicalCardId = CARD): Grant => ({ logicalCardId, role });

const accountActions = (...g: Grant[]) => {
  const access = resolveAccess(g);
  return ACCOUNT_PERMISSIONS.filter((p) => access.can(p));
};
const cardActions = (card: number, ...g: Grant[]) => {
  const access = resolveAccess(g);
  return CARD_PERMISSIONS.filter((p) => access.canOnCard(p, card));
};

describe("resolveAccess", () => {
  test("an owner of the account can do everything", () => {
    expect(accountActions(onAccount("owner"))).toEqual([...ACCOUNT_PERMISSIONS]);
    expect(cardActions(CARD, onAccount("owner"))).toEqual([...CARD_PERMISSIONS]);
  });

  test("an account manager works on every card, and on fees and categories, but not on grants, the token or names", () => {
    expect(accountActions(onAccount("manager"))).toEqual(["account.view", "fees.edit", "categories.manage"]);
    expect(cardActions(CARD, onAccount("manager"))).toEqual([...CARD_PERMISSIONS]);
  });

  test("an account member only sees", () => {
    expect(accountActions(onAccount("member"))).toEqual(["account.view"]);
    expect(cardActions(CARD, onAccount("member"))).toEqual(["card.view"]);
  });

  test.each(ROLES)("a %s of the account sees all cards, including ones with no grant", (role) => {
    const access = resolveAccess([onAccount(role)]);
    expect(access.seesAllCards).toBe(true);
    expect(access.canOnCard("card.view", 99)).toBe(true);
  });

  test("a card manager works on their card only, and the role's account actions don't apply", () => {
    const grant = onCard("manager");
    expect(cardActions(CARD, grant)).toEqual([...CARD_PERMISSIONS]);
    expect(cardActions(OTHER_CARD, grant)).toEqual([]);
    expect(accountActions(grant)).toEqual([]);
    const access = resolveAccess([grant]);
    expect(access.seesAllCards).toBe(false);
    expect(access.accountRole).toBeNull();
    expect(access.grantedCardIds).toEqual([CARD]);
    expect(access.canOnAnyCard("card.sync")).toBe(true);
  });

  test("a card member only sees their card", () => {
    const grant = onCard("member");
    expect(cardActions(CARD, grant)).toEqual(["card.view"]);
    expect(cardActions(OTHER_CARD, grant)).toEqual([]);
    expect(accountActions(grant)).toEqual([]);
    expect(resolveAccess([grant]).canOnAnyCard("card.sync")).toBe(false);
  });

  test("grants add up: an account member who manages one card can change that card and only see the rest", () => {
    const access = resolveAccess([onAccount("member"), onCard("manager")]);
    expect(access.seesAllCards).toBe(true);
    expect(access.canOnCard("card.adjust", CARD)).toBe(true);
    expect(access.canOnCard("card.adjust", OTHER_CARD)).toBe(false);
    expect(access.canOnCard("card.view", OTHER_CARD)).toBe(true);
    expect(access.can("fees.edit")).toBe(false);
  });

  test("a grant on a card never takes anything away from one on the account", () => {
    const access = resolveAccess([onAccount("owner"), onCard("member")]);
    expect(access.canOnCard("card.adjust", CARD)).toBe(true);
    expect(access.can("grants.manage")).toBe(true);
  });

  test("a user can hold different roles on different cards", () => {
    const access = resolveAccess([onCard("manager", CARD), onCard("member", OTHER_CARD)]);
    expect(access.canOnCard("card.annotate", CARD)).toBe(true);
    expect(access.canOnCard("card.annotate", OTHER_CARD)).toBe(false);
    expect(access.canOnCard("card.view", OTHER_CARD)).toBe(true);
  });
});

describe("grants in the database", () => {
  const SECRET = Buffer.alloc(32, 7).toString("base64");

  function world() {
    const s = setup();
    const addUser = (username: string) =>
      s.db.insert(users).values({ username, passwordHash: "x" }).returning().get().id;
    const addLogicalCard = (accountId = s.accountId) =>
      s.db.insert(logicalCards).values({ accountId, name: "card" }).returning().get().id;
    const other = addUser("other");
    const grantAccount = (role: Role, userId = other, accountId = s.accountId) =>
      s.db.insert(grants).values({ accountId, userId, role }).run();
    const grantCard = (logicalCardId: number, role: Role, userId = other, accountId = s.accountId) =>
      s.db.insert(grants).values({ accountId, logicalCardId, userId, role }).run();
    return { ...s, secrets: new Secrets(SECRET), other, addUser, addLogicalCard, grantAccount, grantCard };
  }

  test("no grant on an account means no access", () => {
    const s = world();
    expect(loadAccess(s.db, s.accountId, s.other)).toBeUndefined();
    expect(accountsOfUser(s.db, s.other)).toEqual([]);
  });

  test("a grant on a card gives access to the account, once, and limits what is seen to that card", () => {
    const s = world();
    const a = s.addLogicalCard();
    const b = s.addLogicalCard();
    s.grantCard(a, "manager");
    s.grantCard(b, "member");
    const access = loadAccess(s.db, s.accountId, s.other);
    expect(access?.seesAllCards).toBe(false);
    expect(access?.grantedCardIds.toSorted()).toEqual([a, b].toSorted());
    expect(accountsOfUser(s.db, s.other).map((x) => x.id)).toEqual([s.accountId]);
  });

  test("a grant on one account gives nothing on another", () => {
    const s = world();
    const second = s.addAccount("second");
    const a = s.addLogicalCard(second);
    s.grantCard(a, "manager", s.other, second);
    expect(loadAccess(s.db, s.accountId, s.other)).toBeUndefined();
    expect(loadAccess(s.db, second, s.other)?.grantedCardIds).toEqual([a]);
    expect(accountsOfUser(s.db, s.other).map((x) => x.id)).toEqual([second]);
  });

  test("grants on an account and on its card combine", () => {
    const s = world();
    const a = s.addLogicalCard();
    s.grantAccount("member");
    s.grantCard(a, "manager");
    const access = loadAccess(s.db, s.accountId, s.other);
    expect(access?.accountRole).toBe("member");
    expect(access?.canOnCard("card.adjust", a)).toBe(true);
    expect(accountsOfUser(s.db, s.other).map((x) => x.id)).toEqual([s.accountId]);
  });

  test("an account can have several owners", () => {
    const s = world();
    s.grantAccount("owner");
    expect(loadAccess(s.db, s.accountId, s.userId)?.accountRole).toBe("owner");
    expect(loadAccess(s.db, s.accountId, s.other)?.accountRole).toBe("owner");
  });

  test("the database refuses an owner of one card", () => {
    const s = world();
    expect(() => s.grantCard(s.addLogicalCard(), "owner")).toThrow(/CHECK/);
  });

  test("the database refuses a grant on another account's card", () => {
    const s = world();
    const theirs = s.addLogicalCard(s.addAccount("second"));
    expect(() => s.grantCard(theirs, "member")).toThrow(/FOREIGN KEY/);
  });

  test("the database allows one grant per user on the account, and one on each card", () => {
    const s = world();
    const a = s.addLogicalCard();
    const b = s.addLogicalCard();
    s.grantAccount("member");
    s.grantCard(a, "member");
    s.grantCard(b, "member");
    expect(() => s.grantAccount("manager")).toThrow(/UNIQUE/);
    expect(() => s.grantCard(a, "manager")).toThrow(/UNIQUE/);
  });

  test("a role this code doesn't know grants nothing", () => {
    const s = world();
    const a = s.addLogicalCard();
    s.grantAccount("auditor" as Role);
    s.grantCard(a, "auditor" as Role);
    expect(loadAccess(s.db, s.accountId, s.other)).toBeUndefined();
    expect(accountsOfUser(s.db, s.other)).toEqual([]);
  });

  test("creating an account makes its creator the owner", () => {
    const s = world();
    const id = createAccount(s.db, s.secrets, { userId: s.other, label: "mine", token: "token1abc" });
    expect(loadAccess(s.db, id, s.other)?.accountRole).toBe("owner");
    expect(loadAccess(s.db, id, s.userId)).toBeUndefined();
  });

  test("a token can only be added once, by anyone, and a refused one leaves nothing behind", () => {
    const s = world();
    createAccount(s.db, s.secrets, { userId: s.userId, label: "first", token: "token1abc" });
    const before = s.db.select().from(accounts).all().length;
    expect(() =>
      createAccount(s.db, s.secrets, { userId: s.other, label: "second", token: "token1abc" }),
    ).toThrow(/already been added/);
    expect(s.db.select().from(accounts).all()).toHaveLength(before);
    expect(accountsOfUser(s.db, s.other)).toEqual([]);
  });

  test("replacing a token copies the grants on the account but not those on its cards", () => {
    const s = world();
    const manager = s.addUser("manager");
    const old = createAccount(s.db, s.secrets, { userId: s.userId, label: "old", token: "token1old" });
    s.grantAccount("manager", manager, old);
    const card = s.addLogicalCard(old);
    s.grantCard(card, "manager", s.other, old);

    const id = replaceAccount(s.db, s.secrets, old, { token: "token1new" });

    expect(loadAccess(s.db, id, s.userId)?.accountRole).toBe("owner");
    expect(loadAccess(s.db, id, manager)?.accountRole).toBe("manager");
    expect(loadAccess(s.db, id, s.other)).toBeUndefined();
    // Everyone keeps what they had on the archived account.
    expect(loadAccess(s.db, old, s.userId)?.accountRole).toBe("owner");
    expect(loadAccess(s.db, old, manager)?.accountRole).toBe("manager");
    expect(loadAccess(s.db, old, s.other)?.grantedCardIds).toEqual([card]);
  });

  test("deleting a logical card, a user or an account removes their grants", () => {
    const s = world();
    const a = s.addLogicalCard();
    s.grantCard(a, "manager");
    s.db.delete(logicalCards).where(eq(logicalCards.id, a)).run();
    expect(loadAccess(s.db, s.accountId, s.other)).toBeUndefined();

    s.grantAccount("member");
    s.db.delete(users).where(eq(users.id, s.other)).run();
    expect(s.db.select().from(grants).where(eq(grants.userId, s.other)).all()).toEqual([]);

    s.db.delete(accounts).where(eq(accounts.id, s.accountId)).run();
    expect(s.db.select().from(grants).where(eq(grants.accountId, s.accountId)).all()).toEqual([]);
  });
});
