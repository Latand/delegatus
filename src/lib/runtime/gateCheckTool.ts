import fs from "node:fs";
import path from "node:path";
import { waitForGateCompletion } from "../../../scripts/gate-wait";

export const gateCheckTool = {
  type: "function", name: "wait_for_check",
  description: "Wait once for an existing recorded gate check through admission, execution and cleanup. Call after gate-slot.sh --record LOG reports recording started. Supply its absolute log path and the check reason. The recorder pins the deadline. This foreground wait works without recorded-check custody; keep the stage alive. A nonterminal result or refusal is unknown: retain evidence and stop, without polling or restarting the command.",
  inputSchema: { type: "object", properties: { log: { type: "string" }, reason: { type: "string" } }, required: ["log", "reason"], additionalProperties: false },
} as const;

/** A read-only tool bound to the native stage's own temporary root. */
export async function runGateCheckTool(args: unknown, root: string, signal: AbortSignal) {
  try {
    const input = args as { log?: unknown; reason?: unknown } | null;
    if (!input || typeof input.log !== "string" || !path.isAbsolute(input.log)
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500)
      throw new Error("log and a bounded check reason are required");
    const ownerRoot = fs.realpathSync(root);
    const relative = path.relative(path.resolve(root), path.resolve(input.log));
    const log = path.join(ownerRoot, relative);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
      || fs.realpathSync(path.dirname(input.log)) !== path.dirname(log))
      throw new Error("gate log is outside this stage's temporary root");
    const result = await waitForGateCompletion(log, signal);
    return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify({ reason: input.reason, ...result,
      terminal: result.state.startsWith("finished"),
      ...(!result.state.startsWith("finished") ? { instruction: "No terminal result. Preserve this run and its evidence; do not poll or restart it." } : {}),
    }) }] };
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText" as const, text: `Check result unknown: ${error instanceof Error ? error.message : String(error)}. Preserve the original run and evidence.` }] };
  }
}
