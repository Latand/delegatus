/** Shared by browser projections and server retry classifiers; no state reads. */
export const ACCOUNT_STORE_BUSY_MESSAGE = "The account store is temporarily busy; try again shortly.";

/** Includes old persisted reasons and wrappers around either wording. */
export function isAccountMutationContention(failure: string): boolean {
  return failure.includes(ACCOUNT_STORE_BUSY_MESSAGE) || /account (mutation is|store stayed) busy/.test(failure);
}
