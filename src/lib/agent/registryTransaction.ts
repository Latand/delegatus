import type { Database } from "bun:sqlite";

/** Raised before admission; no application callback or SQL write has run. */
export class RegistryTransactionError extends Error {
  readonly code = "registry_transaction_busy";
  readonly retryable = true;
  readonly store = "SqliteAgentRegistryStore";
  constructor(options?: ErrorOptions) {
    super("SqliteAgentRegistryStore: transient internal transaction conflict; retry admission", options);
    this.name = "RegistryTransactionError";
  }
}

export function beginRegistryTransaction(db: Pick<Database, "inTransaction" | "exec">, immediate = false): void {
  if (db.inTransaction) throw new RegistryTransactionError();
  try { db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN"); }
  catch (error) {
    if (error instanceof Error && /cannot start a transaction within a transaction/i.test(error.message)) {
      throw new RegistryTransactionError({ cause: error });
    }
    throw error;
  }
}
