import type { Account, Grant } from "../api.ts";

export type AccountAccess = Account["access"];
export type AccountPermission = AccountAccess["account"][number];
export type CardPermission = AccountAccess["everyCard"][number];
export type Role = Grant["role"];

/** What the user may do on an account, as the server worked it out. The server still checks every request. */
export function accessOf(access: AccountAccess) {
  return {
    can: (permission: AccountPermission) => access.account.includes(permission),
    canOnCard: (permission: CardPermission, logicalCardId: number) =>
      access.everyCard.includes(permission) ||
      access.cards.some((c) => c.logicalCardId === logicalCardId && c.permissions.includes(permission)),
    canOnAnyCard: (permission: CardPermission) =>
      access.everyCard.includes(permission) || access.cards.some((c) => c.permissions.includes(permission)),
  };
}

/** A role as the UI names it. On a card, a stored `manager` reads "Card owner". */
export function roleLabel(role: Role, onCard: boolean): string {
  if (onCard) return role === "member" ? "Card member" : "Card owner";
  return { owner: "Owner", manager: "Manager", member: "Member" }[role];
}

/** The roles that can be given on the whole account or on a card, with what they're called. */
export const roleOptions = (onCard: boolean) =>
  (onCard ? (["manager", "member"] as const) : (["owner", "manager", "member"] as const)).map((role) => ({
    value: role,
    label: roleLabel(role, onCard),
  }));

/** The user's own access to an account, in a few words: their role on it, else on its cards. */
export function accessLabel(access: AccountAccess): string {
  if (access.accountRole !== null) return roleLabel(access.accountRole, false);
  return [...new Set(access.cards.map((c) => roleLabel(c.role, true)))].join(", ");
}

/**
 * Who'd start seeing more if two logical cards became one: those with a grant on just one of them, whose grant then
 * covers both. Anyone with a grant on the whole account sees both already.
 */
export function linkGains(
  grants: Pick<Grant, "username" | "logicalCardId">[],
  a: number,
  b: number,
): string[] {
  const on = (logicalCardId: number | null) =>
    new Set(grants.filter((g) => g.logicalCardId === logicalCardId).map((g) => g.username));
  const whole = on(null);
  const onA = on(a);
  const onB = on(b);
  return [...new Set([...onA, ...onB])]
    .filter((username) => !whole.has(username) && onA.has(username) !== onB.has(username))
    .sort();
}
