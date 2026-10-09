import type { GateRefusal } from "./gate";
export type DelegationCode = GateRefusal | "invalid_instruction" | "already_requested" | "not_admitted" | "session_closed"
  | "duplicate_proposal" | "proposal_unavailable" | "proposal_changed" | "operator_cancelled" | "confirmation_expired"
  | "not_requested" | "operator_refused";
export const DELEGATION_REASONS: Record<DelegationCode, string> = {
  no_orchestrator: "This project has no designated orchestrator, so nothing was sent.",
  invalid_instruction: "The request text is empty or too long.", empty_instruction: "The request text is empty or too long.",
  already_requested: "That request was already raised. Nothing new was sent.",
  not_admitted: "The request could not be admitted.", session_closed: "The voice session has ended.",
  duplicate_proposal: "A request from this turn is already waiting.", proposal_unavailable: "That request is no longer available.",
  proposal_changed: "The request expired, changed, or its orchestrator changed before confirmation.",
  operator_cancelled: "The operator declined the request.", confirmation_expired: "The confirmation was not answered in time.",
  source_changed: "The operator took the request back.", retracted: "The operator took the request back.",
  no_input: "No operator utterance is available.", not_final: "The operator's utterance is still arriving.",
  stale_input: "The request refers to an earlier utterance.", negated: "The operator asked for nothing to be sent.",
  conditional: "The request is conditional.", question: "The utterance is a question about sending.", quoted: "The send request is quoted.",
  not_imperative: "The utterance does not ask to send.", not_addressed: "The request is not addressed to the orchestrator.",
  not_confirmed: "The confirmation must come in a later operator turn.", not_requested: "The operator did not request a send.",
  operator_refused: "The operator asked for nothing to be sent.",
};
export function deliveryFailureReason(code?: string): string {
  return code ? `The orchestrator's conversation refused the message (${code.replaceAll("_", " ").toLowerCase()}), so nothing was sent.`
    : "The delivery failed. Nothing reached the orchestrator.";
}
