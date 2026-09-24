import type { Round } from "./types";

/** Exact legacy relay text, retained for settled delivery attribution. */
export function relayPrompt(round: Round, findings: string): string {
  return [
    "Review round findings are below. Address every finding before the next review marker.",
    "",
    findings.trim(),
    "",
    "For each finding, respond with FIXED or REJECTED — <reason>. When the work is reviewable again, end your final assistant message with:",
    "REVIEW_READY: <one-line note>",
  ].join("\n");
}
