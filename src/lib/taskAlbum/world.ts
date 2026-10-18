import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { loadFlow } from "@/lib/flows/store";
import { loadArchivedPipelinesForList, loadPipelinesForList } from "@/lib/pipelines/store";
import { pathAllowedWithRoots, scanRootEntries } from "@/lib/scanner/roots";
import { loadTasksForList } from "@/lib/tasks/store";

import type { TaskAlbumDeps } from "./album";
import { albumSeenStore } from "./seen";
import type { TaskAlbumWorld } from "./sources";

/** The album's view of the Viewer's own stores, read-only, for one request. */
export function productionAlbumWorld(): TaskAlbumWorld {
  const lookup = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot());
  let tasks: Map<string, ReturnType<typeof loadTasksForList>[number]> | null = null;
  // Root enumeration is a request snapshot; every candidate and root still
  // passes pathAllowedWithRoots' realpath and relay checks on each use.
  let roots: ReturnType<typeof scanRootEntries> | undefined;
  const flows = new Map<string, ReturnType<typeof loadFlow>>();
  return {
    task(taskId) {
      tasks ??= new Map(loadTasksForList().map((task) => [task.id, task] as const));
      return tasks.get(taskId) ?? null;
    },
    pipelines: () => [...loadPipelinesForList(), ...loadArchivedPipelinesForList()],
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
    transcriptAllowed: (path) => pathAllowedWithRoots(path, roots ??= scanRootEntries()),
  };
}

export function productionAlbumDeps(): TaskAlbumDeps {
  return { world: productionAlbumWorld(), seen: albumSeenStore() };
}
