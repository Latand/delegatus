"use client";

import { ChevronDown, ChevronRight, PanelRight, PictureInPicture2, Undo2, X } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { projectTitle } from "@/lib/displayNames";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { RoleTag } from "../RoleFrameMark";
import { cleanTitle, fmtAge } from "../utils";
import type { MobileAttentionEntry } from "./attentionQueue";
import { reasonLine } from "./decision";
import { sendDismissal, type DismissalRequestOutcome } from "./dismissalOverlay";
import {
  isFocusedNeedsYouEntry,
  needsYouDismissal,
  needsYouEntryRole,
  needsYouEntrySince,
  needsYouLaneLine,
  needsYouSections,
} from "./needsYouPanel";
import { PermissionActions } from "./PermissionActions";

/*
 * «Waiting for you» (docs/design/needs-you-options.md, option B): the one
 * needs-you queue as a list the operator reads and clears, grouped by project.
 * It replaces the header chip's popover and its cross-project «Next»: nothing
 * here walks or moves the operator, a row opens only when it is clicked, and
 * it names its project in its section.
 *
 * Every row carries the role of the agent behind it (the role frames' own
 * emblem and palette), its title, the wait in the one vocabulary every
 * attention surface uses, its age, «Dismiss», and a permission prompt's own
 * «Allow once / Deny». A section carries «Dismiss n» and the head «Dismiss all
 * N», each naming how many rows it clears, so the two never read alike; the
 * head also offers Undo for the last dismissal, where it shifts no row. A dismissal is the needs-you
 * dismissal every card makes (`sendDismissal`): durable, drawn the moment it is
 * clicked, and gone from every count at once. An orchestrator's question is
 * its report, so dismissing it resolves it in the report log too.
 *
 * `docked`: a column beside the board, whose head lines up with the board's
 * bar. `overlay`: the same list under the header control, over the board.
 */

export type AttentionPanelPlacement = "docked" | "overlay";

type Dismiss = typeof sendDismissal;

export interface AttentionPanelProps {
  queue: readonly MobileAttentionEntry[];
  /** The project on screen, whose section leads; null on the Overview. */
  current: string | null;
  /** The rail's project order, which the other sections follow. */
  order?: readonly string[];
  projectNames: Readonly<Record<string, string>>;
  pipelines: readonly Pipeline[];
  placement: AttentionPanelPlacement;
  /** Whether the board has room to give the panel its width. */
  canDock: boolean;
  onPlacement: (next: AttentionPanelPlacement) => void;
  onClose: () => void;
  onOpen: (entry: MobileAttentionEntry) => void;
  /** The row the operator is looking at. */
  focus?: { path: string | null; laneId: string | null };
  /** Rows pinned above the sections (the current project's crowned conversations). */
  pinned?: ReactNode;
  /** Test seam. */
  dismiss?: Dismiss;
}

const FOLD_KEY = "llvNeedsYouFolds";

function readFolds(): Record<string, boolean> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FOLD_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function writeFolds(folds: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  } catch {
    /* private mode: folds last for the session */
  }
}

/* The quiet text control a row, a section and the head share. */
const QUIET = "shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
const ICON = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

interface LastDismissal {
  subjects: ReturnType<typeof needsYouDismissal>["subjects"];
  target: ReturnType<typeof needsYouDismissal>["target"];
}

export function AttentionPanel({
  queue,
  current,
  order,
  projectNames,
  pipelines,
  placement,
  canDock,
  onPlacement,
  onClose,
  onOpen,
  focus = { path: null, laneId: null },
  pinned,
  dismiss = sendDismissal,
}: AttentionPanelProps) {
  const { t } = useLocale();
  const sections = needsYouSections(queue, current, order);
  const [folds, setFolds] = useState<Record<string, boolean>>(() => (typeof window === "undefined" ? {} : readFolds()));
  const [last, setLast] = useState<LastDismissal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folded = (project: string) => folds[project] ?? (current !== null && project !== current);
  const toggleFold = (project: string) => {
    const next = { ...folds, [project]: !folded(project) };
    setFolds(next);
    writeFolds(next);
  };

  const run = useCallback((entries: readonly MobileAttentionEntry[]) => {
    if (!entries.length) return;
    const { target, subjects } = needsYouDismissal(entries);
    setError(null);
    setLast({ target, subjects });
    void dismiss(target, subjects, { surface: "desktop" }).then((result: DismissalRequestOutcome) => {
      if (!result.ok) {
        setError(t("attention.dismissFailed", { error: result.error }));
        setLast(null);
      }
    });
  }, [dismiss, t]);

  const undo = useCallback(() => {
    if (!last) return;
    setLast(null);
    setError(null);
    void dismiss(last.target, last.subjects, { undo: true, surface: "desktop" }).then((result) => {
      if (!result.ok) setError(t("attention.dismissFailed", { error: result.error }));
    });
  }, [dismiss, last, t]);

  const docked = placement === "docked";
  const title = t("attention.panelTitle", { count: queue.length });
  const head = (
    <div className={`flex shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5 ${docked ? "h-12" : "h-10"}`}>
      <h2 className="min-w-0 flex-1 truncate text-ui font-semibold text-secondary" data-needs-you-title="">{title}</h2>
      {/* Undo sits in the head, so offering it moves no row under the pointer. */}
      {last ? (
        <button
          type="button"
          className={ICON}
          data-needs-you-undo=""
          aria-label={t("attention.undoTitle", { count: last.subjects.length })}
          title={t("attention.undoTitle", { count: last.subjects.length })}
          onClick={undo}
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {queue.length ? (
        <button type="button" className={QUIET} data-needs-you-dismiss-all="" title={t("attention.dismissAllTitle")} onClick={() => run(queue)}>
          {t("attention.dismissAll", { count: queue.length })}
        </button>
      ) : null}
      {docked || canDock ? (
        <button
          type="button"
          className={ICON}
          data-needs-you-placement={docked ? "overlay" : "docked"}
          aria-label={t(docked ? "attention.float" : "attention.dock")}
          title={t(docked ? "attention.float" : "attention.dock")}
          onClick={() => onPlacement(docked ? "overlay" : "docked")}
        >
          {docked ? <PictureInPicture2 className="h-3.5 w-3.5" aria-hidden /> : <PanelRight className="h-3.5 w-3.5" aria-hidden />}
        </button>
      ) : null}
      <button type="button" className={ICON} data-needs-you-close="" aria-label={t("attention.closePanel")} title={t("attention.closePanel")} onClick={onClose}>
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1.5" data-needs-you-body="">
      {pinned}
      {error ? <p className="px-2.5 py-1.5 text-[11px] text-danger" role="status" data-needs-you-error="">{error}</p> : null}
      {sections.length === 0 ? (
        <p className="px-2.5 py-3 text-[12px] text-muted" data-needs-you-empty="">{t("attention.empty")}</p>
      ) : sections.map((section, index) => {
        const name = projectTitle(section.project, projectNames[section.project]) ?? section.project;
        const isFolded = folded(section.project);
        return (
          <section key={section.project} data-needs-you-section={section.project} data-folded={isFolded ? "" : undefined} className={index === 0 ? "" : "mt-1 border-t border-border pt-1"}>
            <div className="flex items-center gap-1 pr-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-left text-label font-semibold text-secondary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-expanded={!isFolded}
                aria-label={t(isFolded ? "attention.sectionUnfold" : "attention.sectionFold", { project: name })}
                data-needs-you-fold={section.project}
                onClick={() => toggleFold(section.project)}
              >
                {isFolded ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
                <span className="min-w-0 truncate">{name}</span>
                <span className="text-caption font-semibold tabular-nums text-muted" data-needs-you-section-count="">{section.entries.length}</span>
              </button>
              <button
                type="button"
                className={QUIET}
                data-needs-you-dismiss-section={section.project}
                aria-label={t("attention.dismissAllIn", { project: name })}
                title={t("attention.dismissAllIn", { project: name })}
                onClick={() => run(section.entries)}
              >
                {t("attention.dismissSection", { count: section.entries.length })}
              </button>
            </div>
            {isFolded ? null : section.entries.map((entry) => (
              <NeedsYouRow
                key={entry.id}
                entry={entry}
                pipelines={pipelines}
                focused={isFocusedNeedsYouEntry(entry, focus)}
                onOpen={() => onOpen(entry)}
                onDismiss={() => run([entry])}
              />
            ))}
          </section>
        );
      })}
    </div>
  );

  if (docked) {
    return (
      <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-card" aria-label={t("attention.panelAria")} data-needs-you-panel="docked">
        {head}
        {body}
      </aside>
    );
  }
  return (
    <div
      role="dialog"
      aria-label={t("attention.panelAria")}
      data-needs-you-panel="overlay"
      className="absolute right-0 top-[calc(100%+6px)] z-50 flex max-h-[75vh] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-1"
    >
      {head}
      {body}
    </div>
  );
}

/**
 * One row: the agent's role and how long it has waited on the first line,
 * with «Dismiss»; the title on the second; the wait on the third, two lines
 * at most, since a list that stays open has room for an ask's whole sentence.
 * An orchestrator's question is its own title, the question itself, and the
 * line under it says it is a question. A permission prompt answers under it.
 */
function NeedsYouRow({ entry, pipelines, focused, onOpen, onDismiss }: {
  entry: MobileAttentionEntry;
  pipelines: readonly Pipeline[];
  focused: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLocale();
  const role = needsYouEntryRole(entry, pipelines);
  const since = needsYouEntrySince(entry);
  const title = entry.kind === "conversation" ? entry.item.reason.report?.body || cleanTitle(entry.item.file.title, 90) : entry.row.task;
  const line = entry.kind === "conversation" ? reasonLine(t, entry.item.reason) : needsYouLaneLine(t, entry.row.pipeline);
  const permission = entry.kind === "conversation" && entry.item.reason.kind === "permission" && entry.item.file.pendingPermission ? entry.item.file : null;
  return (
    <div
      className={`rounded-[8px] ${focused ? "ring-2 ring-inset ring-accent/40" : ""}`}
      data-needs-you-row={entry.id}
      data-needs-you-kind={entry.kind}
      data-needs-you-role={role}
      data-needs-you-since={since ?? undefined}
      data-focused={focused ? "" : undefined}
    >
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-[8px] px-2.5 py-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          {...(entry.kind === "conversation" ? { "data-attention-row": entry.id } : { "data-attention-lane": entry.id })}
          onClick={onOpen}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <RoleTag role={role} />
            {since !== null ? <span data-attention-age className="shrink-0 text-[10.5px] text-muted">· {fmtAge(since)}</span> : null}
          </span>
          <span className="line-clamp-2 w-full text-[12px] font-semibold text-primary [overflow-wrap:anywhere]" data-needs-you-title-line="">{title}</span>
          <span data-attention-decision className="line-clamp-2 w-full text-[11px] text-muted [overflow-wrap:anywhere]">{line}</span>
        </button>
        <button
          type="button"
          className={`${QUIET} mr-1 mt-1.5`}
          data-needs-you-dismiss={entry.id}
          title={t("needs.dismissRowHint")}
          aria-label={t("needs.dismissAria", { title })}
          onClick={onDismiss}
        >
          {t("needs.dismiss")}
        </button>
      </div>
      {permission ? <PermissionActions file={permission} /> : null}
    </div>
  );
}
