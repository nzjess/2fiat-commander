import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { accountRoutes, accountScopedRoutes } from "./api/accounts.ts";
import { activityRoutes } from "./api/activities.ts";
import { adjustmentRoutes } from "./api/adjustments.ts";
import { authRoutes } from "./api/auth.ts";
import { cardRoutes } from "./api/cards.ts";
import { categoryRoutes } from "./api/categories.ts";
import { type AppDeps, handleError, loadAccount, requireUser } from "./api/common.ts";
import { feeScheduleRoutes } from "./api/feeSchedules.ts";
import { findingRoutes } from "./api/findings.ts";
import { fxRoutes } from "./api/fx.ts";

export type { AppDeps } from "./api/common.ts";

/**
 * The HTTP API, under `/api`. Everything but `/health` and `/auth/login` needs a session, and everything under
 * `/accounts/:accountId` needs that account to be the user's.
 */
export function createApp(deps: AppDeps) {
  return (
    new Hono()
      .basePath("/api")
      .onError(handleError)
      // Rejects cross-origin form-style requests. Our JSON ones can't be sent cross-origin without CORS.
      .use(csrf())
      .get("/health", (c) => c.json({ ok: true }))
      .route("/auth", authRoutes(deps))
      .route("/fx", fxRoutes(deps))
      .use("/categories/*", requireUser(deps))
      .route("/categories", categoryRoutes(deps))
      .use("/accounts/*", requireUser(deps))
      .route("/accounts", accountRoutes(deps))
      .use("/accounts/:accountId/*", loadAccount(deps))
      .route("/accounts/:accountId", accountScopedRoutes(deps))
      .route("/accounts/:accountId", cardRoutes(deps))
      .route("/accounts/:accountId", activityRoutes(deps))
      .route("/accounts/:accountId", findingRoutes(deps))
      .route("/accounts/:accountId", adjustmentRoutes(deps))
      .route("/accounts/:accountId", feeScheduleRoutes(deps))
  );
}

export type App = ReturnType<typeof createApp>;
