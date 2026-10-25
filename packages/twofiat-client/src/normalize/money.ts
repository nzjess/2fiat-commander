/** Exact decimal string to integer cents, rounding half away from zero past two places. "-71.350000" → -7135. */
export function parseCents(amount: string): number {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`not a decimal amount: ${amount}`);
  const [, sign, whole = "0", frac = ""] = m;
  const padded = frac.padEnd(3, "0");
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return sign === "-" ? -cents : cents;
}

export const dollarsToCents = (dollars: number): number => Math.round(dollars * 100);
