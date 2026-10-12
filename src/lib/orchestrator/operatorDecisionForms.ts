import { activeOrchestratorSeats } from "./seats";

/** Fresh launches carry the role; an existing conversation can also hold a seat. */
export function operatorDecisionFormsRequired(agentRole: string | null | undefined, artifactPath?: string | null): boolean {
  return agentRole === "orchestrator" || Boolean(artifactPath
    && activeOrchestratorSeats().some(seat => seat.path === artifactPath));
}
