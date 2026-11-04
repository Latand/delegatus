import { readTurboSettings } from "@/lib/monitor/seatTickSettings";
import { turboCreditExempt } from "@/lib/monitor/turbo";
import { allowedAccountIdsForProject } from "./projectBindings";
import { codexAccountSpendsCredits } from "./codex";

/**
 * Whether Turbo's project approval, together with the account's durable
 * spending opt-in, lets this account pass the credit guard for this project's
 * conversations (docs/design/turbo-mode.md §2.2). Asked only once the guard
 * would block, so the settings read is rare.
 * Unreadable settings answer false: the guard keeps blocking.
 */
export function turboCreditExemptFor(project: string | null | undefined, accountId: string | null | undefined, now = Date.now()): boolean {
  if (!project || !accountId) return false;
  /* Project approval is additional authority; the durable account switch is
     the required opt-in for every path that may spend paid credits. */
  if (!codexAccountSpendsCredits(accountId)) return false;
  try {
    const allowed = allowedAccountIdsForProject(project, "codex");
    return (allowed === null || allowed.includes(accountId)) && turboCreditExempt(readTurboSettings(project).turbo, accountId, now);
  }
  catch { return false; }
}
