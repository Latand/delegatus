import { taskTitle } from "@/components/tasks/taskModel";
import { UNTITLED_TASK_TEXT, type BoardTask } from "@/lib/tasks/types";
import { firstPromptLine } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

/**
 * The name a placeholder task's card shows once no agent will give it one.
 *
 * A task an agent launch or a conversation import created waits for the
 * agent's first action to name it, and until then its card says «Untitled
 * task». Hundreds of those sat on the board for good: their conversation had
 * ended, or never started, and nothing would ever name them. So the wait is
 * bounded. While an agent can still name the task — the task is young and
 * its conversation is still running — the card keeps saying so. After that it
 * borrows its conversation's own title: the cleaned first line the
 * conversation list shows, never more of the prompt than that. With no
 * conversation to borrow from, the first line of the task's own admission
 * title is used, cleaned the same way.
 */

/** How long a placeholder waits for its agent's first action. */
export const TITLE_REFINE_WINDOW_MS = 15 * 60_000;

export interface PlaceholderTitleInput {
  task: Pick<BoardTask, "text" | "origin" | "createdAt">;
  /** The card's conversations, in the band's order. */
  members: readonly { file: Pick<FileEntry, "title" | "activity" | "proc">; working: boolean }[];
  mirrors?: readonly { file: Pick<FileEntry, "title"> }[];
  nowMs: number;
}

export interface PlaceholderTitle {
  /** The task still waits for an agent to name it: the card says so. */
  pending: boolean;
  /** The borrowed name, when the wait is over and one was found. */
  derived: string | null;
}

const TITLE_LIMIT = 80;

/** Whether the task carries no name of its own yet. */
export function awaitsName(task: Pick<BoardTask, "text" | "origin">): boolean {
  return task.origin?.refinement === "pending" || !taskTitle(task.text);
}

function stillRunning(member: PlaceholderTitleInput["members"][number]): boolean {
  return member.working || member.file.activity === "live" || member.file.proc === "running";
}

export function placeholderTitle(input: PlaceholderTitleInput): PlaceholderTitle {
  const { task, members, nowMs } = input;
  if (!awaitsName(task)) return { pending: false, derived: null };
  const createdMs = Date.parse(task.createdAt);
  const young = Number.isFinite(createdMs) && nowMs - createdMs < TITLE_REFINE_WINDOW_MS;
  /* Ended: every conversation it holds has stopped. A task with none yet (a
     launch whose transcript has not appeared) waits out the window. */
  const ended = members.length > 0 && !members.some(stillRunning);
  if (young && !ended) return { pending: true, derived: null };
  const own = taskTitle(task.text);
  const candidates = [
    ...members.map((member) => member.file.title),
    ...(input.mirrors ?? []).map((mirror) => mirror.file.title),
    own === UNTITLED_TASK_TEXT ? null : own,
  ];
  for (const candidate of candidates) {
    const title = firstPromptLine(candidate, TITLE_LIMIT);
    if (title) return { pending: false, derived: title };
  }
  return { pending: true, derived: null };
}
