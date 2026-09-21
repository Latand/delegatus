import fs from "node:fs";
import { BoardSelection, type BoardScope } from "@/lib/mcp/boardSelection";
import { archiveProjects, reviewHistorySelectionSource } from "./reader";
import { redactArchive } from "./redaction";
import type { Flow } from "./types";
import { compactFlow } from "./listAnswers";

const selections = new Map<string, { signature: string; selection: BoardSelection }>();

/** Reuse the compact-read contract, including warm scalar indexes, cursor
 * scope/reset and keyed selection. Both metadata and rows use one snapshot. */
export function listReviewHistory(scope: BoardScope, cursor: unknown, limit: number) {
  const source = reviewHistorySelectionSource();
  try {
    const projects = archiveProjects(source.directory);
    const normalized = { ...scope, project: projects.canonical(scope.project), includeClosed: true };
    if (!source.initialized) return { rows: [], count: 0, total: 0, remainingCount: 0, hasMore: false, nextCursor: null, omittedCount: 0, cursorReset: !!cursor };
    const stat = fs.statSync(source.filename);
    const signature = JSON.stringify([stat.dev, stat.ino, projects.aliases()]);
    let held = selections.get(source.filename);
    if (held?.signature !== signature) {
      held?.selection.close();
      held = { signature, selection: new BoardSelection(source.filename, "flows", projects) };
    }
    selections.delete(source.filename);
    selections.set(source.filename, held);
    if (selections.size > 8) {
      const oldest = selections.keys().next().value!;
      selections.get(oldest)!.selection.close();
      selections.delete(oldest);
    }
    return held.selection.page(source, normalized, cursor, Math.max(1, Math.min(100, Math.trunc(limit) || 25)), flow => compactFlow(redactArchive({ ...flow, project: projects.canonical(flow.project) }) as Flow));
  } finally { source.close(); }
}
