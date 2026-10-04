"use client";

import { fmtAgeSeconds } from "@/components/utils";
import type { TaskNote } from "@/lib/tasks/types";

/** Passive operator context. The parent supplies its polling clock. */
export function TaskStatusNote({ note, nowMs, full = false }: { note?: TaskNote; nowMs: number; full?: boolean }) {
  if (!note) return null;
  return <span data-task-note={full ? "full" : "compact"} className="task-status-note flex min-w-0 items-start gap-2 text-caption font-normal text-muted">
    <span data-task-note-text className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${full ? "whitespace-pre-wrap" : "line-clamp-2"}`} title={full ? undefined : note.text}>{note.text}</span>
    <time className="shrink-0 whitespace-nowrap" dateTime={note.updatedAt} title={note.updatedAt}>{fmtAgeSeconds(Math.max(0, (nowMs - Date.parse(note.updatedAt)) / 1000))}</time>
  </span>;
}
