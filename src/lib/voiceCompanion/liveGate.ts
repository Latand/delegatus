import type { OperatorInput } from "./gate";

/** A soft veto over recent context. Missing fragments and ordinary duplex
 * speech leave a model-raised proposal available for the operator's tap. */
export function liveProposalRefusal(instruction: string, inputs: readonly OperatorInput[]): string | null {
  if (!instruction.trim() || instruction.length > 2_000) return "invalid_instruction";
  const recent = inputs.slice(-1).map(row => row.text).join(" ").slice(-800);
  return /\b(?:don['’]?t|do not|never)\s+(?:send|delegate|ask|tell)\b|(?:не\s+(?:надсилай|відправляй|делегуй|прос[иі]|передавай))/iu.test(recent) ? "operator_refused" : null;
}
