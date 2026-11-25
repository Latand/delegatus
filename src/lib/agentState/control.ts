import type { StructuredHostColumns } from "@/lib/agent/registry";
import type { RuntimeSession, RuntimeWriterStatus } from "@/lib/runtime/contracts";
import type { HostState } from "@/lib/runtime/engineHost";
import { hostMemoryTurn } from "./model";

/** The synchronous part of owned-host evidence used at the write boundary. */
export interface HostControlFacts {
  sessionKey: string;
  transport?: { pid: number; startIdentity: string | null; endpoint: string } | null;
  status: HostState["status"];
  turnId: string | null;
  idle: boolean;
  attentionPending: boolean;
  activeFlags: readonly string[];
}

export function hostControlFacts(
  sessionKey: string,
  availability: HostState["status"],
  turnId: string | null,
  blockingAttention: boolean,
  attentionPending: boolean,
  activeFlags: readonly string[],
): HostControlFacts {
  const turn = hostMemoryTurn(turnId);
  const status = availability === "dead" || availability === "unhosted" ? availability
    : blockingAttention ? "attention" : turn.state === "open" ? "active" : availability;
  return { sessionKey, status, turnId, idle: status === "idle" && turn.state === "closed", attentionPending, activeFlags };
}

export function sameHostControlRoute(expected: HostControlFacts, current: HostControlFacts): boolean {
  return current.sessionKey === expected.sessionKey && current.turnId === expected.turnId && current.status === expected.status;
}

export function hostControlFactsFromHealth(state: HostState): HostControlFacts {
  return {
    ...hostControlFacts(state.sessionKey, state.status, state.activeTurnRef,
      state.status === "attention", (state.pendingAttention?.length ?? 0) > 0, state.activeFlags ?? []),
    transport: state.pid ? { pid: state.pid, startIdentity: state.processStartIdentity, endpoint: state.endpoint } : null,
  };
}

export function matchesControlTransport(facts: HostControlFacts, host: StructuredHostColumns | null | undefined): boolean {
  return !!facts.transport && !!host?.process && facts.transport.pid === host.process.pid
    && facts.transport.startIdentity === host.process.startIdentity && facts.transport.endpoint === host.endpoint;
}

export function checkpointControlFacts(host: StructuredHostColumns | null | undefined) {
  return {
    turnId: host?.activeTurnRef ?? null,
    attentionIds: host?.pendingAttention ?? [],
    attentionVerified: host?.attentionVerified !== false && host?.agentStateAttention?.unverified !== true,
  };
}

/** Journal turn events and reconciled session-status publications share this
 * fold. Native turn claims remain separate operation custody. */
export function runtimeControlFacts(session: RuntimeSession | RuntimeWriterStatus) {
  return {
    turnId: session.activeTurnId,
    turn: session.turn,
    idle: session.turn === "idle" && session.activeTurnId === null,
    open: session.turn === "running" || session.turn === "interrupt_requested",
    attentionPending: "attentionIds" in session && session.attentionIds.length > 0,
  };
}
