// Saves an account's raw API data under captures/<timestamp>/ (gitignored) for local tests and analysis.
// Usage: pnpm capture   (reads TWOFIAT_TOKEN from .env)
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TwoFiatClient, TwoFiatSession } from "../src/index.ts";

const token = process.env.TWOFIAT_TOKEN;
if (!token) {
  console.error("TWOFIAT_TOKEN is not set");
  process.exit(2);
}

const client = new TwoFiatClient(new TwoFiatSession({ token }));
const today = new Date().toISOString().slice(0, 10);
const dir = join(import.meta.dirname, "../../../captures", new Date().toISOString().replaceAll(":", "-"));
await mkdir(dir, { recursive: true });

const save = (name: string, data: unknown) =>
  writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);

const cards = await client.listCards();
const details = await Promise.all(cards.map((c) => client.getCardDetails(c.id)));
const transactions = await client.fetchTransactions({ from: "2020-01-01", to: today });
const orders = await client.fetchOrders();

await save("cards.json", cards);
await save("card-details.json", details);
await save("transactions.json", transactions);
await save("orders.json", orders);
console.log(`${cards.length} cards, ${transactions.length} transactions, ${orders.length} orders -> ${dir}`);
