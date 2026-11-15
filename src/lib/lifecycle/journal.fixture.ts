import { lifecycleEventId, type LifecycleEvent, type LifecycleJournalFile } from "./journal";
import { LIFECYCLE_STATE_FOR_EVENT, type LifecycleEventType } from "./vocabulary";

/**
 * A lifecycle journal shaped like a busy installation's (1.35 MB on disk):
 * 2,000 retained events of about 400 bytes, 8,000 retired ids, 27 spawn-failure
 * receipts and a head past a million. Every value is invented.
 */
export function productionShapedLifecycleJournal(lastSeq = 1_483_325): LifecycleJournalFile {
  const types: LifecycleEventType[] = ["stage_started", "stage_completed", "review_verdict", "delivery_delivered", "agent_stalled", "stage_failed"];
  const roles = ["builder", "reviewer", "deployer", null];
  const events: LifecycleEvent[] = Array.from({ length: 2_000 }, (_, index) => {
    const seq = lastSeq - 1_999 + index;
    const type = types[index % types.length]!;
    return {
      id: lifecycleEventId(`synthetic:event:${seq}`),
      seq,
      at: new Date(Date.UTC(2026, 10, 12, 6, 0, 0) + index * 9_000).toISOString(),
      type,
      state: LIFECYCLE_STATE_FOR_EVENT[type],
      project: `repo-synthetic-${index % 12}`,
      pipelineId: `pipeline_${String(index % 311).padStart(6, "0")}`,
      stageId: index % 2 ? "review" : "build",
      attempt: 1 + (index % 3),
      conversationId: `conversation_${String(index % 997).padStart(8, "0")}`,
      role: roles[index % roles.length]!,
      summary: `Synthetic stage ${index % 7} moved after check ${index}; ${"detail ".repeat(12 + (index % 9))}`.slice(0, 200),
    };
  });
  return {
    version: 1,
    lastSeq,
    events,
    retired: Array.from({ length: 8_000 }, (_, index) => lifecycleEventId(`synthetic:retired:${index}`)),
    spawnFailureKeys: Array.from({ length: 27 }, (_, index) => `spawn:launch_synthetic_${index}:failed`),
  };
}
