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
 * Nothing is stored for that: the screen on top names its own project (or
 * the one under it does), through the one payload the Viewer already polls.
 */

export interface OverviewScreenLookup {
  tasks: readonly BoardTask[];
  pipelines: readonly Pipeline[];
  files: readonly FileEntry[];
  /** The project of each conversation opened over the Overview, recorded at
      the open: a conversation the poll has not carried yet (a catalog row, a
      search result beyond the scan window) still names its project. */
  conversationProjects?: ReadonlyMap<string, string>;
}

/** The screens stacked above the Overview's board, as one comparable
    string, so a reader re-renders when a screen is pushed or popped and never
    for a sheet. Null while the board is alone. */
export function overviewStackKey(stack: readonly MobileScreen[]): string | null {
  return stack.length > 1 ? stack.slice(1).map(screenKey).join("\n") : null;
}

const SCREEN_KINDS: ReadonlySet<string> = new Set(["board", "chat", "task", "pipelines", "pipeline", "accounts"]);

/** The screens `overviewStackKey` named, bottom first. */
export function overviewStackScreens(key: string | null): MobileScreen[] {
  if (!key) return [];
  return key.split("\n").flatMap((line) => {
    const at = line.indexOf(":");
    const kind = at < 0 ? line : line.slice(0, at);
    if (!SCREEN_KINDS.has(kind)) return [];
    return [(at < 0 ? { kind } : { kind, id: line.slice(at + 1) }) as MobileScreen];
  });
}

/** The project whose dashboard draws the top of a stack over the Overview:
    the topmost screen that names one. A task, a lane and a conversation name
    their own project; a screen that names none (the accounts screen, a
    pipelines list, an agent draft) belongs to the screen under it. Screens
    of different projects can stack (a lane of one project opened from
    another's task), and each is drawn by its own project's dashboard, so ‹
    pops one screen at a time, the way the browser's history does. */
export function overviewLiftProject(screens: readonly MobileScreen[], lookup: OverviewScreenLookup): string | null {
  for (let index = screens.length - 1; index >= 0; index -= 1) {
    const project = overviewScreenProject(screens[index]!, lookup);
    if (project) return project;
  }
  return null;
}

/** The project the screen belongs to, or null when the payload does not name
    it (a task, a lane or a conversation it no longer carries). */
export function overviewScreenProject(screen: MobileScreen | null, lookup: OverviewScreenLookup): string | null {
  if (!screen) return null;
  if (screen.kind === "task") return lookup.tasks.find((task) => task.id === screen.id)?.project ?? null;
  if (screen.kind === "pipeline") return lookup.pipelines.find((pipeline) => pipeline.id === screen.id)?.project ?? null;
  if (screen.kind === "chat") {
    const file = lookup.files.find((entry) => entry.path === screen.id);
    return file ? projectKey(file) : lookup.conversationProjects?.get(screen.id) ?? null;
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
