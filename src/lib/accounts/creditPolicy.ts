import { codexAccountSpendsCredits } from "./codex";
export { codexAccountSpendsCredits } from "./codex";
import { creditGuardBlock } from "./creditGuard";
import type { EngineLimits } from "@/lib/types";

/** Missing, unreadable or malformed approval never authorizes paid usage.
 * Read current durable state at each decision, including after async admission. */
export function accountCreditGuardBlock(engine: string, accountId: string | null | undefined, limits: EngineLimits | null | undefined) {
  return creditGuardBlock(engine, limits, undefined, engine === "codex" && codexAccountSpendsCredits(accountId));
}

export function accountHasSpendableCredits(engine: string, accountId: string | null | undefined, limits: EngineLimits | null | undefined): boolean {
  return engine === "codex" && limits?.credits?.hasCredits === true && codexAccountSpendsCredits(accountId);
}
