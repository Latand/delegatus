"use client";

import { Images } from "lucide-react";
import { useState } from "react";

import { ChevronRight } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { useTaskAlbumSummary } from "./albumSummaries";
import { TaskAlbum } from "./TaskAlbum";

interface AlbumEntryProps {
  taskId: string;
  title: string;
  pipelines: readonly Pipeline[];
  files: readonly FileEntry[];
}

/** The album button in a desktop card's foot: the picture count, and how
    many are new since the album was last opened, as the phone's row says it.
    Nothing while the task has no pictures. */
export function CardAlbumButton({ taskId, title, pipelines, files }: AlbumEntryProps) {
  const { t } = useLocale();
  const summary = useTaskAlbumSummary(taskId);
  const [open, setOpen] = useState(false);
  if (!summary?.count && !open) return null;
  const count = summary?.count ?? 0;
  const newCount = summary?.newCount ?? 0;
  const fresh = newCount > 0;
  const label = t(fresh ? "album.buttonAriaNew" : "album.buttonAria", { title, count });
  return (
    <>
      <button
        type="button"
        className="add album num"
        data-album-button={taskId}
        data-album-fresh={fresh ? "1" : "0"}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <Images aria-hidden />
        {count}
        {fresh ? (
          <span className="album-new" data-album-card-new={newCount} aria-hidden="true">
            <span className="album-dot" />
            {t("album.newCount", { count: newCount })}
          </span>
        ) : null}
      </button>
      {open ? <TaskAlbum taskId={taskId} title={title} pipelines={pipelines} files={files} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The same entry on the phone's task screen, as one of its rows. */
export function PhoneAlbumRow({ taskId, title, pipelines, files, rowClass }: AlbumEntryProps & { rowClass: string }) {
  const { t } = useLocale();
  const summary = useTaskAlbumSummary(taskId);
  const [open, setOpen] = useState(false);
  if (!summary?.count && !open) return null;
  const count = summary?.count ?? 0;
  const newCount = summary?.newCount ?? 0;
  const label = t(newCount ? "album.buttonAriaNew" : "album.buttonAria", { title, count });
  return (
    <>
      <button type="button" data-phone-task-album={taskId} data-album-fresh={newCount ? "1" : "0"} aria-label={label} className={rowClass} onClick={() => setOpen(true)}>
        <Images className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-[5px] text-body">
          <span className="shrink-0 font-semibold text-primary">{t("album.title")}</span>
          <span aria-hidden className="shrink-0 opacity-60">·</span>
          <span className="min-w-0 truncate tabular-nums text-secondary">{count}</span>
        </span>
        {newCount ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-label font-semibold tabular-nums text-accent">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("album.newCount", { count: newCount })}
          </span>
        ) : null}
        <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
      </button>
      {open ? <TaskAlbum taskId={taskId} title={title} pipelines={pipelines} files={files} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
