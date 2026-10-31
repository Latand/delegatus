import { AccountMutationBusyError } from "./accountMutation";

/** These refusals occur before admission or after the removal restored its
 * home and registry. Uncertain commits and other failures are never replayed. */
export async function withRemovalContentionRetry<T>(remove: () => T): Promise<T> {
  const delays = [100, 300, 750];
  for (let attempt = 0; ; attempt++) {
    try { return remove(); }
    catch (error) {
      const safeBusy = error instanceof AccountMutationBusyError
        || error instanceof Error && error.message === "the agent registry is busy; nothing was removed, try the removal again";
      if (!safeBusy) throw error;
      if (attempt >= delays.length) throw new AccountMutationBusyError();
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
