// The last account the user looked at, so `/` can return to it, and the last card they chose in each account, so
// the sidebar's card pages stay on it from pages without a card (the overview, accounts, settings). Browser storage can be unavailable (private windows, blocked site
// data), so this only ever helps and never fails.

const LAST_ACCOUNT = "commander.lastAccountId";

export function getLastAccount(): string | undefined {
  try {
    return localStorage.getItem(LAST_ACCOUNT) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setLastAccount(accountId: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT, accountId);
  } catch {
    // Not remembered, then.
  }
}

const lastCardKey = (accountId: string) => `commander.lastCardId.${accountId}`;

export function getLastCard(accountId: string): number | undefined {
  try {
    const id = Number(localStorage.getItem(lastCardKey(accountId)));
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function setLastCard(accountId: string, logicalCardId: number): void {
  try {
    localStorage.setItem(lastCardKey(accountId), String(logicalCardId));
  } catch {
    // Not remembered, then.
  }
}

/** The card to go to when the URL names none: the last one chosen, if it still exists, else the first. */
export function defaultCard(accountId: string, logicalCards: readonly { id: number }[]): number | undefined {
  const last = getLastCard(accountId);
  return logicalCards.some((l) => l.id === last) ? last : logicalCards[0]?.id;
}
