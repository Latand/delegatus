import type { AccountMutationBusyError } from "@/lib/accounts/accountMutation";

/**
 * Host recovery refused by account-mutation contention before its successor
 * reservation existed (#1716).
 *
 * The account mutation lock throws its busy error from the acquire, before the
 * reservation's transaction is admitted, so the refused recovery reserved
 * nothing and started nothing, and trying it again later is safe. Only the
 * reservation call site can establish that. The same busy error raised anywhere
 * later in recovery keeps its own type, because by then a receipt may exist or
 * a host may be starting.
 *
 * The message is the lock's own, so a caller that reports it reads the same
 * sentence as before.
 */
export class StructuredRecoveryContendedError extends Error {
  constructor(readonly contention: AccountMutationBusyError) {
    super(contention.message);
    this.name = "StructuredRecoveryContendedError";
  }
}
