import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import {
  checkPassword,
  createSession,
  deleteSession,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  setDisplayCurrency,
  signUp,
} from "../auth.ts";
import { CURRENCIES } from "../fx.ts";
import { acceptInvite, findInvite, InvalidInviteError } from "../invites.ts";
import {
  ApiError,
  type AppDeps,
  invalid,
  requireUser,
  setSessionCookie,
  type UserEnv,
  Username,
} from "./common.ts";

const Login = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000) });
const NewPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(1000);
const SignUp = z.object({ username: Username, password: NewPassword });
const InviteToken = z.string().min(1).max(200);
const Settings = z.object({ displayCurrency: z.enum(CURRENCIES) });

export function authRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const signupEnabled = deps.signupEnabled ?? true;

  /** Starts a session for the user, ending the one this browser was in, if any. */
  const logIn = (c: Context, userId: number) => {
    const previous = getCookie(c, SESSION_COOKIE);
    if (previous) deleteSession(deps.db, previous);
    const session = createSession(deps.db, userId, now());
    setSessionCookie(c, session.token, session.expiresAt);
  };

  return (
    new Hono<UserEnv>()
      .post("/login", zValidator("json", Login, invalid), async (c) => {
        const { username, password } = c.req.valid("json");
        const user = await checkPassword(deps.db, username, password);
        if (!user) throw new ApiError(401, "invalid_credentials", "wrong username or password");
        logIn(c, user.id);
        return c.json({ user });
      })
      // What the login page offers, before anyone has logged in.
      .get("/options", (c) => c.json({ signupEnabled }))
      .post("/signup", zValidator("json", SignUp, invalid), async (c) => {
        if (!signupEnabled) throw new ApiError(403, "signup_disabled", "signing up is turned off here");
        const { username, password } = c.req.valid("json");
        const user = signUp(deps.db, username, await hashPassword(password));
        logIn(c, user.id);
        return c.json({ user }, 201);
      })
      // POST, so the token stays out of URLs and logs.
      .post("/invite/lookup", zValidator("json", z.object({ token: InviteToken }), invalid), (c) => {
        const invite = findInvite(deps.db, c.req.valid("json").token, now());
        if (!invite) throw new InvalidInviteError();
        return c.json({ username: invite.username });
      })
      .post(
        "/invite/accept",
        zValidator("json", z.object({ token: InviteToken, password: NewPassword }), invalid),
        async (c) => {
          const { token, password } = c.req.valid("json");
          // Looked at before the slow hash, and again by `acceptInvite`, which is what makes it single use.
          if (!findInvite(deps.db, token, now())) throw new InvalidInviteError();
          const user = acceptInvite(deps.db, token, await hashPassword(password), now());
          logIn(c, user.id);
          return c.json({ user });
        },
      )
      .post("/logout", (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token) deleteSession(deps.db, token);
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.body(null, 204);
      })
      .get("/me", requireUser(deps), (c) => c.json({ user: c.var.user }))
      .patch("/me", requireUser(deps), zValidator("json", Settings, invalid), (c) => {
        const { displayCurrency } = c.req.valid("json");
        setDisplayCurrency(deps.db, c.var.user.id, displayCurrency);
        return c.json({ user: { ...c.var.user, displayCurrency } });
      })
  );
}
