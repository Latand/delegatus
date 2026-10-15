import type { RuntimeHostClient } from "@/lib/runtime/client";
import { readRuntimeSnapshot, type RuntimeSnapshotReads, type RuntimeSnapshotMetadata } from "@/lib/runtime/snapshotReads";

/** Evidence lives for one ports/pass. Affirmative death discards it so adoption
 * within that pass can be observed. A rejected read remains unknown. */
export function pipelineRuntimeReads() {
  let metadata: Promise<RuntimeSnapshotMetadata> | null = null;
  let activity: Promise<RuntimeSnapshotReads["activity"]> | null = null;
  return {
    metadata(client: RuntimeHostClient) { return metadata ??= activity ?? readRuntimeSnapshot(client, "metadata"); },
    session(client: RuntimeHostClient, conversationId: string) {
      activity ??= readRuntimeSnapshot(client, "activity");
      return activity.then(value => value.sessions.find(session => session.conversationId === conversationId));
    },
    reset() { metadata = null; activity = null; },
  };
}
