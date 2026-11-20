import { taskTitle } from "@/components/tasks/taskModel";
import { hasLegacySessionPlaceholder } from "@/lib/tasks/titleSource";
import { UNTITLED_TASK_TEXT, type BoardTask } from "@/lib/tasks/types";
import { firstMeaningfulPromptLine } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

/** A task waiting for agent refinement can still show a useful name from
 * its launch brief or conversation while that refinement is pending. */
export interface PlaceholderTitleInput {
  task: Pick<BoardTask, "text" | "origin" | "conversationTitle">;
  /** The card's conversations, in the band's order. */
  members: readonly { file: Pick<FileEntry, "title"> }[];
  mirrors?: readonly { file: Pick<FileEntry, "title"> }[];
  /** Launches of the task that failed: none of them will ever name it. */
  failedLaunches?: readonly Pick<FileEntry, "title">[];
}

export interface PlaceholderTitle {
  /** The task still waits for an agent to name it: the card says so. */
  pending: boolean;
  /** The display title borrowed from an existing source. */
  derived: string | null;
}

const TITLE_LIMIT = 80;
/** Whether the task carries no name of its own yet. */
export function awaitsName(task: Pick<BoardTask, "text" | "origin">): boolean {
  return task.origin?.refinement === "pending" || !taskTitle(task.text);
}

export function placeholderTitle({ task, members, mirrors, failedLaunches }: PlaceholderTitleInput): PlaceholderTitle {
  if (hasLegacySessionPlaceholder(task) && task.conversationTitle) {
    const title = firstMeaningfulPromptLine(task.conversationTitle, TITLE_LIMIT);
    if (title) return { pending: false, derived: title };
  }
  if (!awaitsName(task)) return { pending: false, derived: null };
  const own = taskTitle(task.text);
  const brief = own === UNTITLED_TASK_TEXT ? null : firstMeaningfulPromptLine(own, TITLE_LIMIT);
  if (task.origin?.kind === "launch" && brief) return { pending: false, derived: brief };
  const candidates = [
    task.conversationTitle,
    ...members.map((member) => member.file.title),
    ...(mirrors ?? []).map((mirror) => mirror.file.title),
    ...(failedLaunches ?? []).map((file) => file.title),
    brief,
  ];
  for (const candidate of candidates) {
    const title = firstMeaningfulPromptLine(candidate, TITLE_LIMIT);
    if (title) return { pending: false, derived: title };
  }
  return { pending: true, derived: null };
}
