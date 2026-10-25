import type { z } from "zod";
import { TwoFiatError, TwoFiatSchemaError } from "./errors.ts";
import {
  RawCard,
  RawCardDetails,
  type RawOrder,
  RawOrderPage,
  type RawTransaction,
  RawTransactionPage,
} from "./raw/schemas.ts";
import type { Query, TwoFiatSession } from "./session.ts";

/** The server caps `take` at 500. */
export const MAX_PAGE_SIZE = 500;

export interface TransactionQuery {
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  to: string;
  /** Leave out for all of the account's cards. */
  cardId?: string;
  pageSize?: number;
}

export interface OrderQuery {
  /** Stop once orders are older than this ISO timestamp. Orders come newest first. */
  since?: string;
}

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Read-only access to one 2fiat account. Returns validated raw rows; interpretation is the normaliser's job. */
export class TwoFiatClient {
  readonly #session: TwoFiatSession;

  constructor(session: TwoFiatSession) {
    this.#session = session;
  }

  async listCards(): Promise<RawCard[]> {
    return this.#get("cards", {}, RawCard.array());
  }

  async getCardDetails(cardId: string): Promise<RawCardDetails> {
    return this.#get(`prepaid-cards/details/${encodeURIComponent(cardId)}`, {}, RawCardDetails);
  }

  /**
   * All transactions in a date range, deduped by id, in no particular order.
   *
   * Offset paging is unreliable here: rows sharing a `createdAt` come back in a different order on every request,
   * so consecutive pages can both repeat and skip rows. Instead, a window that fits in one page is fetched in one
   * request, and a larger window is split in half by date until it fits.
   */
  async fetchTransactions(query: TransactionQuery): Promise<RawTransaction[]> {
    const take = Math.min(query.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const byId = new Map<string, RawTransaction>();
    const fetchWindow = async (from: string, to: string): Promise<void> => {
      const page = await this.#transactionPage(from, to, query.cardId, 0, take);
      if (page.data.length >= page.totalCount) {
        for (const tx of page.data) byId.set(tx.id, tx);
      } else if (from < to) {
        const mid = addDays(from, Math.floor(daysBetween(from, to) / 2));
        await fetchWindow(from, mid);
        await fetchWindow(addDays(mid, 1), to);
      } else {
        for (const tx of await this.#fetchBusyDay(from, query.cardId, take, page.totalCount))
          byId.set(tx.id, tx);
      }
    };
    await fetchWindow(query.from, query.to);
    return [...byId.values()];
  }

  /** A single day with more rows than a page can only be offset-paged, so re-page until every row has been seen. */
  async #fetchBusyDay(day: string, cardId: string | undefined, take: number, total: number) {
    const byId = new Map<string, RawTransaction>();
    for (let attempt = 0; attempt < 5 && byId.size < total; attempt++) {
      for (let skip = 0; skip < total; skip += take) {
        const page = await this.#transactionPage(day, day, cardId, skip, take);
        for (const tx of page.data) byId.set(tx.id, tx);
        total = Math.max(total, page.totalCount);
      }
    }
    if (byId.size < total) throw new TwoFiatError(`saw only ${byId.size} of ${total} transactions on ${day}`);
    return byId.values();
  }

  #transactionPage(from: string, to: string, cardId: string | undefined, skip: number, take: number) {
    return this.#get(
      "vccTransactions",
      { skip, take, dateFrom: from, dateTo: to, cardId },
      RawTransactionPage,
    );
  }

  async fetchOrders(query: OrderQuery = {}): Promise<RawOrder[]> {
    const since = query.since ? Date.parse(query.since) : undefined;
    const byId = new Map<string, RawOrder>();
    for (let page = 1; ; page++) {
      const res = await this.#get("orders", { page }, RawOrderPage);
      let reachedSince = false;
      for (const order of res.orders) {
        if (since !== undefined && Date.parse(order.createdAt) < since) reachedSince = true;
        else if (!byId.has(order.id)) byId.set(order.id, order);
      }
      if (reachedSince || res.orders.length === 0 || res.orders.length < res.limit) break;
    }
    return [...byId.values()];
  }

  async #get<S extends z.ZodType>(path: string, query: Query, schema: S): Promise<z.output<S>> {
    const json = await this.#session.get(path, query);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new TwoFiatSchemaError(path, parsed.error);
    return parsed.data;
  }
}
