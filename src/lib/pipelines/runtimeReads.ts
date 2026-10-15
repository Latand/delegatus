import type { RuntimeHostClient } from "@/lib/runtime/client";
import { readRuntimeSnapshot, type RuntimeSnapshotReads } from "@/lib/runtime/snapshotReads";

/** Evidence lives for one ports/pass. Affirmative death discards it so adoption
 * within that pass can be observed. A rejected read remains unknown. */
export function pipelineRuntimeReads() {
  let activity: Promise<RuntimeSnapshotReads["activity"]> | null = null;
  return {
    // Epoch and activity retain the same observation even when epoch is asked
    // first and the host changes before a later session check in this pass.
    metadata(client: RuntimeHostClient) { return activity ??= readRuntimeSnapshot(client, "activity"); },
    session(client: RuntimeHostClient, conversationId: string) {
      activity ??= readRuntimeSnapshot(client, "activity");
      return activity.then(value => value.sessions.find(session => session.conversationId === conversationId));
    },
    reset() { activity = null; },
  };
}
