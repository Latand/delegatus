import { agentRegistry } from "@/lib/agent/registry";
import { boardFor } from "./store";
import { applyBoardCommand } from "./command";
import { MAX_BOARD_PATH_LIST_ITEMS, MAX_BOARD_MUTATIONS_PER_REQUEST } from "./validation";
type RegistrySnapshot = ReturnType<ReturnType<typeof agentRegistry>["readOnlySnapshot"]>;
export interface ArchivePlacementPorts {
  boardFor: typeof boardFor;
  applyBoardCommand(input: unknown, snapshot: RegistrySnapshot): ReturnType<typeof applyBoardCommand>;
}
export function archiveConversationPaths(
  project: string,
  action: "archive" | "unarchive",
  paths: readonly string[],
  snapshot: RegistrySnapshot,
  dependencies: ArchivePlacementPorts,
): { appliedPaths: ReadonlySet<string> } {
  let board = dependencies.boardFor(project);
  const appliedPaths = new Set<string>();
  const uniquePaths = [...new Set(paths)];
  const batchSize = action === "archive"
    ? MAX_BOARD_PATH_LIST_ITEMS
    : MAX_BOARD_MUTATIONS_PER_REQUEST;
  for (let offset = 0; offset < uniquePaths.length; offset += batchSize) {
    const batch = uniquePaths.slice(offset, offset + batchSize);
    let settled = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pendingPaths = batch.filter((pathname) => action === "archive"
        ? !board.prefs.hidden.includes(pathname)
        : board.prefs.hidden.includes(pathname));
      if (pendingPaths.length === 0) {
        settled = true;
        break;
      }

      const previousBoard = board;
      const result = dependencies.applyBoardCommand({
        schemaVersion: 1,
        project,
        baseRevision: board.revision,
        ...(action === "archive"
          ? { patch: { hidden: pendingPaths } }
          : {
              mutations: pendingPaths.map((pathname) => ({
                kind: "restore" as const,
                path: pathname,
                placement: "auto" as const,
              })),
            }),
      }, snapshot);
      board = result.board;
      if (result.ok && result.applied) {
        const hiddenBefore = new Set(previousBoard.prefs.hidden);
        const hiddenAfter = new Set(board.prefs.hidden);
        for (const pathname of uniquePaths) {
          const changed = action === "archive"
            ? !hiddenBefore.has(pathname) && hiddenAfter.has(pathname)
            : hiddenBefore.has(pathname) && !hiddenAfter.has(pathname);
          if (changed) appliedPaths.add(pathname);
        }
        settled = true;
        break;
      }
    }
    if (!settled) {
      throw new Error(`board state changed repeatedly while ${action === "archive" ? "archiving" : "unarchiving"} conversations`);
    }
  }
  return { appliedPaths };
}
