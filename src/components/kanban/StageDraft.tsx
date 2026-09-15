"use client";

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { renderStagePrompt } from "@/lib/pipelines/prompts";
import { buildStagePrompt, stagePromptExtra, stageReceivesPrevOutput } from "@/components/pipelines/pipelineModel";

import { BranchGlyph, ChevronRight, CloseGlyph, CollapseGlyph, ExpandGlyph, MoreGlyph, svgProps } from "./kanbanGlyphs";
import { graphOrder } from "./pipelineGraph";
import type { PipelinePorts } from "./pipelinePorts";
import { stageDraftKey, type StageDraft, type StageDrafts } from "./stageDrafts";
import { draftFacts, draftOutcome, neverLaunched, pipelineEnded, stageDraftable, stageNotStarted, stageWiringIndex } from "./stagesModel";

/*
 * A stage that has not started, drawn as the conversation it will become
 * (#1695 K5b, prototype `renderDraftBody` + `renderDraftMessage`): an event
 * line saying when it starts, its first message as the operator's own bubble
 * marked «Waiting for stage start · not delivered» and editable in place, and
 * a composer that opens when the stage starts.
 */

const PencilGlyph = () => <svg {...svgProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
const ClockGlyph = () => <svg {...svgProps}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const SendGlyph = () => <svg {...svgProps}><path d="m5 12 14-7-5 14-2.5-5.5z" /></svg>;


export function useStageDraft(drafts: StageDrafts, key: string): StageDraft | null {
  return useSyncExternalStore(drafts.subscribe, () => drafts.get(key), () => null);
}

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The feed and the closed composer of a stage with no attempt yet. */
export function StageDraftFeed({ pipeline, stage, names, drafts, ports }: {
  pipeline: Pipeline;
  stage: PipelineStage;
  names: ReadonlyMap<string, string>;
  drafts: StageDrafts;
  ports: PipelinePorts;
}) {
  const { t } = useLocale();
  const name = names.get(stage.id) ?? stage.id;
  const facts = draftFacts(pipeline, stage);
  const nameOf = (id: string) => names.get(id) ?? id;
  const when = [
    facts.after ? t("kanban.draft.startsAfter", { stage: nameOf(facts.after) }) : t("kanban.draft.startsFirst"),
    facts.then ? t("kanban.draft.then", { stage: nameOf(facts.then) }) : t("kanban.draft.last"),
    facts.onFail ? t("kanban.draft.onFail", { stage: nameOf(facts.onFail.to), max: facts.onFail.max }) : null,
  ].filter(Boolean).join(" · ");
  const ended = pipelineEnded(pipeline);
  return (
    <>
      <div className="feed draft-feed" role="log" aria-label={t("kanban.draft.feedAria", { stage: name })}>
        <div className="msg event"><i className="edot" aria-hidden="true" /><span>{when}</span></div>
        <StageDraftMessage pipeline={pipeline} stage={stage} name={name} drafts={drafts} ports={ports} />
        <AddedAtStart pipeline={pipeline} stage={stage} />
        <p className="draft-note">
          {ended
            ? t("kanban.draft.noteEnded")
            : facts.after ? t("kanban.draft.noteAfter", { stage: name, after: nameOf(facts.after) }) : t("kanban.draft.noteFirst", { stage: name })}
        </p>
      </div>
      <div className="composer2 disabled" aria-disabled="true">
        <div className="c-box">
          <textarea className="c-field" rows={1} disabled aria-label={t("kanban.draft.composerAria", { stage: name })} placeholder={t("kanban.draft.composerPlaceholder", { stage: name })} />
          <button type="button" className="c-send" disabled aria-label={t("kanban.draft.send")}><SendGlyph /></button>
        </div>
        <p className="c-status" role="status">{t("kanban.draft.composerNote")}</p>
      </div>
    </>
  );
}

/** The first message: the stage's own words, edited in place until it starts. */
export function StageDraftMessage({ pipeline, stage, name, drafts, ports }: {
  pipeline: Pipeline;
  stage: PipelineStage;
  name: string;
  drafts: StageDrafts;
  ports: PipelinePorts;
}) {
  const { t } = useLocale();
  const key = stageDraftKey(pipeline.id, stage.id);
  const draft = useStageDraft(drafts, key);
  const stored = stagePromptExtra(stage.prompt);
  const saved = drafts.saved(key);
  const ended = pipelineEnded(pipeline);
  const editable = stageDraftable(pipeline, stage.id);
  const attempts = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts ?? [];
  /* What the status line may claim: nothing is delivered before the stage
     starts, and once it has an attempt only its transcript would show the
     first message arrived. */
  const status = !attempts.length
    ? ended ? "ended" : "waiting"
    : ended && attempts.every(neverLaunched) ? "ended" : ended ? "started" : "starting";
  const field = useRef<HTMLTextAreaElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const editing = Boolean(draft);
  const hadFocus = useRef(false);

  /* The editor takes focus when it opens, caret at the end; closing it hands
     focus back to Edit when it was inside the message. */
  useLayoutEffect(() => {
    if (!editing) return;
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);
  useEffect(() => {
    if (editing || !hadFocus.current) return;
    hadFocus.current = false;
    edit.current?.focus({ preventScroll: true });
  }, [editing]);
  /* The field grows with its text, as the prototype's does. */
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(260, element.scrollHeight + 2)}px`;
  }, [draft?.text]);

  const saving = draft?.phase === "saving";
  /* Empty words are a real edit (the stage keeps only its wiring), so only an unchanged draft has nothing to save. */
  const canSave = Boolean(draft) && !saving && stagePromptExtra(draft!.text) !== stagePromptExtra(draft!.base);
  const save = (keepMine = false) => {
    hadFocus.current = true;
    void drafts.save(key, ports, { keepMine });
  };
  const cancel = () => {
    hadFocus.current = true;
    drafts.drop(key);
  };

  const words = stored || (stageReceivesPrevOutput(stage.prompt) ? t("kanban.draft.onlyPrevOutput") : t("kanban.draft.onlyTask"));
  return (
    <div className={`msg user draft${editing ? " editing" : ""}`} data-draft-message={key}>
      <div className="bubble">
        {draft?.phase === "started" || draft?.phase === "ended" ? (
          <DraftLeftover kind={draft.phase === "ended" ? "ended" : "undelivered"} draft={draft} draftKey={key} name={name} drafts={drafts} onOpenConversation={null} />
        ) : draft ? (
          <>
            <textarea
              ref={field}
              className="draft-edit"
              rows={3}
              value={draft.text}
              readOnly={saving}
              aria-label={t("kanban.draft.fieldAria", { stage: name })}
              data-draft-field={key}
              onChange={(event) => drafts.edit(key, event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (canSave) save();
                }
              }}
            />
            {draft.phase === "changed" ? (
              <div className="draft-notice info" role="status" data-draft-changed="">
                <span className="msg-text">{t("kanban.draft.changed", { theirs: draft.theirs ?? "" })}</span>
                <button type="button" onClick={cancel}>{t("kanban.useTheirs")}</button>
                <button type="button" onClick={() => save(true)}>{t("kanban.keepMine")}</button>
              </div>
            ) : null}
            {draft.phase === "unconfirmed" ? (
              <div className="draft-notice warn" role="status" data-draft-unconfirmed="">
                <span className="msg-text">{t("kanban.draft.unconfirmed")}</span>
                <button type="button" onClick={() => void drafts.check(key, ports)}>{t("kanban.pipelineAct.checkAgain")}</button>
              </div>
            ) : null}
            {draft.phase === "failed" ? (
              <div className="draft-notice error" role="alert" data-draft-failed={draft.error?.kind}>
                <span className="msg-text">
                  {draft.error?.kind === "read" ? t("kanban.draft.failedRead") : draft.error?.kind === "missing" ? t("kanban.draft.failedMissing") : t("kanban.draft.failed", { error: draft.error?.message ?? "" })}
                </span>
                {draft.error?.kind === "missing" ? null : <button type="button" onClick={() => save()}>{t("kanban.retry")}</button>}
              </div>
            ) : null}
            <div className="draft-acts">
              <span className="hint">{saving ? t("kanban.draft.saving") : t("kanban.draft.hint")}</span>
              <button type="button" className="btn quiet" data-draft-cancel={key} disabled={saving} onClick={cancel}>{t("common.cancel")}</button>
              <button type="button" className="btn primary" data-draft-save={key} disabled={!canSave} onClick={() => save()}>{t("kanban.draft.save")}</button>
            </div>
          </>
        ) : (
          <>
            <span className={`btext${stored ? "" : " wiring"}`}>{words}</span>
            {editable ? (
              <button
                ref={edit}
                type="button"
                className="bedit"
                data-draft-edit={key}
                aria-label={t("kanban.draft.editAria", { stage: name })}
                title={t("kanban.draft.editTitle")}
                onClick={() => drafts.begin(pipeline.id, stage.id, stored)}
              >
                <PencilGlyph />
                <span>{t("kanban.draft.edit")}</span>
              </button>
            ) : null}
          </>
        )}
      </div>
      <span className={`bstatus ${status}`} role="status" data-draft-status={status}>
        <ClockGlyph />
        <span>
          {t(status === "ended" ? "kanban.draft.statusEnded" : status === "starting" ? "kanban.draft.statusStarting" : status === "started" ? "kanban.draft.stateStarted" : "kanban.draft.status")}
          {saved ? t("kanban.draft.edited", { time: clockTime(saved) }) : ""}
        </span>
      </span>
    </div>
  );
}

/**
 * What the controller puts around the first message when the stage starts
 * (binding correction 2, plan §6.7): one folded line naming the parts, which
 * unfolds to them as `renderStagePrompt` writes them today, with the previous
 * stage's output not produced yet.
 */
export function AddedAtStart({ pipeline, stage }: { pipeline: Pipeline; stage: PipelineStage }) {
  const { t } = useLocale();
  const index = stageWiringIndex(pipeline, stage.id);
  const wiring = buildStagePrompt(stage.prompt, "", index);
  const relayed = index > 0 || stageReceivesPrevOutput(wiring);
  const role = stage.effectiveRole;
  const parts = [
    relayed ? t("kanban.draft.added.prev") : null,
    t("kanban.draft.added.task"),
    t("kanban.draft.added.spec"),
    role.promptScaffold ? t("kanban.draft.added.scaffold") : role.roleId ? t("kanban.draft.added.preset") : null,
    t("kanban.draft.added.access"),
    t("kanban.draft.added.verdict"),
  ].filter(Boolean).join(" · ");
  const text = renderStagePrompt(pipeline, { ...stage, prompt: wiring }, role, relayed ? t("kanban.draft.added.notYet") : "");
  return (
    <details className="draft-added" data-draft-added={`${pipeline.id}:${stage.id}`}>
      <summary title={t("kanban.draft.added.head", { parts })}>
        <ChevronRight />
        <span>{t("kanban.draft.added.head", { parts })}</span>
      </summary>
      <pre className="added-text">{text}</pre>
    </details>
  );
}

/**
 * A draft its stage can no longer take, beside its words, which stay
 * copyable: the stage started with other words, or the pipeline ended before
 * the stage ever started.
 */
export function DraftLeftover({ kind, draft, draftKey, name, drafts, onOpenConversation }: {
  kind: "undelivered" | "ended";
  draft: StageDraft;
  draftKey: string;
  name: string;
  drafts: StageDrafts;
  onOpenConversation: (() => void) | null;
}) {
  const { t } = useLocale();
  return (
    <div className={`draft-notice warn ${kind}`} role="alert" {...(kind === "ended" ? { "data-draft-ended": draftKey } : { "data-draft-undelivered": draftKey })}>
      <span className="msg-text">{t(kind === "ended" ? "kanban.draft.endedBeforeStart" : "kanban.draft.undelivered", { stage: name })}</span>
      <blockquote className="kept">{draft.text}</blockquote>
      <span className="acts">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(draft.text).catch(() => {});
          }}
        >
          {t("kanban.draft.copy")}
        </button>
        {onOpenConversation && kind === "undelivered" ? <button type="button" onClick={onOpenConversation}>{t("kanban.past.open")}</button> : null}
        <button type="button" onClick={() => drafts.drop(draftKey)}>{t("kanban.discard")}</button>
      </span>
    </div>
  );
}

/**
 * A waiting stage opened from its node on the card (prototype
 * `renderStageDraft`): the conversation it will become, with its own
 * Collapse, actions and Close. When the stage starts the board turns this
 * panel into that conversation's reader; a draft that did not make it stays
 * here, marked as not delivered, until the operator lets it go.
 */
export function StageDraftPanel({ panelKey, cardTitle, pipeline, stage, names, folded, drafts, ports, onFold, onClose, onMenu, onOpenConversation }: {
  panelKey: string;
  cardTitle: string;
  pipeline: Pipeline;
  stage: PipelineStage;
  names: ReadonlyMap<string, string>;
  folded: boolean;
  drafts: StageDrafts;
  ports: PipelinePorts;
  onFold: (folded: boolean) => void;
  onClose: () => void;
  onMenu: (anchor: HTMLElement) => void;
  onOpenConversation: (() => void) | null;
}) {
  const { t } = useLocale();
  const name = names.get(stage.id) ?? stage.id;
  const draftKey = stageDraftKey(pipeline.id, stage.id);
  const draft = useStageDraft(drafts, draftKey);
  const started = !stageNotStarted(pipeline, stage.id);
  const outcome = draft && draft.phase !== "saving" ? draftOutcome(pipeline, stage.id, draft) : null;
  const order = graphOrder(pipeline);
  const k = order.findIndex((entry) => entry.id === stage.id) + 1;
  const roleId = stage.role?.roleId ?? (stage.kind === "review-loop" ? "reviewer" : "builder");
  const engine = stage.effectiveRole.engine;
  const title = `${name} · ${cardTitle}`;
  const stored = stagePromptExtra(stage.prompt);
  const stateWord = pipelineEnded(pipeline) ? t("kanban.draft.stateEnded") : started ? t("kanban.draft.stateStarted") : t("kanban.draft.state");
  return (
    <section
      className={`stage-detail reader conv draft role-${roleId}${folded ? " folded" : ""}`}
      data-stage-detail={panelKey}
      data-draft-stage={stage.id}
      data-collapsed={folded ? "1" : "0"}
      role="region"
      tabIndex={-1}
      aria-label={t(folded ? "kanban.draft.panelAriaFolded" : "kanban.draft.panelAria", { stage: name, k, n: order.length })}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if ((event.target as HTMLElement).closest("textarea, input")) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="conv-head">
        <div className="ch-row">
          <span className="ch-dot" aria-hidden="true" />
          <span className="ch-title" title={title}>{title}</span>
          <span className="spacer" />
          <button type="button" className="icon-btn sm" data-panel-fold={panelKey} aria-expanded={!folded} aria-label={t(folded ? "kanban.draft.expandPanel" : "kanban.draft.collapsePanel", { stage: name })} title={t(folded ? "kanban.readerExpand" : "kanban.readerCollapse")} onClick={() => onFold(!folded)}>
            {folded ? <ExpandGlyph /> : <CollapseGlyph />}
          </button>
          <button type="button" className="icon-btn sm" aria-haspopup="menu" data-panel-menu={panelKey} aria-label={t("kanban.stages.stageActions", { stage: name })} onClick={(event) => onMenu(event.currentTarget)}>
            <MoreGlyph />
          </button>
          <button type="button" className="icon-btn sm" data-panel-close={panelKey} aria-label={t("kanban.draft.closePanel", { stage: name })} title={t("kanban.readerClose")} onClick={onClose}>
            <CloseGlyph />
          </button>
        </div>
        {folded ? null : (
          <div className="ch-meta">
            <span className="ch-state">{stateWord}</span>
            <span className={`ch-engine ${engine}`}>{engine === "codex" ? "Codex" : "Claude"}</span>
            {stage.effectiveRole.model ? <span className="ch-model">{stage.effectiveRole.effort ? `${stage.effectiveRole.model} · ${stage.effectiveRole.effort}` : stage.effectiveRole.model}</span> : null}
            {started ? null : <span className="ch-ctx">{t("kanban.draft.noContext")}</span>}
            {pipeline.branch ? (
              <span className="ch-tree" title={t("branch.worktree", { name: pipeline.branch })}>
                <BranchGlyph />
                <span>{pipeline.branch}</span>
              </span>
            ) : null}
            <span className="ch-stage num">{t("kanban.draft.stageOf", { k, n: order.length })}</span>
          </div>
        )}
      </div>
      {folded ? (
        <button type="button" className="rlatest" onClick={() => onFold(false)}>
          {t("kanban.draft.foldedLine", { words: stored || t("kanban.draft.onlyWiring") })}
        </button>
      ) : draft && (outcome === "undelivered" || outcome === "ended-before-start") ? (
        <DraftLeftover kind={outcome === "undelivered" ? "undelivered" : "ended"} draft={draft} draftKey={draftKey} name={name} drafts={drafts} onOpenConversation={onOpenConversation} />
      ) : (
        <StageDraftFeed pipeline={pipeline} stage={stage} names={names} drafts={drafts} ports={ports} />
      )}
    </section>
  );
}
