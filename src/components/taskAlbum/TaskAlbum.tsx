"use client";

import { Images } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { GlyphIcon, Loader2, X } from "@/components/icons";
import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { Z } from "@/components/layers";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import { fmtAge } from "@/components/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { formatConversationHash } from "@/lib/accounts/identity";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { AlbumItem, AlbumPage } from "@/lib/taskAlbum/album";
import type { AlbumSource } from "@/lib/taskAlbum/sources";
import { cleanTitle } from "@/lib/title";
import type { FileEntry } from "@/lib/types";

import { albumOpened } from "./albumSummaries";

/**
 * A task's album: every picture its agents looked at, were handed or named,
 * newest first, grouped by the stage or conversation it came from. Each group
 * names its source and links to it; a picture new since the operator last
 * opened the album says so. A tap opens the feed's full-screen viewer, whose
 * arrows step through the album in the order it is drawn. On a phone the
 * album takes the whole screen.
 */

export interface TaskAlbumProps {
  taskId: string;
  title: string;
  /** The task's pipelines, to name a stage the way its lane row does. */
  pipelines: readonly Pipeline[];
  /** Loaded conversations, to name one by its title. */
  files: readonly FileEntry[];
  onClose: () => void;
}

interface Group {
  source: AlbumSource;
  items: AlbumItem[];
}

/** While the Viewer is still indexing, how often the album asks again, and how many times. */
const INDEXING_POLL_MS = 1500;
const INDEXING_POLLS = 20;

export function albumSourceLabel(t: TFunction, source: AlbumSource, pipelines: readonly Pipeline[], files: readonly FileEntry[]): string {
  if (source.stage) {
    const stage = pipelines.find((pipeline) => pipeline.id === source.stage!.pipelineId)?.stages.find((entry) => entry.id === source.stage!.stageId);
    const name = stage ? stageDisplayName(t, stage) : source.stage.stageId;
    const attempt = source.stage.attempt > 1 ? t("kanban.stageAttempt", { stage: name, n: source.stage.attempt }) : name;
    return source.stage.round ? t("album.review", { stage: attempt, n: source.stage.round }) : attempt;
  }
  const file = files.find((entry) => (source.conversationId && entry.conversationId === source.conversationId) || entry.path === source.path);
  return cleanTitle(file?.title ?? "", 90) || t("album.conversation");
}

function groupsOf(items: readonly AlbumItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const group = groups.get(item.source.key);
    if (group) group.items.push(item);
    else groups.set(item.source.key, { source: item.source, items: [item] });
  }
  return [...groups.values()];
}

function itemName(t: TFunction, item: AlbumItem): string {
  return item.name ?? (item.via === "pasted" ? t("album.pasted") : t("album.inline"));
}

const exactTime = (ts: number) => new Date(ts).toLocaleString();

export function TaskAlbum({ taskId, title, pipelines, files, onClose }: TaskAlbumProps) {
  const { t } = useLocale();
  const phone = useIsMobile();
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [page, setPage] = useState<Omit<AlbumPage, "items"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<GalleryImage | null>(null);
  const marked = useRef(false);
  const polls = useRef(0);
  const shown = useRef(0);

  useOverlayEscape(onClose, open === null);

  const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/album`;
  const load = useCallback(async (cursor: string | null, limit?: number) => {
    setLoading(true);
    setFailed(false);
    try {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      if (limit) query.set("limit", String(limit));
      const res = await fetch(`${endpoint}?${query.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as AlbumPage;
      const { items: next, ...rest } = body;
      setItems((held) => {
        const merged = cursor ? [...held, ...next.filter((item) => !held.some((own) => own.id === item.id))] : next;
        shown.current = merged.length;
        return merged;
      });
      setPage((held) => (cursor && held ? { ...rest, lastOpenedAt: held.lastOpenedAt } : rest));
      if (!marked.current) {
        /* Everything up to now is seen once the album has shown it; the
           pictures keep their «new» marks for as long as it stays open. */
        marked.current = true;
        albumOpened(taskId, body.total);
        void fetch(endpoint, { method: "POST" }).catch(() => {});
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [endpoint, taskId]);

  useEffect(() => {
    void load(null);
  }, [load]);

  /* A cold task is indexed over several reads: ask again while the Viewer
     says it is still reading, keeping as many pictures as are shown. */
  useEffect(() => {
    if (!page?.indexing || loading || polls.current >= INDEXING_POLLS) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load(null, Math.max(shown.current, 60));
    }, INDEXING_POLL_MS);
    return () => clearTimeout(timer);
  }, [page, loading, load]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const groups = useMemo(() => groupsOf(items), [items]);
  const labels = useMemo(() => new Map(groups.map((group) => [group.source.key, albumSourceLabel(t, group.source, pipelines, files)] as const)), [groups, t, pipelines, files]);
  /* The viewer steps through the pictures in the order the album draws them. */
  const gallery = useMemo<GalleryImage[]>(() => groups.flatMap((group) => group.items.map((item) => ({
    src: item.src,
    alt: itemName(t, item),
    caption: `${itemName(t, item)} · ${labels.get(group.source.key)} · ${fmtAge(item.ts / 1000)}`,
  }))), [groups, labels, t]);
  const galleryRef = useRef(gallery);
  galleryRef.current = gallery;
  const readGallery = useCallback(() => galleryRef.current, []);

  const total = page?.total ?? 0;
  const newCount = page?.newCount ?? 0;
  const frame = phone
    ? "h-full w-full"
    : "h-[min(88vh,960px)] w-[min(1120px,calc(100vw-48px))] rounded-surface border border-border shadow-2";

  return createPortal(
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center ${phone ? "" : "bg-black/40 p-6"}`}
      data-task-album={taskId}
      /* Portalled, yet a React child of the card that opened it: a press here
         must not start the card's drag or its keyboard moves. */
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={t("album.dialogAria", { title })} className={`flex min-h-0 flex-col overflow-hidden bg-card ${frame}`}>
        <header className={`flex shrink-0 items-center gap-2 border-b border-border px-4 ${phone ? "min-h-14 pt-[env(safe-area-inset-top)]" : "py-3"}`}>
          <Images className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-body font-bold text-primary">{t("album.title")}</h2>
            <p className="m-0 truncate text-label text-muted">
              <span className="tabular-nums">{t("album.count", { count: total })}</span>
              {newCount ? <span data-album-new-count={newCount} className="font-semibold text-accent tabular-nums"> · {t("album.newCount", { count: newCount })}</span> : null}
              <span> · {title}</span>
            </p>
          </div>
          <button
            type="button"
            data-album-close=""
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:w-8"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div data-album-body="" className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${phone ? "px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-3" : "px-4 py-4"}`}>
          {failed && !items.length ? (
            <div role="alert" className="flex flex-col items-start gap-2 rounded-control border border-danger/45 bg-danger-soft px-3 py-2 text-label font-semibold text-danger">
              {t("album.failed")}
              <button type="button" className="min-h-11 rounded-control border border-border bg-canvas px-3 text-label font-semibold text-secondary sm:min-h-8" onClick={() => void load(null)}>
                {t("album.retry")}
              </button>
            </div>
          ) : !items.length && loading ? (
            <p role="status" className="m-0 flex items-center gap-2 py-6 text-label font-semibold text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loadingCap")}
            </p>
          ) : !items.length ? (
            <p data-album-empty="" className="m-0 py-6 text-center text-ui text-muted">{page?.indexing ? t("album.indexing") : t("album.empty")}</p>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map((group) => {
                const label = labels.get(group.source.key) ?? "";
                return (
                  <section key={group.source.key} data-album-group={group.source.key} className="flex flex-col gap-2">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <h3 className="m-0 min-w-0 truncate text-ui font-semibold text-secondary" title={label}>{label}</h3>
                      <span className="shrink-0 text-label tabular-nums text-muted" title={exactTime(group.items[0]!.ts)}>{fmtAge(group.items[0]!.ts / 1000)}</span>
                      <a
                        href={formatConversationHash({ conversationId: group.source.conversationId ?? undefined, path: group.source.path })}
                        data-album-source={group.source.key}
                        className="ml-auto inline-flex min-h-11 shrink-0 items-center text-label font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
                        onClick={onClose}
                      >
                        {t("album.openSource")}
                      </a>
                    </div>
                    <ul className={`m-0 grid list-none gap-2 p-0 ${phone ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(176px,1fr))]"}`}>
                      {group.items.map((item) => (
                        <AlbumTile key={item.id} item={item} label={label} onOpen={() => setOpen({ src: item.src, alt: itemName(t, item) })} />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {page?.indexing ? <p className="m-0 text-label text-muted">{t("album.indexing")}</p> : null}
              {page?.nextCursor ? (
                <button
                  type="button"
                  data-album-more=""
                  disabled={loading}
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 self-center rounded-control border border-border bg-canvas px-4 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-9"
                  onClick={() => void load(page.nextCursor)}
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  {t("album.loadMore")}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {open ? (
        <ImageGalleryProvider value={readGallery}>
          <Lightbox src={open.src} alt={open.alt} onClose={() => setOpen(null)} />
        </ImageGalleryProvider>
      ) : null}
    </div>,
    document.body,
  );
}

function AlbumTile({ item, label, onOpen }: { item: AlbumItem; label: string; onOpen: () => void }) {
  const { t } = useLocale();
  const [broken, setBroken] = useState(false);
  const name = itemName(t, item);
  const age = fmtAge(item.ts / 1000);
  return (
    <li className="min-w-0" data-album-item={item.id} data-album-item-new={item.isNew ? "1" : "0"}>
      <button
        type="button"
        aria-label={t("album.imageAria", { name, source: label, age })}
        className="relative block h-[132px] w-full overflow-hidden rounded-control border border-border bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onClick={onOpen}
      >
        {broken ? (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <GlyphIcon name="image" className="h-5 w-5" />
          </span>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- a fenced local file or transcript bytes; next/image cannot serve either */
          <img src={item.src} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" onError={() => setBroken(true)} />
        )}
      </button>
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 text-label">
        {item.isNew ? (
          <span data-album-new="" className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent" title={t("album.newHint")}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("album.new")}
          </span>
        ) : null}
        <span className={`min-w-0 truncate text-secondary ${item.name ? "font-mono" : ""}`} title={item.name ?? undefined}>{name}</span>
      </div>
      <p className="m-0 truncate text-caption text-muted">
        <span className="tabular-nums" title={exactTime(item.ts)}>{age}</span> · {t(`album.via.${item.via}`)}
      </p>
    </li>
  );
}
