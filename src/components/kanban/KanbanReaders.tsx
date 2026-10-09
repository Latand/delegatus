"use client";

import { memo, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { SpeakButton } from "@/components/feed/SpeakButton";
import { BranchPane } from "@/components/BranchPane";
import { mobileRowState } from "@/components/mobile/mobileBoardModel";
import { latestAttempt, stageAttemptPlace, stageCardLabel, stageCardLabelParts, stageLabelTitle } from "@/components/pipelines/pipelineModel";
import { EffortScale } from "@/components/EffortPills";
import { EngineMark } from "@/components/EngineMark";
import { CtxChip } from "@/components/PlanChip";
import { captureReader, restoreReader, type ReaderSnapshot } from "@/components/scheme/NativeConversationPane";
import { useProcessKill } from "@/components/TaskHeader";
import { RoleFrameMark } from "@/components/RoleFrameMark";
import { useAgentCapabilities } from "@/components/useAgentCapabilities";
import { conversationFrameRole, type FrameRole } from "@/lib/roleFrames";
import { cleanTitle, fileModelLabel, fmtAge } from "@/components/utils";

import { ConversationAccountChip } from "./AccountPicker";
import { engineWord } from "./identityMarks";
import { isLaunchedConversation } from "../launchedConversations";
import { BranchGlyph, CloseGlyph, MoreGlyph } from "./kanbanGlyphs";
import { KanbanPopover } from "./kanbanMenus";
import { pipelineActionOptions } from "./stagesModel";

/**
 * The conversations open on the board (#1695 K3, docs/design/agent-window.md).
 *
 * Each reader is ONE React subtree for as long as it is open: a portal into a
 * container element this module creates once. The agent window and a Stages
 * pane only own an empty slot; the container is appended into whichever slot
 * currently shows it. Switching agents in the window, or a pane taking its
 * conversation, therefore never remounts the conversation — its composer
 * draft, voice session, selection and scroll are the same objects throughout.
 * A reader with no slot on screen waits in the park, still mounted and laid
 * out at the window reader's size, so it comes back as it was last seen.
 *
 * What moving a DOM node loses (focus, caret, feed scroll) is captured as the
 * old slot lets go and restored in the new one, in the same commit. A feed
 * whose scroll position a move reset is put back by `restoreScrolls`, from
 * the positions its own scroll events recorded.
 */

export class ReaderPlacement {
  private readonly containers = new Map<string, HTMLDivElement>();
  private readonly slots = new Map<string, HTMLElement>();
  private readonly snapshots = new Map<string, ReaderSnapshot>();
  private readonly scrolled = new WeakMap<HTMLElement, { top: number; followed: boolean }>();
  private readonly tracked = new WeakSet<HTMLElement>();
  private park: HTMLElement | null = null;

  /** The place readers without a visible slot wait in: off screen, at the
      window reader's size, and not drawn. */
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
    /* A feed with no geometry has no position to restore. */
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

  /** This key's container, if its reader is mounted. */
  containerOf(key: string): HTMLDivElement | null {
    return this.containers.get(key) ?? null;
  }

  /** The slot currently showing this reader, if any. */
  slotOf(key: string): HTMLElement | null {
    return this.slots.get(key) ?? null;
  }
}

/** A place for one reader: the agent window's, or a Stages pane's. Renders
    nothing of its own. An incoming slot holds the agent the window is about
    to show, laid out on screen and not drawn, so its feed reads before it is
    seen. */
export function ReaderSlot({ placement, readerKey, incoming = false }: { placement: ReaderPlacement; readerKey: string; incoming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    placement.attach(readerKey, slot);
    return () => placement.detach(readerKey, slot);
  }, [placement, readerKey]);
  return <div ref={ref} className="reader-slot" data-reader-slot={readerKey} data-incoming={incoming ? "" : undefined} aria-hidden={incoming || undefined} />;
}


const DOT_TONE: Record<string, string> = { success: "tone-success", warning: "tone-warning", danger: "tone-danger", accent: "tone-accent", neutral: "tone-neutral" };

export interface ReaderOwner {
  cardId: string;
  cardTitle: string;
  stage: { pipeline: Pipeline; stage: PipelineStage } | null;
}

export interface ReaderView {
  readerKey: string;
  file: FileEntry;
  /** The reader stands in a Stages pane, whose head names the stage and its state. */
  inSheet?: boolean;
  owner: ReaderOwner | null;
  /** The conversation holds the project's orchestrator seat: it reads as the
      orchestrator, the way the seat names it. */
  seat?: boolean;
  /** The reader is the agent window's: the conversation's one composer is
      here, even while the seat shows the same conversation. */
  composerPrimary?: boolean;
}

interface ReaderProps extends ReaderView {
  now: number;
  /** Close this agent: it leaves the open agents. */
  onClose: (key: string) => void;
  /** Close the agent window; every agent stays open. */
  onLeave: () => void;
  onMenu: (key: string, anchor: HTMLElement, stop: ReaderStop) => void;
  /** A failed launch in the conversation's feed offers its retry (K9a). */
  onSpawnRetry?: (file: FileEntry) => void;
  onCloseConversation?: (file: FileEntry) => void;
}

/** The host control the reader's actions menu offers, as the capability
    matrix has it for this conversation right now. */
export interface ReaderStop {
  state: "enabled" | "disabled" | "hidden";
  reason: string;
}

/** The role a reader's frame wears: from the stage it is an attempt of and
    the conversation's own durable lineage. The reader's ribbon and the
    open-agents rail both read it here. */
export function readerFrameRole(view: Pick<ReaderView, "file" | "owner" | "seat">): FrameRole {
  return conversationFrameRole({ seat: view.seat, stage: view.owner?.stage?.stage ?? null, file: view.file });
}

/** A reader in words: the stage's name the way the stage list has it, else
    the conversation's own title; and the card it is open on. Never an id. */
export function readerNames(t: TFunction, view: Pick<ReaderView, "file" | "owner" | "seat">): { name: string; card: string | null } {
  const { file, owner } = view;
  const place = owner?.stage ? stageAttemptPlace(owner.stage.pipeline, owner.stage.stage.id, file) : null;
  const name = owner?.stage && place ? stageCardLabel(t, owner.stage.stage, place) : view.seat ? t("orchPanel.title") : cleanTitle(file.title ?? "", 90) || t("kanban.untitledConversation");
  const card = owner?.cardTitle && owner.cardTitle !== name ? owner.cardTitle : null;
  return { name, card };
}

/** The prototype's reader anatomy (`renderReader` + `renderConvHead`) over the
    real conversation: the header reads the same authorities `BranchPane`'s
    own header does, and everything under it is `BranchPane`. */
const KanbanReader = memo(function KanbanReader({ readerKey, file, inSheet = false, owner, seat = false, composerPrimary = false, now, onClose, onLeave, onMenu, onSpawnRetry, onCloseConversation }: ReaderProps) {
  const { t } = useLocale();
  const { runtime } = useAgentCapabilities(file);
  /* PID and Stop host live in the actions menu, so the header keeps its title. */
  const kill = useProcessKill(file);
  const row = mobileRowState(file, now);
  const stateWord = t(`kanban.memberState.${row.key}`);
  const tone = DOT_TONE[row.dot] ?? "tone-neutral";
  const working = row.key === "working";
  const engine = file.engine === "claude" || file.engine === "codex" ? file.engine : null;
  /* The header names the stage the way the stage list does, with the attempt
     once it ran twice, «Critique · 2», and keeps the role preset for the
     tooltip (#1865). */
  const place = owner?.stage ? stageAttemptPlace(owner.stage.pipeline, owner.stage.stage.id, file) : null;
  const role = owner?.stage && place ? stageCardLabel(t, owner.stage.stage, place) : null;
  const title = role && owner ? `${role} · ${owner.cardTitle}` : readerNames(t, { file, owner, seat }).name;
  /* The attempt number is set apart the way the tile sets it: a muted
     tabular suffix of the stage's name, never a third bold word. */
  const labelParts = owner?.stage && place ? stageCardLabelParts(t, owner.stage.stage, place) : null;
  const titleHint = owner?.stage && place ? `${stageLabelTitle(t, owner.stage.stage, place, engine ? engineWord(engine) : null)} · ${owner.cardTitle}` : title;
  // A failed receipt alone cannot authorize retry of a closed or superseded stage.
  const pipelineOwner = owner?.stage;
  const retryOption = pipelineOwner
    ? pipelineActionOptions(pipelineOwner.pipeline).find((option) => option.action === "retry-stage")
    : null;
  const pipelineLaunch = file.durableLineage?.memberships.some((item) => item.kind === "pipeline");
  const retryEligible = pipelineOwner
    ? retryOption?.refusal === null && retryOption.stageId === pipelineOwner.stage.id
      && latestAttempt(pipelineOwner.pipeline, pipelineOwner.stage.id)?.launchId === file.spawn?.launchId
    : !pipelineLaunch;
  const retryLaunch = retryEligible ? onSpawnRetry : undefined;
  const neverStarted = file.spawn?.state === "failed" && file.path.startsWith("spawn:");
  const dismissLaunch = neverStarted && onCloseConversation ? (
    <button
      type="button"
      className="btn sm"
      data-launch-dismiss=""
      onClick={() => { onClose(readerKey); onCloseConversation(file); }}
    >
      {t("runtime.receipt.dismiss")}
    </button>
  ) : null;
  const needs = row.dot === "warning";
  /* The role frame: which agent this is, from the stage it is an
     attempt of and its own durable lineage. */
  const frameRole = readerFrameRole({ file, owner, seat });
  const identity = (
    <>
      {engine ? (
        <span className="ch-engine" data-engine={engine}>
          <EngineMark engine={engine} size={12} />
          <span>{engineWord(engine)}</span>
        </span>
      ) : null}
      {file.model ? (
        <span className="ch-model" title={t("kanban.readerModelTitle")}>
          <span>{fileModelLabel(file)}</span>
          <EffortScale effort={file.effort} />
          {file.effort ? <span className="ch-effort">{file.effort}</span> : null}
        </span>
      ) : null}
      {engine ? <ConversationAccountChip file={file} session={runtime?.session ?? null} readerKey={readerKey} name={role ?? title} /> : null}
      {file.ctx ? <CtxChip ctx={file.ctx} /> : null}
      {/* Supersedence lineage (#383), as the pane's own header carries it: the retired predecessor's history is one
          click away, and the Viewer opens the `#c=` link in place. */}
      {file.continues ? (
        <a
          href={"#c=" + encodeURIComponent(file.continues.conversationId)}
          data-continues-chip=""
          className="ch-continues"
          title={t("lineage.continuesTitle", { round: file.continues.round })}
        >
          {t("lineage.continues", { round: file.continues.round })}
        </a>
      ) : null}
    </>
  );
  const menuButton = (
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
  );
  /* In a Stages pane the pane's head names the stage, its state and its
     collapse; the conversation keeps its identity row and its own actions. */
  if (inSheet) {
    return (
      <BranchPane
        file={file}
        tasks={[]}
        isRoot={false}
        onSpawnRetry={retryLaunch}
        chrome={{
          header: (
            <div className="conv-head">
              <div className="ch-meta pane-id">
                <RoleFrameMark role={frameRole} />
                {identity}
                <span className="spacer" />
                <SpeakButton scope={file.path} header />
                {dismissLaunch}
                {menuButton}
              </div>
            </div>
          ),
          className: `reader conv in-sheet${needs ? " needs" : ""}`,
          attributes: {
            tabIndex: "-1",
            "data-kanban-reader": readerKey,
            /* The pane's own transcript path. An attention arrival that opens a
               conversation no card holds lands on THIS pane, and the board's
               anchor for it is the path — the reader key is the conversation
               id, which the board index does not hold (#1836 item 4). */
            "data-reader-path": file.path,
            "data-in-sheet": "1",
            "data-role-host": "reader",
            "data-role": frameRole,
            role: "region",
            "aria-label": t("kanban.readerAria", { title, state: stateWord }),
          },
        }}
      />
    );
  }
  const header = (
    <>
      <div className="conv-head">
        <div className="ch-row">
          <RoleFrameMark role={frameRole} />
          <span className={`ch-dot ${tone}${working ? " live" : ""}`} aria-hidden="true" />
          <span className="ch-title" title={titleHint}>
            {labelParts && labelParts.attempt !== null && owner
              ? <>{labelParts.name}<span className="attempt"> · {labelParts.attempt}</span> · {owner.cardTitle}</>
              : title}
          </span>
          <span className="spacer" />
          <SpeakButton scope={file.path} header />
          {dismissLaunch}
          {menuButton}
          <button
            type="button"
            className="icon-btn sm"
            data-reader-close={readerKey}
            aria-label={t("kanban.agentWindow.close")}
            title={t("kanban.agentWindow.close")}
            onClick={onLeave}
          >
            <CloseGlyph />
          </button>
        </div>
        <div className="ch-meta">
          <span className={`ch-state ${tone}`}>
            {stateWord}
            <span className="num"> · {fmtAge(file.mtime)}</span>
          </span>
          {identity}
          {file.worktree ? (
            <span className="ch-tree" title={t("branch.worktree", { name: file.worktree })}>
              <BranchGlyph />
              <span>{file.worktree}</span>
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
  return (
    <BranchPane
      file={file}
      tasks={[]}
      isRoot={false}
      onSpawnRetry={retryLaunch}
      composerPrimary={composerPrimary}
      chrome={{
        header,
        className: `reader conv${needs ? " needs" : ""}${isLaunchedConversation(file) ? " launched" : ""}`,
        attributes: {
          tabIndex: "-1",
          "data-kanban-reader": readerKey,
          /* See above: the pane an arrival on a loose conversation lands on. */
          "data-reader-path": file.path,
          "data-role-host": "reader",
          "data-role": frameRole,
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
