import type { AsyncLocalStorage } from "node:async_hooks";

/** Storage admission failed before a write began; the account lease must be
 * released before the caller waits for another attempt. */
export class AccountCommitBusyError extends Error {}

/** Pure context read for storage writers: they must never wait while an
 * account commit owns the shared lease. All bundled account-lock copies use
 * this same process-global context. This module must not resolve state. */
export function accountMutationHeld(): boolean {
  const runtime = (globalThis as unknown as {
    __llvAccountMutationRuntime?: { transactionContext: AsyncLocalStorage<{ active: boolean }> };
  }).__llvAccountMutationRuntime;
  return runtime?.transactionContext.getStore()?.active === true;
}
