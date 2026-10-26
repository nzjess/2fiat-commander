// The last account the user looked at, so `/` can return to it. Browser storage can be unavailable (private
// windows, blocked site data), so this only ever helps and never fails.

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
