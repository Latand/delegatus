import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { buildAttentionQueue } from "@/components/attention";
import { projectKey } from "@/components/projectModel";

import { needsDecisionPipelineRows, type MobileBoardPipelineRow } from "./mobileBoardModel";
import { screenKey, type MobileScreen } from "./mobileNav";
import { attentionKey } from "./phoneKanbanModel";

/*
 * The phone's Overview (#2098) as a board under a stack. The Overview is the
 * phone kanban over every project; a card opens its task, its pipeline or its
 * conversation the way a project's card does, on the same navigation stack.
 * Those screens belong to one project each, and that project's dashboard is
 * what draws them (the task screen, the pipeline screen, the full-screen
 * conversation), while the Overview stays the board at the bottom of the
 * stack, so ‹ comes back to it at the column and offset it left.
 *
 * Nothing is stored for that: the first screen above the board names its own
 * project, through the one payload the Viewer already polls.
 */

export interface OverviewScreenLookup {
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  files: readonly FileEntry[];
}

/** The first screen above the Overview's board: the one the Overview pushed.
    Every screen above it was pushed by that project's own dashboard. */
export function overviewLiftScreen(stack: readonly MobileScreen[]): MobileScreen | null {
  const screen = stack[1];
  return screen && (screen.kind === "task" || screen.kind === "pipeline" || screen.kind === "chat") ? screen : null;
}

/** The first screen above the board, as one comparable string, so a reader
    re-renders when that screen changes and never for a sheet or a screen
    pushed above it. */
export function overviewLiftKey(stack: readonly MobileScreen[]): string | null {
  const screen = overviewLiftScreen(stack);
  return screen ? screenKey(screen) : null;
}

/** The screen `overviewLiftKey` named. */
export function overviewLiftScreenOf(key: string | null): MobileScreen | null {
  if (!key) return null;
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return kind === "task" || kind === "pipeline" || kind === "chat" ? { kind, id } : null;
}

/** The project the screen belongs to, or null when the payload does not name
    it (a task, a lane or a conversation it no longer carries). */
export function overviewScreenProject(screen: MobileScreen | null, lookup: OverviewScreenLookup): string | null {
  if (!screen) return null;
  if (screen.kind === "task") return lookup.tasks.find((task) => task.id === screen.id)?.project ?? null;
  if (screen.kind === "pipeline") return lookup.pipelines.find((pipeline) => pipeline.id === screen.id)?.project ?? null;
  if (screen.kind === "chat") {
    const file = lookup.files.find((entry) => entry.path === screen.id);
    return file ? projectKey(file) : null;
  }
  return null;
}

/** The lanes parked on the operator in every project: each project's own
    `needsDecisionPipelineRows`, joined. The Overview's ⚠ badge counts them
    and its sheet lists them beside the conversations, and the columns pin the
    same lanes, so the badge is the sum of the tabs' ⚠ marks. */
export function overviewPipelineRows(pipelines: readonly Pipeline[], now: number, closing: readonly string[]): MobileBoardPipelineRow[] {
  const projects = [...new Set(pipelines.map((pipeline) => pipeline.project))];
  return projects.flatMap((project) => needsDecisionPipelineRows(pipelines, project, now, closing));
}

/** The attention queue's order over every project, as `attentionKey` keys:
    the order the bar's ⚠ sheet lists on the Overview (the conversations, then
    `overviewPipelineRows`), which the columns pin by, the way a project's
    board orders its own. */
export function overviewAttention(files: readonly FileEntry[], pipelines: readonly Pipeline[], now: number, closing: readonly string[]): string[] {
  return [
    ...buildAttentionQueue([...files], now).map((item) => attentionKey.conversation(item.file.path)),
    ...overviewPipelineRows(pipelines, now, closing).map((row) => attentionKey.pipeline(row.id)),
  ];
}
