import { Hono } from "hono";
import { CURRENCIES, latestRateDay, usdRates } from "../fx.ts";
import { type AppDeps, requireUser, type UserEnv } from "./common.ts";

export function fxRoutes(deps: AppDeps) {
  return new Hono<UserEnv>().get("/", requireUser(deps), (c) => {
    const currency = c.var.user.displayCurrency;
    return c.json({
      currencies: [...CURRENCIES],
      currency,
      /** USD→`currency` per ECB working day, oldest first; empty for USD. */
      rates: usdRates(deps.db, currency),
      latestDay: latestRateDay(deps.db),
    });
  });
}
