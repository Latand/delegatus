"use client";

import { memo, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { accountIdFromPath } from "@/lib/accounts/badge";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { AccountBadge } from "@/components/AccountBadge";
import { BranchPane } from "@/components/BranchPane";
import { mobileRowState, nowFragment } from "@/components/mobile/mobileBoardModel";
import { stageChipLabel } from "@/components/pipelines/pipelineModel";
import { CtxChip } from "@/components/PlanChip";
import { captureReader, restoreReader, type ReaderSnapshot } from "@/components/scheme/NativeConversationPane";
import { useProcessKill } from "@/components/TaskHeader";
import { useAgentCapabilities } from "@/components/useAgentCapabilities";
import { cleanTitle, fmtAge } from "@/components/utils";

import { KanbanPopover } from "./kanbanMenus";

/**
 * Conversations open inside kanban cards (#1695 K3).
 *
 * Each reader is ONE React subtree for as long as it is open: a portal into a
 * container element this module creates once. Cards only own an empty slot;
 * the container is appended into whichever slot currently shows it. A status
 * move, a re-rank, a search that hides the card, a tab switch or a collapsed
 * card therefore never remount the conversation — its composer draft, voice
 * session, selection and scroll are the same objects throughout. A reader with
 * no slot on screen waits in a hidden park inside the board, still mounted.
 *
 * What moving a DOM node loses (focus, caret, feed scroll) is captured as the
 * old slot lets go and restored in the new one, in the same commit.
 *
 * A re-rank inside one column is a different move: React reorders the card
 * itself, the slot never lets go, and the browser drops the feed's scroll
 * position on the way. Every reader's last scroll position is therefore kept
 * from its own scroll events, and `restoreScrolls` puts back one the move
 * reset, on every board commit.
 */

export class ReaderPlacement {
  private readonly containers = new Map<string, HTMLDivElement>();
  private readonly slots = new Map<string, HTMLElement>();
  private readonly snapshots = new Map<string, ReaderSnapshot>();
  private readonly scrolled = new WeakMap<HTMLElement, { top: number; followed: boolean }>();
  private readonly tracked = new WeakSet<HTMLElement>();
  private park: HTMLElement | null = null;

  /** The hidden place readers without a visible slot wait in. */
  setPark(park: HTMLElement | null): void {
    this.park = park;
    if (!park) return;
    for (const [key, container] of this.containers) {
      if (!this.slots.has(key) && container.parentNode !== park) park.append(container);
    }
  }

  container(key: string): HTMLDivElement {
    let container = this.containers.get(key);
    if (!container) {
      container = document.createElement("div");
      container.className = "reader-host";
      container.dataset.readerKey = key;
      this.track(container);
      this.containers.set(key, container);
      this.park?.append(container);
    }
    return container;
  }

  /** Remember each feed's position as the operator (or the feed) scrolls it. */
  private track(container: HTMLElement): void {
    if (this.tracked.has(container)) return;
    this.tracked.add(container);
    container.addEventListener("scroll", (event) => {
      const element = event.target as HTMLElement;
      if (!element.hasAttribute?.("data-log-feed-scroller") || element.clientHeight === 0) return;
      this.scrolled.set(element, {
        top: element.scrollTop,
        followed: element.scrollHeight - element.scrollTop - element.clientHeight < 2,
      });
    }, true);
  }

  /**
   * Put back a feed position a card move reset. A reset reads as a feed at
   * the very top that was last seen elsewhere; a feed the operator scrolled to
   * the top recorded that itself and is left alone. Runs before paint, so the
   * reset is never seen, and before the reset's own scroll event can record it.
   */
  restoreScrolls(): void {
    for (const [key, container] of this.containers) {
      if (!this.slots.has(key)) continue;
      container.querySelectorAll<HTMLElement>("[data-log-feed-scroller]").forEach((element) => {
        const last = this.scrolled.get(element);
        if (!last || element.clientHeight === 0 || element.scrollTop !== 0 || last.top < 1) return;
        element.scrollTop = last.followed ? element.scrollHeight : last.top;
      });
    }
  }

  attach(key: string, slot: HTMLElement): void {
    const container = this.container(key);
    this.slots.set(key, slot);
    if (container.parentNode !== slot) slot.append(container);
    const snapshot = this.snapshots.get(key);
    if (snapshot) {
      this.snapshots.delete(key);
      restoreReader(snapshot);
    }
  }

  detach(key: string, slot: HTMLElement): void {
    if (this.slots.get(key) !== slot) return;
    this.slots.delete(key);
    const container = this.containers.get(key);
    if (!container || container.parentNode !== slot) return;
    const snapshot = captureReader(container);
    /* A feed measured inside a hidden column has no geometry to restore. */
    snapshot.scrolls = snapshot.scrolls.filter(({ element }) => element.clientHeight > 0);
    if (snapshot.focused || snapshot.range || snapshot.scrolls.length || snapshot.fields.length) this.snapshots.set(key, snapshot);
    if (this.park) this.park.append(container);
    else container.remove();
  }

  /** The container a mounted portal renders into is this key's container,
      even after a development double-invoke released it once. */
  adopt(key: string, container: HTMLDivElement): void {
    if (this.containers.get(key) === container) return;
    this.containers.get(key)?.remove();
    this.track(container);
    this.containers.set(key, container);
    const place = this.slots.get(key) ?? this.park;
    if (place && container.parentNode !== place) place.append(container);
  }

  release(key: string, container?: HTMLDivElement): void {
    const current = this.containers.get(key);
    if (container && current !== container) return;
    current?.remove();
    this.containers.delete(key);
    this.snapshots.delete(key);
  }

  /** The slot currently showing this reader, if any. */
  slotOf(key: string): HTMLElement | null {
    return this.slots.get(key) ?? null;
  }
}

/** A card's place for one reader. Renders nothing of its own. */
export function ReaderSlot({ placement, readerKey }: { placement: ReaderPlacement; readerKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    placement.attach(readerKey, slot);
    return () => placement.detach(readerKey, slot);
  }, [placement, readerKey]);
  return <div ref={ref} className="reader-slot" data-reader-slot={readerKey} />;
}

const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const CollapseGlyph = () => <svg {...svgProps}><path d="m17 11-5-5-5 5" /><path d="m17 18-5-5-5 5" /></svg>;
const ExpandGlyph = () => <svg {...svgProps}><path d="m7 6 5 5 5-5" /><path d="m7 13 5 5 5-5" /></svg>;
const MaximizeGlyph = () => <svg {...svgProps}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>;
const MinimizeGlyph = () => <svg {...svgProps}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>;
const CloseGlyph = () => <svg {...svgProps}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const MoreGlyph = () => (
  <svg {...svgProps}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);
const BranchGlyph = () => <svg {...svgProps}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-10 7" /></svg>;

const DOT_TONE: Record<string, string> = { success: "tone-success", warning: "tone-warning", danger: "tone-danger", accent: "tone-accent", neutral: "tone-neutral" };

export interface ReaderOwner {
  cardId: string;
  cardTitle: string;
  stage: { pipeline: Pipeline; stage: PipelineStage } | null;
}

export interface ReaderView {
  readerKey: string;
  file: FileEntry;
  folded: boolean;
  /** The reader has the whole window. */
  full: boolean;
  owner: ReaderOwner | null;
}

interface ReaderProps extends ReaderView {
  now: number;
  onFold: (key: string, folded: boolean) => void;
  onClose: (key: string) => void;
  onFull: (key: string) => void;
  onMenu: (key: string, anchor: HTMLElement, stop: ReaderStop) => void;
}

/** The host control the reader's actions menu offers, as the capability
    matrix has it for this conversation right now. */
export interface ReaderStop {
  state: "enabled" | "disabled" | "hidden";
  reason: string;
}

/** The prototype's reader anatomy (`renderReader` + `renderConvHead`) over the
    real conversation: the header reads the same authorities `BranchPane`'s
    own header does, and everything under it is `BranchPane`. */
const KanbanReader = memo(function KanbanReader({ readerKey, file, folded, full, owner, now, onFold, onClose, onFull, onMenu }: ReaderProps) {
  const { t } = useLocale();
  const { runtime } = useAgentCapabilities(file);
  /* PID and Stop host live in the actions menu, so the header keeps its title. */
  const kill = useProcessKill(file);
  const row = mobileRowState(file, now);
  const stateWord = t(`kanban.memberState.${row.key}`);
  const tone = DOT_TONE[row.dot] ?? "tone-neutral";
  const working = row.key === "working";
  const role = owner?.stage ? stageChipLabel(t, owner.stage.stage) : null;
  const title = role && owner ? `${role} · ${owner.cardTitle}` : cleanTitle(file.title ?? "", 90) || t("kanban.untitledConversation");
  const needs = row.dot === "warning";
  const engine = file.engine === "claude" || file.engine === "codex" ? file.engine : null;
  const header = (
    <>
      <div className="conv-head">
        <div className="ch-row">
          <span className={`ch-dot ${tone}${working ? " live" : ""}`} aria-hidden="true" />
          <span className="ch-title" title={title}>{title}</span>
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn sm"
            data-reader-fold={readerKey}
            aria-expanded={!folded}
            aria-label={t(folded ? "kanban.readerExpand" : "kanban.readerCollapse")}
            title={t(folded ? "kanban.readerExpand" : "kanban.readerCollapse")}
            onClick={() => onFold(readerKey, !folded)}
          >
            {folded ? <ExpandGlyph /> : <CollapseGlyph />}
          </button>
          {folded ? null : (
            <button
              type="button"
              className="icon-btn sm opt-full"
              data-reader-full-toggle={readerKey}
              aria-pressed={full}
              aria-label={t(full ? "kanban.readerLeaveFull" : "kanban.readerFull")}
              title={t(full ? "kanban.readerLeaveFull" : "kanban.readerFull")}
              onClick={() => onFull(readerKey)}
            >
              {full ? <MinimizeGlyph /> : <MaximizeGlyph />}
            </button>
          )}
          <button
            type="button"
            className="icon-btn sm"
            aria-haspopup="menu"
            aria-label={t("kanban.readerActions")}
            data-reader-menu={readerKey}
            onClick={(event) => onMenu(readerKey, event.currentTarget, { state: kill.state, reason: kill.reason })}
          >
            <MoreGlyph />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-reader-close={readerKey}
            aria-label={t("kanban.readerClose")}
            title={t("kanban.readerClose")}
            onClick={() => onClose(readerKey)}
          >
            <CloseGlyph />
          </button>
        </div>
        {folded ? null : (
          <div className="ch-meta">
            <span className={`ch-state ${tone}`}>
              {stateWord}
              <span className="num"> · {fmtAge(file.mtime)}</span>
            </span>
            {engine ? <span className={`ch-engine ${engine}`}>{engine === "claude" ? "Claude" : "Codex"}</span> : null}
            {file.model ? <span className="ch-model" title={t("kanban.readerModelTitle")}>{file.effort ? `${file.model} · ${file.effort}` : file.model}</span> : null}
            {engine ? (
              <AccountBadge
                engine={engine}
                accountId={runtime?.session.accountId ?? file.spawn?.accountId ?? accountIdFromPath(file.path)}
                file={file}
                runtimeSession={runtime?.session ?? null}
              />
            ) : null}
            {file.ctx ? <CtxChip ctx={file.ctx} /> : null}
            {file.worktree ? (
              <span className="ch-tree" title={t("branch.worktree", { name: file.worktree })}>
                <BranchGlyph />
                <span>{file.worktree}</span>
              </span>
            ) : null}
          </div>
        )}
      </div>
      {folded ? (
        <button type="button" className="rlatest" onClick={() => onFold(readerKey, false)}>
          {nowFragment(file) || t("kanban.readerNoMessages")}
        </button>
      ) : null}
    </>
  );
  return (
    <BranchPane
      file={file}
      tasks={[]}
      isRoot={false}
      chrome={{
        header,
        className: `reader conv${needs ? " needs" : ""}${folded ? " folded" : ""}${full ? " full" : ""}`,
        attributes: {
          tabIndex: "-1",
          "data-kanban-reader": readerKey,
          "data-folded": folded ? "1" : "0",
          role: "region",
          "aria-label": t("kanban.readerAria", { title, state: stateWord }),
        },
      }}
    />
  );
});

/**
 * Stop host, confirmed by name (the two-step arm of #699/#700) over the same
 * kill route and capability the pane header uses. Rendered by the board, so
 * the popover is positioned against the window and never clipped by a reader.
 */
export function StopHostConfirm({ file, anchor, onClose }: { file: FileEntry; anchor: HTMLElement; onClose: (refocus: boolean) => void }) {
  const { t } = useLocale();
  const kill = useProcessKill(file);
  const name = cleanTitle(file.title ?? "", 48) || t("task.confirmKillUntitled");
  return (
    <KanbanPopover anchor={anchor} label={t("task.confirmKillNamed", { name })} onClose={onClose} initialFocus="[data-stop-cancel]" className="stop-confirm">
      <div className="head">{t("task.confirmKillNamed", { name })}</div>
      {file.pid === null || file.pid === undefined ? null : <p className="note num">PID {file.pid}</p>}
      {kill.message ? <p className="note" role="status" aria-live="polite">{kill.message}</p> : null}
      <div className="acts">
        <button
          type="button"
          className="btn danger"
          data-stop-confirm=""
          disabled={kill.busy || kill.state !== "enabled"}
          onClick={async () => {
            if (await kill.kill()) onClose(true);
          }}
        >
          {kill.force ? "SIGKILL" : t("task.confirmKillYes")}
        </button>
        <button type="button" className="btn" data-stop-cancel="" onClick={() => onClose(true)}>{t("common.cancel")}</button>
      </div>
    </KanbanPopover>
  );
}

/** Every open reader, mounted once, each into its own stable container. */
export function ReaderPortals({ placement, readers, ...handlers }: {
  placement: ReaderPlacement;
  readers: readonly ReaderView[];
} & Omit<ReaderProps, keyof ReaderView>) {
  return <>{readers.map((reader) => <ReaderPortal key={reader.readerKey} placement={placement} reader={reader} {...handlers} />)}</>;
}

function ReaderPortal({ placement, reader, ...handlers }: { placement: ReaderPlacement; reader: ReaderView } & Omit<ReaderProps, keyof ReaderView>) {
  const container = placement.container(reader.readerKey);
  useLayoutEffect(() => {
    placement.adopt(reader.readerKey, container);
    return () => placement.release(reader.readerKey, container);
  }, [placement, reader.readerKey, container]);
  return createPortal(<KanbanReader {...reader} {...handlers} />, container);
}
