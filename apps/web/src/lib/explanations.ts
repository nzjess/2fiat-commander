import type { Finding } from "../api.ts";
import { formatMoney } from "./format.ts";

/** A month scope like "2026-10" as "October 2026"; undefined if it isn't one. */
export function monthLabel(scope: string | null): string | undefined {
  const match = scope && /^(\d{4})-(\d{2})$/.exec(scope);
  if (!match) return undefined;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * An explanation to start from when explaining a finding, where its kind and figures make one likely: the user edits
 * it before saving. Undefined where there's no good guess (e.g. anything charged more than accepted).
 */
export function suggestExplanation(finding: Pick<Finding, "kind" | "cents" | "scope">): string | undefined {
  const less = finding.cents !== null && finding.cents > 0 ? formatMoney(finding.cents) : undefined;
  switch (finding.kind) {
    case "transaction-fees-off-schedule": {
      const month = monthLabel(finding.scope);
      return less && month
        ? `2fiat charged ${less} less in fees in ${month} than the accepted schedule: a few fees were never charged. In my favour.`
        : undefined;
    }
    case "topup-fee-off-schedule":
      return less && `2fiat charged ${less} less than the accepted rate on this top-up. In my favour.`;
    case "history-incomplete":
      return "Card moved over from an earlier token: its history before that isn't visible.";
    case "stale-authorization":
      return "A hold the merchant never collected.";
    case "fees-above-advertised":
    case "topup-fee-above-advertised":
      return "2fiat charges more than it advertises.";
    default:
      return undefined;
  }
}
