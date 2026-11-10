import { agentRegistry } from "@/lib/agent/registry";
import { loadFlow } from "@/lib/flows/store";
import { loadPipelinesForTask } from "@/lib/pipelines/store";
import { pathAllowedWithRoots, scanRootEntries } from "@/lib/scanner/roots";
import { loadTasksByIds } from "@/lib/tasks/store";

import type { TaskAlbumDeps } from "./album";
import { albumSeenStore } from "./seen";
import type { TaskAlbumWorld } from "./sources";

/** The album's view of the Viewer's own stores, read-only, for one request. */
export function productionAlbumWorld(): TaskAlbumWorld {
  const tasks = new Map<string, ReturnType<typeof loadTasksByIds>[number] | null>();
  const pipelines = new Map<string, ReturnType<typeof loadPipelinesForTask>>();
  const conversations = new Map<string, readonly string[]>();
  // Root enumeration is a request snapshot; every candidate and root still
  // passes pathAllowedWithRoots' realpath and relay checks on each use.
  let roots: ReturnType<typeof scanRootEntries> | undefined;
  const flows = new Map<string, ReturnType<typeof loadFlow>>();
  return {
    task(taskId) {
      if (!tasks.has(taskId)) tasks.set(taskId, loadTasksByIds(new Set([taskId]))[0] ?? null);
      return tasks.get(taskId) ?? null;
    },
    pipelines(taskId) {
      if (!pipelines.has(taskId)) pipelines.set(taskId, loadPipelinesForTask(taskId));
      return pipelines.get(taskId)!;
    },
    flow(flowId) {
      if (!flows.has(flowId)) flows.set(flowId, loadFlow(flowId));
      return flows.get(flowId) ?? null;
    },
    conversationPaths(conversationId) {
      if (!conversationId.startsWith("conversation_")) return [];
      if (!conversations.has(conversationId)) conversations.set(conversationId,
        agentRegistry().conversationTranscriptPaths(conversationId as `conversation_${string}`));
      return conversations.get(conversationId)!;
    },
    transcriptAllowed: (path) => pathAllowedWithRoots(path, roots ??= scanRootEntries()),
  };
}

export function productionAlbumDeps(): TaskAlbumDeps {
  return { world: productionAlbumWorld(), seen: albumSeenStore() };
}
