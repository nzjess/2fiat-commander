import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { checkPassword, createSession, deleteSession, SESSION_COOKIE } from "../auth.ts";
import { ApiError, type AppDeps, invalid, requireUser, setSessionCookie, type UserEnv } from "./common.ts";

const Login = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000) });

export function authRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  return new Hono<UserEnv>()
    .post("/login", zValidator("json", Login, invalid), async (c) => {
      const { username, password } = c.req.valid("json");
      const user = await checkPassword(deps.db, username, password);
      if (!user) throw new ApiError(401, "invalid_credentials", "wrong username or password");
      const session = createSession(deps.db, user.id, now());
      setSessionCookie(c, session.token, session.expiresAt);
      return c.json({ user });
    })
    .post("/logout", (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) deleteSession(deps.db, token);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.body(null, 204);
    })
    .get("/me", requireUser(deps), (c) => c.json({ user: c.var.user }));
}
