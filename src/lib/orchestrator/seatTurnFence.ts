import type { AgentRegistry } from "@/lib/agent/registry";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import type { SeatCommandResult } from "./seatCommand";

/** Positive idle evidence is required at every automatic replacement boundary. */
export function automaticReplacementHold(conversationId: string, sources: {
  registry(): Pick<AgentRegistry, "seatTickConversation">;
  liveness?(request: { conversationId: string; stallAfterMs: number; limit: number }): Promise<AgentLivenessRecord[]>;
}, stallAfterMs = 0): SeatCommandResult | null | Promise<SeatCommandResult | null> {
  const held: SeatCommandResult = { status: 409, body: { code: "rotation_turn_unsettled", error: "automatic rotation is waiting for the incumbent turn to end" } };
  const row = sources.registry().seatTickConversation(conversationId);
  if (row?.turn.state === "idle" || row?.turn.state === "terminal") return null;
  if (row?.turn.state !== "busy") return held;
  // Recovery has no controller observation attached to the lost request.
  // A transcript's earlier end-turn must not override a newly busy registry row.
  const liveness = sources.liveness;
  if (!liveness) return held;
  const observedTurn = JSON.stringify(row.turn);
  return (async () => {
    try {
      const rows = await liveness({ conversationId, stallAfterMs, limit: 1 });
      const currentTurn = sources.registry().seatTickConversation(conversationId)?.turn;
      if (currentTurn?.state === "idle" || currentTurn?.state === "terminal") return null;
      const activity = rows.find(row => row.conversationId === conversationId);
      return JSON.stringify(currentTurn) === observedTurn && activity?.turnState === "idle" ? null : held;
    } catch { return held; }
  })();
}
