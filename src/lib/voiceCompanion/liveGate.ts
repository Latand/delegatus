import { explicitDelegationRequest, type OperatorInput } from "./gate";

/** A completed turn that says one of these never asks for the orchestrator. */
const DECLINED = new Set(["question", "negated", "retracted", "conditional", "quoted"]);
/** A narrow veto over speech that is still arriving or came later. */
const REFUSED = /\b(?:don['’]?t|do not|never)\s+(?:send|delegate|ask|tell)\b|(?:не\s+(?:надсилай|відправляй|делегуй|прос[иі]|передавай))/iu;
const words = (rows: readonly OperatorInput[]) => rows.map(row => row.text).join(" ");

/**
 * Whether a model-raised Live proposal may stand. `sourceTurn` is the operator's
 * turn when Live delegated: the speech since the companion's previous answer.
 *
 * A completed source turn is read whole by the prototype's gate: an ordinary
 * question, a condition, a retraction, a negation or a quote refuses, and so
 * does a completed turn that never asks for the orchestrator, unless the turns
 * just before it complete the request (a backchannel can split one sentence).
 * Missing input, and a turn still arriving, leave the proposal to the
 * operator's tap, which alone sends. A later refusal withdraws it.
 */
export function liveProposalRefusal(instruction: string, inputs: readonly OperatorInput[], sourceTurn?: number): string | null {
  if (!instruction.trim() || instruction.length > 2_000) return "invalid_instruction";
  const turn = sourceTurn ?? inputs.at(-1)?.turn;
  if (turn === undefined) return REFUSED.test(words(inputs.slice(-1)).slice(-800)) ? "operator_refused" : null;
  const source = inputs.filter(row => row.turn === turn);
  if (REFUSED.test(words(inputs.filter(row => (row.turn ?? -1) >= turn)).slice(-2_000))) return "operator_refused";
  if (!source.length || source.some(row => !row.final)) return null;
  const verdict = explicitDelegationRequest(words(source));
  if (verdict.admit) return null;
  if (DECLINED.has(verdict.reason)) return verdict.reason;
  for (let back = 1; back <= 2; back += 1) {
    const span = inputs.filter(row => row.turn !== undefined && row.turn >= turn - back && row.turn <= turn);
    if (span.every(row => row.final) && explicitDelegationRequest(words(span)).admit) return null;
  }
  // The prototype's "no_orchestrator" names a missing seat elsewhere; here it means no request was made.
  return "not_requested";
}
