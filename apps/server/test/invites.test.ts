import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createAccount } from "../src/accounts.ts";
import { createApp } from "../src/app.ts";
import { createUser, hashPassword, setPassword } from "../src/auth.ts";
import { openDb } from "../src/db/db.ts";
import { grants, invites, logicalCards, users } from "../src/db/schema.ts";
import { INVITE_TTL_MS } from "../src/invites.ts";
import { Secrets } from "../src/secrets.ts";
import { SyncRunner } from "../src/sync.ts";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new password";

async function world(options: { signupEnabled?: boolean } = {}) {
  const db = openDb(":memory:");
  const secrets = new Secrets(Buffer.alloc(32, 7).toString("base64"));
  const clock = { now: new Date("2026-10-20T12:00:00.000Z") };
  const runner = new SyncRunner({ db, secrets, now: () => clock.now });
  const app = createApp({ db, secrets, runner, now: () => clock.now, ...options });
  const hashed = await hashPassword(PASSWORD);
  const ownerId = createUser(db, "owner", hashed);
  const otherOwnerId = createUser(db, "other", hashed);
  const accountId = createAccount(db, secrets, { userId: ownerId, label: "main", token: "token1abc123" });
  const otherAccountId = createAccount(db, secrets, {
    userId: otherOwnerId,
    label: "theirs",
    token: "token1def456",
  });
  return { db, clock, app, ownerId, otherOwnerId, accountId, otherAccountId };
}
type World = Awaited<ReturnType<typeof world>>;

/** A browser: keeps its cookie between requests. */
function browser(w: World) {
  let cookie = "";
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await w.app.request(`/api${path}`, {
      method,
      headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    return res;
  };
  return {
    request,
    cookie: () => cookie,
    useCookie: (value: string) => {
      cookie = value;
    },
    logIn: (username: string, password = PASSWORD) => request("POST", "/auth/login", { username, password }),
    onAccount: (accountId: number, method: string, path: string, body?: unknown) =>
      request(method, `/accounts/${accountId}${path}`, body),
  };
}

async function ownerBrowser(w: World) {
  const b = browser(w);
  expect((await b.logIn("owner")).status).toBe(200);
  return b;
}

const WHOLE = { logicalCardId: null, role: "member" };

async function invite(w: World, username = "newbie", place: object = WHOLE) {
  const owner = await ownerBrowser(w);
  const res = await owner.onAccount(w.accountId, "POST", "/invites", { username, ...place });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as {
    grant: { id: number; userId: number; username: string; pending: boolean };
    token: string;
    expiresAt: string;
  };
  return { owner, ...body };
}

describe("signing up", () => {
  test("creates a user with no accounts, logged in, who can log in again later", async () => {
    const w = await world();
    const b = browser(w);
    const res = await b.request("POST", "/auth/signup", { username: " sam ", password: NEW_PASSWORD });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ user: { username: "sam" } });
    expect((await b.request("GET", "/auth/me")).status).toBe(200);
    expect(await (await b.request("GET", "/accounts")).json()).toEqual([]);
    expect((await browser(w).logIn("sam", NEW_PASSWORD)).status).toBe(200);
  });

  test("stores only a hash of the password", async () => {
    const w = await world();
    const b = browser(w);
    await b.request("POST", "/auth/signup", { username: "sam", password: NEW_PASSWORD });
    const row = w.db.select().from(users).where(eq(users.username, "sam")).get();
    expect(row?.passwordHash).not.toBe(NEW_PASSWORD);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  test("needs 12 characters and a free username", async () => {
    const w = await world();
    const b = browser(w);
    const short = await b.request("POST", "/auth/signup", { username: "sam", password: "elevenchars" });
    expect(short.status).toBe(400);
    const taken = await b.request("POST", "/auth/signup", { username: "owner", password: NEW_PASSWORD });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "username_taken" });
    expect((await browser(w).logIn("owner")).status).toBe(200);
  });

  test("replaces the session this browser was in", async () => {
    const w = await world();
    const b = await ownerBrowser(w);
    const before = b.cookie();
    await b.request("POST", "/auth/signup", { username: "sam", password: NEW_PASSWORD });
    const old = browser(w);
    old.useCookie(before);
    expect((await old.request("GET", "/auth/me")).status).toBe(401);
  });

  test("can be turned off, which the login page can find out", async () => {
    const on = await world();
    expect(await (await browser(on).request("GET", "/auth/options")).json()).toEqual({ signupEnabled: true });

    const w = await world({ signupEnabled: false });
    const b = browser(w);
    expect(await (await b.request("GET", "/auth/options")).json()).toEqual({ signupEnabled: false });
    const res = await b.request("POST", "/auth/signup", { username: "sam", password: NEW_PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "signup_disabled" });
    expect(w.db.select().from(users).where(eq(users.username, "sam")).get()).toBeUndefined();
  });
});

describe("usernames", () => {
  test("keep the case they were typed in, and log in in any case", async () => {
    const w = await world();
    const res = await browser(w).request("POST", "/auth/signup", { username: "Sam", password: NEW_PASSWORD });
    expect(await res.json()).toMatchObject({ user: { username: "Sam" } });
    for (const username of ["Sam", "sam", "SAM"]) {
      const login = await browser(w).logIn(username, NEW_PASSWORD);
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ user: { username: "Sam" } });
    }
  });

  test("differing only by case are taken, however they're created", async () => {
    const w = await world();
    const signup = await browser(w).request("POST", "/auth/signup", {
      username: "OWNER",
      password: NEW_PASSWORD,
    });
    expect(signup.status).toBe(409);
    expect(() => createUser(w.db, "Other", "x")).toThrow(/UNIQUE/);
    const owner = await ownerBrowser(w);
    const res = await owner.onAccount(w.accountId, "POST", "/invites", { username: "OTHER", ...WHOLE });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "username_taken" });
  });

  test("are found in any case when adding someone, shown as they are", async () => {
    const w = await world();
    const owner = await ownerBrowser(w);
    const res = await owner.onAccount(w.accountId, "POST", "/grants", { username: "OTHER", ...WHOLE });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ username: "other" });
  });

  test("are found in any case from the command line", async () => {
    const w = await world();
    const { grant } = await invite(w, "NewBie");
    expect(grant.username).toBe("NewBie");
    expect(setPassword(w.db, "NEWBIE", await hashPassword(NEW_PASSWORD))).toBe(true);
    expect((await browser(w).logIn("newbie", NEW_PASSWORD)).status).toBe(200);
    expect(setPassword(w.db, "nobody", "x")).toBe(false);
  });

  test("sort ignoring case in the list", async () => {
    const w = await world();
    const { owner } = await invite(w, "Zed");
    await owner.onAccount(w.accountId, "POST", "/invites", { username: "amy", ...WHOLE });
    await owner.onAccount(w.accountId, "POST", "/invites", { username: "Bob", ...WHOLE });
    const list = (await (await owner.onAccount(w.accountId, "GET", "/grants")).json()) as {
      username: string;
    }[];
    expect(list.map((g) => g.username)).toEqual(["amy", "Bob", "owner", "Zed"]);
  });

  test.each(["Zoë", "two words", "me@example.com", "a/b", "   "])("can't be %j", async (username) => {
    const w = await world();
    const signup = await browser(w).request("POST", "/auth/signup", { username, password: NEW_PASSWORD });
    expect(signup.status).toBe(400);
    const owner = await ownerBrowser(w);
    const place = { username, ...WHOLE };
    expect((await owner.onAccount(w.accountId, "POST", "/invites", place)).status).toBe(400);
    expect((await owner.onAccount(w.accountId, "POST", "/grants", place)).status).toBe(400);
  });

  test("can have letters, digits, dots, underscores and hyphens", async () => {
    const w = await world();
    const res = await browser(w).request("POST", "/auth/signup", {
      username: " Ada.L_2-x ",
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ user: { username: "Ada.L_2-x" } });
  });

  test("a login with one that couldn't exist just fails", async () => {
    const w = await world();
    expect((await browser(w).logIn("Zoë")).status).toBe(401);
  });

  test.each(["Zoë", "me@example.com", ""])("the database refuses %j too", async (username) => {
    const w = await world();
    expect(() => w.db.insert(users).values({ username, passwordHash: "x" }).run()).toThrow(/CHECK/);
  });
});

describe("inviting", () => {
  test("creates a user with no password and the grant, and stores only the token's hash", async () => {
    const w = await world();
    const { token, expiresAt, grant } = await invite(w);
    expect(grant).toMatchObject({ username: "newbie", pending: true, role: "member" });
    expect(new Date(expiresAt).getTime()).toBe(w.clock.now.getTime() + INVITE_TTL_MS);
    const user = w.db.select().from(users).where(eq(users.username, "newbie")).get();
    expect(user?.passwordHash).toBeNull();
    const stored = w.db.select().from(invites).get();
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).not.toBe(token);
  });

  test("can be on one card, and shows who's pending in the list", async () => {
    const w = await world();
    const card = w.db
      .insert(logicalCards)
      .values({ accountId: w.accountId, name: "Family" })
      .returning()
      .get();
    const { owner } = await invite(w, "newbie", { logicalCardId: card.id, role: "manager" });
    const list = (await (await owner.onAccount(w.accountId, "GET", "/grants")).json()) as {
      username: string;
      pending: boolean;
      logicalCardId: number | null;
    }[];
    expect(list.find((g) => g.username === "newbie")).toMatchObject({
      pending: true,
      logicalCardId: card.id,
    });
    expect(list.find((g) => g.username === "owner")).toMatchObject({ pending: false });
    expect(JSON.stringify(list)).not.toContain("passwordHash");
  });

  test("refuses what adding someone refuses, creating nobody", async () => {
    const w = await world();
    const owner = await ownerBrowser(w);
    const post = (body: object) => owner.onAccount(w.accountId, "POST", "/invites", body);
    const taken = await post({ username: "other", ...WHOLE });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "username_taken" });
    const foreign = w.db
      .insert(logicalCards)
      .values({ accountId: w.otherAccountId, name: "Theirs" })
      .returning()
      .get();
    expect((await post({ username: "newbie", logicalCardId: foreign.id, role: "member" })).status).toBe(400);
    const own = w.db.insert(logicalCards).values({ accountId: w.accountId, name: "Mine" }).returning().get();
    expect((await post({ username: "newbie", logicalCardId: own.id, role: "owner" })).status).toBe(400);
    expect(w.db.select().from(users).where(eq(users.username, "newbie")).get()).toBeUndefined();
  });
});

describe("someone invited, before accepting", () => {
  test("can't log in, whatever password they try, with the usual error", async () => {
    const w = await world();
    await invite(w);
    for (const password of [PASSWORD, "", "x"]) {
      const res = await browser(w).request("POST", "/auth/login", { username: "newbie", password });
      expect(res.status).toBe(password === "" ? 400 : 401);
    }
    const res = await browser(w).logIn("newbie");
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
  });

  test("doesn't count as an owner who could keep the account", async () => {
    const w = await world();
    const { owner, grant } = await invite(w, "newbie", { logicalCardId: null, role: "owner" });
    const mine = w.db
      .select()
      .from(grants)
      .where(and(eq(grants.userId, w.ownerId), eq(grants.accountId, w.accountId)))
      .get();
    const refused = await owner.onAccount(w.accountId, "DELETE", `/grants/${mine?.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "last_owner" });
    // The pending owner's own grant can go, as the real owner stays.
    expect(
      (await owner.onAccount(w.accountId, "PATCH", `/grants/${grant.id}`, { role: "member" })).status,
    ).toBe(200);
  });

  test("once they accept, they do count", async () => {
    const w = await world();
    const { owner, token } = await invite(w, "newbie", { logicalCardId: null, role: "owner" });
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    const mine = w.db
      .select()
      .from(grants)
      .where(and(eq(grants.userId, w.ownerId), eq(grants.accountId, w.accountId)))
      .get();
    expect((await owner.onAccount(w.accountId, "DELETE", `/grants/${mine?.id}`)).status).toBe(204);
  });

  test("losing their last grant deletes them and ends the link", async () => {
    const w = await world();
    const { owner, grant, token } = await invite(w);
    expect((await owner.onAccount(w.accountId, "DELETE", `/grants/${grant.id}`)).status).toBe(204);
    expect(w.db.select().from(users).where(eq(users.username, "newbie")).get()).toBeUndefined();
    expect(w.db.select().from(invites).all()).toEqual([]);
    expect((await browser(w).request("POST", "/auth/invite/lookup", { token })).status).toBe(404);
    // The name is free again.
    expect(
      (await owner.onAccount(w.accountId, "POST", "/invites", { username: "newbie", ...WHOLE })).status,
    ).toBe(201);
  });

  test("losing one of two grants keeps them", async () => {
    const w = await world();
    const card = w.db
      .insert(logicalCards)
      .values({ accountId: w.accountId, name: "Family" })
      .returning()
      .get();
    const { owner, grant } = await invite(w);
    await owner.onAccount(w.accountId, "POST", "/grants", {
      username: "newbie",
      logicalCardId: card.id,
      role: "member",
    });
    expect((await owner.onAccount(w.accountId, "DELETE", `/grants/${grant.id}`)).status).toBe(204);
    expect(w.db.select().from(users).where(eq(users.username, "newbie")).get()).toBeDefined();
  });

  test("removing an active user's last grant keeps the user", async () => {
    const w = await world();
    const { owner, token, grant } = await invite(w);
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    expect((await owner.onAccount(w.accountId, "DELETE", `/grants/${grant.id}`)).status).toBe(204);
    expect((await browser(w).logIn("newbie", NEW_PASSWORD)).status).toBe(200);
  });

  test("a password set from the command line ends the link", async () => {
    const w = await world();
    const { token } = await invite(w);
    setPassword(w.db, "newbie", await hashPassword(NEW_PASSWORD));
    expect((await browser(w).request("POST", "/auth/invite/lookup", { token })).status).toBe(404);
    expect((await browser(w).logIn("newbie", NEW_PASSWORD)).status).toBe(200);
  });
});

describe("accepting", () => {
  test("the link names who it's for, without logging anyone in", async () => {
    const w = await world();
    const { token } = await invite(w);
    const b = browser(w);
    const res = await b.request("POST", "/auth/invite/lookup", { token });
    expect(await res.json()).toEqual({ username: "newbie" });
    expect((await b.request("GET", "/auth/me")).status).toBe(401);
  });

  test("sets the password and logs in, with the access they were invited with", async () => {
    const w = await world();
    const { token } = await invite(w);
    const b = browser(w);
    const res = await b.request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { username: "newbie" } });
    const accounts = (await (await b.request("GET", "/accounts")).json()) as {
      id: number;
      access: { accountRole: string };
    }[];
    expect(accounts).toMatchObject([{ id: w.accountId, access: { accountRole: "member" } }]);
    expect((await browser(w).logIn("newbie", NEW_PASSWORD)).status).toBe(200);
  });

  test("works only once", async () => {
    const w = await world();
    const { token } = await invite(w);
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    const again = await browser(w).request("POST", "/auth/invite/accept", {
      token,
      password: "someone else's!",
    });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: "invalid_invite" });
    expect((await browser(w).logIn("newbie", NEW_PASSWORD)).status).toBe(200);
  });

  test("of two tries at once, one gets through", async () => {
    const w = await world();
    const { token } = await invite(w);
    const statuses = await Promise.all(
      ["first password here", "second password here"].map(async (password) => {
        const res = await browser(w).request("POST", "/auth/invite/accept", { token, password });
        return res.status;
      }),
    );
    expect(statuses.toSorted()).toEqual([200, 404]);
  });

  test("a short password is refused and leaves the link working", async () => {
    const w = await world();
    const { token } = await invite(w);
    const b = browser(w);
    expect((await b.request("POST", "/auth/invite/accept", { token, password: "elevenchars" })).status).toBe(
      400,
    );
    expect((await b.request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD })).status).toBe(
      200,
    );
  });

  test("a link expires", async () => {
    const w = await world();
    const { token } = await invite(w);
    w.clock.now = new Date(w.clock.now.getTime() + INVITE_TTL_MS);
    const b = browser(w);
    expect((await b.request("POST", "/auth/invite/lookup", { token })).status).toBe(404);
    expect((await b.request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD })).status).toBe(
      404,
    );
  });

  test("an unknown token gets the same answer", async () => {
    const w = await world();
    const res = await browser(w).request("POST", "/auth/invite/lookup", { token: "nonsense" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "invalid_invite" });
  });

  test("replaces the session this browser was in", async () => {
    const w = await world();
    const { token, owner } = await invite(w);
    const before = owner.cookie();
    const res = await owner.request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(await (await owner.request("GET", "/auth/me")).json()).toMatchObject({
      user: { username: "newbie" },
    });
    const old = browser(w);
    old.useCookie(before);
    expect((await old.request("GET", "/auth/me")).status).toBe(401);
  });
});

describe("a new link", () => {
  const renew = (b: ReturnType<typeof browser>, accountId: number, userId: number) =>
    b.onAccount(accountId, "POST", `/invites/${userId}`);

  test("replaces the old one, which stops working", async () => {
    const w = await world();
    const { owner, grant, token } = await invite(w);
    const res = await renew(owner, w.accountId, grant.userId);
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as { token: string };
    expect(fresh.token).not.toBe(token);
    const b = browser(w);
    expect((await b.request("POST", "/auth/invite/lookup", { token })).status).toBe(404);
    expect(await (await b.request("POST", "/auth/invite/lookup", { token: fresh.token })).json()).toEqual({
      username: "newbie",
    });
  });

  test("brings back an expired one", async () => {
    const w = await world();
    const { owner, grant } = await invite(w);
    w.clock.now = new Date(w.clock.now.getTime() + INVITE_TTL_MS * 2);
    // The owner's session outlives this, as it does in the app.
    const res = await renew(owner, w.accountId, grant.userId);
    const { token } = (await res.json()) as { token: string };
    expect((await browser(w).request("POST", "/auth/invite/lookup", { token })).status).toBe(200);
  });

  test("can't take over someone who has set a password", async () => {
    const w = await world();
    const { owner, grant, token } = await invite(w);
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    const res = await renew(owner, w.accountId, grant.userId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
    // Nor a co-owner who was never invited.
    w.db.insert(grants).values({ accountId: w.accountId, userId: w.otherOwnerId, role: "owner" }).run();
    expect((await renew(owner, w.accountId, w.otherOwnerId)).status).toBe(409);
  });

  test("is only for someone with a grant here", async () => {
    const w = await world();
    const { grant } = await invite(w);
    const other = browser(w);
    await other.logIn("other");
    expect((await renew(other, w.otherAccountId, grant.userId)).status).toBe(404);
  });
});

describe("the owner of another account", () => {
  async function asOther(w: World) {
    const other = browser(w);
    expect((await other.logIn("other")).status).toBe(200);
    return other;
  }

  test("can't add someone pending elsewhere: to them, there's no such user", async () => {
    const w = await world();
    await invite(w);
    const other = await asOther(w);
    const res = await other.onAccount(w.otherAccountId, "POST", "/grants", { username: "newbie", ...WHOLE });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_user" });
    expect(w.db.select().from(grants).where(eq(grants.accountId, w.otherAccountId)).all()).toHaveLength(1);
  });

  test("can't make a link for them, even if they somehow hold a grant there", async () => {
    const w = await world();
    const { grant, token } = await invite(w);
    w.db.insert(grants).values({ accountId: w.otherAccountId, userId: grant.userId, role: "member" }).run();
    const other = await asOther(w);
    const res = await other.onAccount(w.otherAccountId, "POST", `/invites/${grant.userId}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pending" });
    expect(await (await browser(w).request("POST", "/auth/invite/lookup", { token })).json()).toEqual({
      username: "newbie",
    });
  });

  test("can add someone once they've accepted", async () => {
    const w = await world();
    const { token } = await invite(w);
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    const other = await asOther(w);
    const res = await other.onAccount(w.otherAccountId, "POST", "/grants", { username: "newbie", ...WHOLE });
    expect(res.status).toBe(201);
  });

  test("the list says who a link can be made for, as the owner asking", async () => {
    const w = await world();
    const { owner, grant } = await invite(w);
    const canMakeLink = async (b: ReturnType<typeof browser>, accountId: number) => {
      const list = (await (await b.onAccount(accountId, "GET", "/grants")).json()) as {
        userId: number;
        canMakeLink: boolean;
      }[];
      return list.find((g) => g.userId === grant.userId)?.canMakeLink;
    };
    expect(await canMakeLink(owner, w.accountId)).toBe(true);

    // Also on the other account: neither owner owns both, and each is refused if they try.
    w.db.insert(grants).values({ accountId: w.otherAccountId, userId: grant.userId, role: "member" }).run();
    const other = await asOther(w);
    expect(await canMakeLink(owner, w.accountId)).toBe(false);
    expect(await canMakeLink(other, w.otherAccountId)).toBe(false);
    expect((await owner.onAccount(w.accountId, "POST", `/invites/${grant.userId}`)).status).toBe(409);

    // Owning both, it's there again.
    w.db.insert(grants).values({ accountId: w.otherAccountId, userId: w.ownerId, role: "owner" }).run();
    expect(await canMakeLink(owner, w.accountId)).toBe(true);
    expect((await owner.onAccount(w.accountId, "POST", `/invites/${grant.userId}`)).status).toBe(200);
  });

  test("the list offers no link for someone who has set a password", async () => {
    const w = await world();
    const { owner, grant, token } = await invite(w);
    await browser(w).request("POST", "/auth/invite/accept", { token, password: NEW_PASSWORD });
    const list = (await (await owner.onAccount(w.accountId, "GET", "/grants")).json()) as {
      userId: number;
      canMakeLink: boolean;
    }[];
    expect(list.find((g) => g.userId === grant.userId)?.canMakeLink).toBe(false);
  });

  test("who owns both can add and make links", async () => {
    const w = await world();
    const { owner, grant } = await invite(w);
    w.db.insert(grants).values({ accountId: w.otherAccountId, userId: w.ownerId, role: "owner" }).run();
    const res = await owner.onAccount(w.otherAccountId, "POST", "/grants", { username: "newbie", ...WHOLE });
    expect(res.status).toBe(201);
    expect((await owner.onAccount(w.otherAccountId, "POST", `/invites/${grant.userId}`)).status).toBe(200);
  });
});
