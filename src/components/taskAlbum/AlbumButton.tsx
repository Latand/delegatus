"use client";

import { FileText, Images } from "lucide-react";
import { useState } from "react";

import { ChevronRight } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { useTaskAlbumSummary } from "./albumSummaries";
import { TaskAlbum, type AlbumView } from "./TaskAlbum";

interface AlbumEntryProps {
  taskId: string;
  title: string;
  pipelines: readonly Pipeline[];
  files: readonly FileEntry[];
  /** The task has lanes whose committed files can be listed (a task on this
      machine with at least one lane). The entry then shows without pictures. */
  filesAvailable?: boolean;
}

/** The album button in a desktop card's foot: the picture count, and how
    many are new since the album was last opened, as the phone's row says it.
    A task with lanes and no pictures shows the Files icon alone; a task with
    neither shows nothing. */
export function CardAlbumButton({ taskId, title, pipelines, files, filesAvailable = false }: AlbumEntryProps) {
  const { t } = useLocale();
  const summary = useTaskAlbumSummary(taskId);
  const [open, setOpen] = useState(false);
  /* The view it opened on stays for the life of the dialog. */
  const [view, setView] = useState<AlbumView>("images");
  if (!summary?.count && !filesAvailable && !open) return null;
  const count = summary?.count ?? 0;
  const newCount = summary?.newCount ?? 0;
  const fresh = newCount > 0;
  const label = !count
    ? t("album.buttonAriaFilesOnly", { title })
    : t(fresh ? "album.buttonAriaNew" : filesAvailable ? "album.buttonAriaWithFiles" : "album.buttonAria", { title, count });
  return (
    <>
      <button
        type="button"
        className="add album num"
        data-album-button={taskId}
        data-album-fresh={fresh ? "1" : "0"}
        aria-label={label}
        title={label}
        onClick={() => { setView(count ? "images" : "files"); setOpen(true); }}
      >
        {count ? <Images aria-hidden /> : <FileText aria-hidden />}
        {count || null}
        {fresh ? (
          <span className="album-new" data-album-card-new={newCount} aria-hidden="true">
            <span className="album-dot" />
            {t("album.newCount", { count: newCount })}
          </span>
        ) : null}
      </button>
      {open ? <TaskAlbum taskId={taskId} title={title} pipelines={pipelines} files={files} filesAvailable={filesAvailable} initialView={view} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The same entry on the phone's task screen, as one of its rows. */
export function PhoneAlbumRow({ taskId, title, pipelines, files, rowClass, filesAvailable = false }: AlbumEntryProps & { rowClass: string }) {
  const { t } = useLocale();
  const summary = useTaskAlbumSummary(taskId);
  const [open, setOpen] = useState<AlbumView | null>(null);
  if (!summary?.count && !filesAvailable && !open) return null;
  const count = summary?.count ?? 0;
  const newCount = summary?.newCount ?? 0;
  const label = t(newCount ? "album.buttonAriaNew" : "album.buttonAria", { title, count });
  const filesLabel = t("album.buttonAriaFilesOnly", { title });
  return (
    <>
      {count || open === "images" ? (
        <button type="button" data-phone-task-album={taskId} data-album-fresh={newCount ? "1" : "0"} aria-label={label} className={rowClass} onClick={() => setOpen("images")}>
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
      ) : null}
      {filesAvailable ? (
        <button type="button" data-phone-task-files={taskId} aria-label={filesLabel} className={rowClass} onClick={() => setOpen("files")}>
          <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{t("files.title")}</span>
          <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
        </button>
      ) : null}
      {open ? <TaskAlbum taskId={taskId} title={title} pipelines={pipelines} files={files} filesAvailable={filesAvailable} initialView={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
