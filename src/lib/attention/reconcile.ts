import { attentionReason } from "@/components/attention";
import type { readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import type { Pipeline, PipelineAttemptState } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { SystemAttentionClear } from "./dismissals";
import type { ConversationReasonKind } from "./dismissalTypes";

/*
 * Which waits no longer ask anyone (docs/design/attention-auto-resolve.md,
 * «Implementation plan for acceptance 2»). Pure: the controller reads the
 * board projection and the stores, this decides, and the dismissal store
 * writes each clear attributed to Delegatus with its rule, so the card says
 * who cleared it and why and Undo brings it back.
 *
 * A rule clears only on evidence about the exact reason: a stale hint (a done
 * task, a quiet conversation, elapsed time, an unrelated message) is never
 * enough, and a source this pass could not read clears nothing.
 */

export interface ReconcileFacts {
  /** The registry's current name for a conversation id. */
  canonicalConversationId(id: string): string;
  /** Conversations that held a seat which was since given to another
      conversation, by canonical id. */
  retiredSeats: ReadonlySet<string>;
  /** When the operator's newest message to a conversation was admitted,
      epoch ms, by canonical id; absent when none is known. */
  operatorWroteAt: ReadonlyMap<string, number>;
  pipeline(id: string): Pipeline | null;
}

type OrchestratorSeatFile = NonNullable<ReturnType<typeof readOrchestratorSeatFileOrNull>>;

/** Reasons a retired seat's ending settles: what it asked as the seat. An owed
    delivery or a failed launch is the operator's own action, and stays. */
const RETIRED_SEAT_KINDS: ReadonlySet<ConversationReasonKind> = new Set(["decision", "ask", "question", "plan", "permission", "memory"]);
/** Reasons a stage conversation raises while its attempt runs. */
const STAGE_KINDS: ReadonlySet<ConversationReasonKind> = new Set(["ask", "question", "plan", "permission", "memory"]);
const SETTLED_ATTEMPTS: ReadonlySet<PipelineAttemptState> = new Set(["passed", "failed", "needs_decision", "skipped"]);

/** Every seat conversation that was replaced and holds no seat now. */
export function retiredSeatConversations(file: OrchestratorSeatFile | null, canonical: (id: string) => string): Set<string> {
  if (!file) return new Set();
  const holding = new Set([...Object.values(file.seats), ...Object.values(file.pending)].flatMap((seat) => (seat.conversationId ? [canonical(seat.conversationId)] : [])));
  return new Set(file.revocations.map((revocation) => canonical(revocation.conversationId)).filter((id) => !holding.has(id)));
}

/** No process and no turn behind the conversation any more. */
function ended(file: FileEntry): boolean {
  return file.proc !== "running" && file.activity !== "live" && file.lastTurn?.endedAt !== null;
}

/** The stage attempt this conversation ran last, if its lane names one. */
function stageAttemptSettled(file: FileEntry, facts: ReconcileFacts): boolean {
  const id = file.conversationId ? facts.canonicalConversationId(file.conversationId) : null;
  for (const membership of file.durableLineage?.memberships ?? []) {
    if (membership.kind !== "pipeline" || !membership.stageId) continue;
    const lane = facts.pipeline(membership.containerId);
    if (!lane) continue;
    const attempt = lane.runs.find((run) => run.stageId === membership.stageId)?.attempts
      .findLast((candidate) => (id && candidate.conversationId && facts.canonicalConversationId(candidate.conversationId) === id) || candidate.agentPath === file.path);
    if (!attempt) continue;
    return SETTLED_ATTEMPTS.has(attempt.state);
  }
  return false;
}

/** The clears one pass owes: at most one per conversation, by the first rule
    that proves it. */
export function attentionSystemClears(files: readonly FileEntry[], now: number, facts: ReconcileFacts): SystemAttentionClear[] {
  const clears: SystemAttentionClear[] = [];
  for (const file of files) {
    if (file.supersededBy || file.migratedTo) continue;
    const reason = attentionReason(file, now);
    if (!reason || reason.dismissal) continue;
    const conversationId = file.conversationId ?? null;
    const canonical = conversationId ? facts.canonicalConversationId(conversationId) : null;
    const base = { conversationId, path: file.path, reason: reason.kind, raisedAt: reason.raisedAt };
    /* The seat was handed on and its conversation ended: nothing it asked can
       be answered there, and it can ask nothing newer, so the clear covers
       every reason it raised. */
    if (canonical && facts.retiredSeats.has(canonical) && RETIRED_SEAT_KINDS.has(reason.kind) && ended(file)) {
      clears.push({ ...base, reasonId: null, rule: "retired-seat" });
      continue;
    }
    /* The operator answered the prose ask in the conversation itself. */
    const wrote = canonical ? facts.operatorWroteAt.get(canonical) : undefined;
    if (reason.kind === "ask" && wrote !== undefined && wrote > reason.since * 1000) {
      clears.push({ ...base, reasonId: reason.id, rule: "operator-replied" });
      continue;
    }
    /* A turn started after the memory kill: the agent is going again. */
    const memoryAt = reason.memory ? Date.parse(reason.memory.at) : Number.NaN;
    if (reason.kind === "memory" && file.lastTurn && Number.isFinite(memoryAt) && file.lastTurn.startedAt > memoryAt) {
      clears.push({ ...base, reasonId: reason.id, rule: "resumed" });
      continue;
    }
    /* The stage attempt that asked has settled: its lane carries whatever is
       left to decide, under its own reason. */
    if (STAGE_KINDS.has(reason.kind) && stageAttemptSettled(file, facts)) {
      clears.push({ ...base, reasonId: reason.id, rule: "stage-settled" });
    }
  }
  return clears;
}
