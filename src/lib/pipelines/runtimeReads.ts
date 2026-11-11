import { withRuntimeRecoveryReads, type RuntimeHostClient } from "@/lib/runtime/client";
import { readRuntimeSnapshot, type RuntimeSnapshotReads } from "@/lib/runtime/snapshotReads";

/** Evidence lives for one ports/pass. Affirmative death discards it so adoption
 * within that pass can be observed. A rejected read remains unknown. */
export function pipelineRuntimeReads(options: { conversationIds?: readonly string[]; signal?: AbortSignal } = {}) {
  let activity: Promise<RuntimeSnapshotReads["activity"]> | null = null;
  const read = (client: RuntimeHostClient) => readRuntimeSnapshot(
    options.signal ? withRuntimeRecoveryReads(client, options.signal) : client, "activity", options.conversationIds);
  const sessions = (client: RuntimeHostClient, conversationId: string) => {
    activity ??= read(client);
    return activity.then(value => value.sessions.filter(session => session.conversationId === conversationId));
  };
  return {
    // Epoch and activity retain the same observation even when epoch is asked
    // first and the host changes before a later session check in this pass.
    metadata(client: RuntimeHostClient) { return activity ??= read(client); },
    sessions,
    session: (client: RuntimeHostClient, conversationId: string) => sessions(client, conversationId).then(rows => rows[0]),
    reset() { activity = null; },
  };
}
