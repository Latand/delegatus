import { listAntigravityAccounts, activeAntigravityAccountId, antigravityAuthCheckedAt } from "./antigravity";
import type { CliPresence } from "./engineConnection";

/**
 * Antigravity's block of `GET /api/accounts` and of its own route: the command's
 * presence and the one host account, with the sign-in state the last probe or
 * launch recorded. Reading it starts nothing.
 */
export function antigravityAccountSection(cli: CliPresence) {
  const checkedAt = antigravityAuthCheckedAt();
  return {
    cli,
    active: activeAntigravityAccountId(),
    accounts: listAntigravityAccounts().map((account) => ({
      id: account.id,
      label: account.label,
      kind: account.kind,
      auth: account.auth,
      plan: account.tierName,
      checkedAt,
      authPresent: account.auth === "signed_in",
    })),
  };
}
