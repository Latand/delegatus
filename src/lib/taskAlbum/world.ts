import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { loadFlow } from "@/lib/flows/store";
import { loadArchivedPipelines, loadPipelinesForList } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { pathAllowed } from "@/lib/scanner/roots";
import { loadTasksForList } from "@/lib/tasks/store";

import type { TaskAlbumDeps } from "./album";
import { albumSeenStore } from "./seen";
import type { TaskAlbumWorld } from "./sources";

/* Settled pipelines move to the archive after three days; their stages still
   made the task's pictures. The archive is cold, so it is read once a minute. */
const ARCHIVE_TTL_MS = 60_000;
let archived: { at: number; pipelines: readonly Pipeline[] } | null = null;
function archivedPipelines(): readonly Pipeline[] {
  if (!archived || Date.now() - archived.at > ARCHIVE_TTL_MS) {
    let pipelines: readonly Pipeline[] = [];
    try {
      pipelines = loadArchivedPipelines();
    } catch {
      pipelines = archived?.pipelines ?? [];
    }
    archived = { at: Date.now(), pipelines };
  }
  return archived.pipelines;
}

/** The album's view of the Viewer's own stores, read-only, for one request. */
export function productionAlbumWorld(): TaskAlbumWorld {
  const lookup = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot());
  let tasks: Map<string, ReturnType<typeof loadTasksForList>[number]> | null = null;
  const flows = new Map<string, ReturnType<typeof loadFlow>>();
  return {
    task(taskId) {
      tasks ??= new Map(loadTasksForList().map((task) => [task.id, task] as const));
      return tasks.get(taskId) ?? null;
    },
    pipelines: () => [...loadPipelinesForList(), ...archivedPipelines()],
    flow(flowId) {
      if (!flows.has(flowId)) flows.set(flowId, loadFlow(flowId));
      return flows.get(flowId) ?? null;
    },
    conversationPaths(conversationId) {
      if (!conversationId.startsWith("conversation_")) return [];
      const conversation = lookup.conversation(conversationId as `conversation_${string}`);
      if (!conversation) return [];
      return [...new Set([...conversation.continuityPaths, ...conversation.generations.map((generation) => generation.path)])];
    },
    transcriptAllowed: (path) => pathAllowed(path),
  };
}

export function productionAlbumDeps(): TaskAlbumDeps {
  return { world: productionAlbumWorld(), seen: albumSeenStore() };
}
