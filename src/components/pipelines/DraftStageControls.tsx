"use client";

import { useState } from "react";
import { Play, Plus, Settings2 } from "lucide-react";

import { roleNameById } from "@/components/builderCopy";
import type { PipelinePorts } from "@/components/kanban/pipelinePorts";
import type { StageDrafts } from "@/components/kanban/stageDrafts";
import { stageNames } from "@/components/kanban/PipelineSection";
import { useLocale } from "@/lib/i18n";
import type { PatchPipelineRequest, Pipeline, PipelineRoleId, PipelineStage } from "@/lib/pipelines/types";

import type { ConversationDrafts } from "./conversationDraftClient";
import { defaultStageWiring, deriveStageId, PIPELINE_ROLE_OPTIONS } from "./pipelineModel";
import { StagePlaceholderPane } from "./StagePlaceholderPane";
import { useDraftStart, useUnsavedStageEdit } from "./useConversationDraft";

/**
 * The controls a draft lane drawn from a conversation adds around the
 * existing ones (docs/design/start-pipeline-from-conversation/implementation.md):
 * Start, the stage a draft appends after its last one, and a waiting stage's
 * configuration, which is the existing `StagePlaceholderPane`. The desktop
 * card and sheet and the phone's pipeline screen draw the same controls over
 * the same requests.
 */

/** The last stage of the pass chain from the entry: where an appended stage goes. */
export function passTail(pipeline: Pipeline): PipelineStage | null {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
  let stage = pipeline.stages[0] ?? null;
  const seen = new Set(stage ? [stage.id] : []);
  /* A pass edge back to a stage already walked ends the chain where it turned. */
  while (stage?.next && byId.has(stage.next) && !seen.has(stage.next)) {
    stage = byId.get(stage.next)!;
    seen.add(stage.id);
  }
  return stage;
}

/** The `add-stage` write for one more run stage of this role after the chain's last, guarded by the plan's digest. */
export function appendStageRequest(pipeline: Pipeline, roleId: PipelineRoleId, graphDigest: string): PatchPipelineRequest | null {
  const tail = passTail(pipeline);
  if (!tail) return null;
  const id = deriveStageId("run", roleId, new Set(pipeline.stages.map((stage) => stage.id)));
  return {
    action: "add-stage",
    stage: { id, kind: "run", role: { roleId }, "prompt": defaultStageWiring(1), next: null },
    after: tail.id,
    expectedStageDigest: graphDigest,
  };
}

/** Whether this lane is a draft this flow made: the only lanes these controls are drawn on. */
export function conversationDraftLane(pipeline: Pipeline): boolean {
  return pipeline.state === "draft" && Boolean(pipeline.conversationSource);
}

type Variant = "board" | "phone";

const PHONE_BUTTON = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[8px] px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";

/** «Start»: the engine's own `start`, sent once, after every first-message edit has settled. */
export function DraftStartButton({ pipeline, title, store, drafts, ports, variant }: {
  pipeline: Pipeline;
  title: string;
  store: ConversationDrafts;
  drafts: StageDrafts;
  ports: PipelinePorts;
  variant: Variant;
}) {
  const { t } = useLocale();
  const state = useDraftStart(store, pipeline.id);
  const unsaved = useUnsavedStageEdit(drafts, pipeline.id);
  const starting = state?.phase === "starting";
  const disabled = starting || unsaved || state?.phase === "unknown";
  const label = starting ? t("kanban.fromConversation.starting") : variant === "phone" ? t("pipelineStrip.start") : t("kanban.fromConversation.start");
  return (
    <button
      type="button"
      className={variant === "board" ? "btn primary draft-start" : `${PHONE_BUTTON} w-full bg-brand text-on-brand active:opacity-90`}
      data-draft-start={pipeline.id}
      data-draft-start-state={state?.phase ?? (unsaved ? "blocked" : "ready")}
      aria-label={t("kanban.fromConversation.startAria", { label, title })}
      aria-describedby={`draft-start-note-${pipeline.id}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void store.startDraft(pipeline, ports);
      }}
    >
      <Play className={variant === "board" ? undefined : "h-4 w-4"} aria-hidden />
      {label}
    </button>
  );
}

/** What stands between the lane and its start, beside Start: an unsaved first message, a refusal, a Start with no answer. */
export function DraftStartNote({ pipeline, store, drafts, ports, variant }: {
  pipeline: Pipeline;
  store: ConversationDrafts;
  drafts: StageDrafts;
  ports: PipelinePorts;
  variant: Variant;
}) {
  const { t } = useLocale();
  const state = useDraftStart(store, pipeline.id);
  const unsaved = useUnsavedStageEdit(drafts, pipeline.id);
  const id = `draft-start-note-${pipeline.id}`;
  const text = state?.phase === "refused"
    ? t("kanban.fromConversation.startRefused", { reason: state.error ?? "" })
    : state?.phase === "unknown" ? t("kanban.fromConversation.startUnknown")
      : unsaved && state?.phase !== "starting" ? t("kanban.fromConversation.startBlocked") : null;
  if (!text) return <span id={id} hidden />;
  const tone = state?.phase === "refused" ? "error" : state?.phase === "unknown" ? "warn" : "info";
  return (
    <p
      id={id}
      className={variant === "board" ? `draft-notice ${tone}` : `m-0 text-label ${tone === "error" ? "font-semibold text-danger" : tone === "warn" ? "font-semibold text-warning" : "text-muted"}`}
      role={tone === "error" ? "alert" : "status"}
      data-draft-start-note={state?.phase ?? "blocked"}
    >
      <span className={variant === "board" ? "msg-text" : undefined}>{text}</span>
      {state?.phase === "unknown" ? (
        <button type="button" className={variant === "board" ? undefined : `${PHONE_BUTTON} text-accent`} data-draft-start-check={pipeline.id} onClick={() => void store.checkStart(pipeline.id, ports)}>
          {t("kanban.pipelineAct.checkAgain")}
        </button>
      ) : null}
    </p>
  );
}

/** «+ Stage»: one more run stage after the chain's last, its role chosen from the catalog the pickers offer. */
export function AddStageControl({ pipeline, ports, variant }: { pipeline: Pipeline; ports: PipelinePorts; variant: Variant }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tail = passTail(pipeline);
  if (!tail) return null;
  const after = stageNames(t, pipeline).get(tail.id) ?? tail.id;
  const add = async (roleId: PipelineRoleId) => {
    setBusy(true);
    setError(null);
    const read = await ports.read(pipeline.id);
    const body = read?.graphDigest ? appendStageRequest(read.pipeline, roleId, read.graphDigest) : null;
    if (!body) {
      setBusy(false);
      setError(t("kanban.fromConversation.addFailed", { error: t("kanban.draft.failedRead") }));
      return;
    }
    const result = await ports.patch(pipeline.id, body);
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      return;
    }
    if (result.unknown || result.code === "STAGE_CHANGED") ports.refresh();
    setError(t("kanban.fromConversation.addFailed", { error: result.unknown ? t("kanban.fromConversation.reason.unreachable") : result.error }));
  };
  const listId = `add-stage-${pipeline.id}`;
  return (
    <div className={variant === "board" ? "draft-add-stage" : "flex flex-col gap-1.5"} data-draft-add-stage={pipeline.id}>
      <button
        type="button"
        className={variant === "board" ? "btn quiet" : `${PHONE_BUTTON} self-start bg-card text-secondary shadow-1 active:bg-sunken`}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={t("kanban.fromConversation.addStageAria", { stage: after })}
        data-draft-add-stage-toggle=""
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus className={variant === "board" ? undefined : "h-4 w-4"} aria-hidden />
        {busy ? t("kanban.fromConversation.adding") : t("kanban.fromConversation.addStage")}
      </button>
      {open ? (
        <div id={listId} role="group" aria-label={t("kanban.fromConversation.addStageTitle", { stage: after })} className={variant === "board" ? "roles" : "flex flex-wrap gap-1.5"} data-draft-add-stage-roles="">
          {PIPELINE_ROLE_OPTIONS.map((roleId) => (
            <button
              key={roleId}
              type="button"
              className={variant === "board" ? "btn" : `${PHONE_BUTTON} bg-quiet text-primary ring-1 ring-inset ring-border active:bg-sunken`}
              data-draft-add-role={roleId}
              disabled={busy}
              onClick={() => void add(roleId)}
            >
              {roleNameById(t, roleId)}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert" className={variant === "board" ? "draft-notice error" : "m-0 text-label font-semibold text-danger"} data-draft-add-stage-error="">{error}</p> : null}
    </div>
  );
}

/** A waiting stage's role and runtime, edited in the existing placeholder pane. */
export function DraftStageConfigure({ pipeline, stage }: { pipeline: Pipeline; stage: PipelineStage }) {
  return (
    <StagePlaceholderPane
      slot={{ key: `pipeline-config::${pipeline.id}::${stage.id}`, pipeline, stage, index: pipeline.stages.indexOf(stage), total: pipeline.stages.length, presentation: "placeholder", x: 0, y: 0, w: 0, h: 0 }}
      interactive
      flow
    />
  );
}

export function ConfigureToggle({ stage, name, open, onToggle }: { stage: PipelineStage; name: string; open: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" className="btn quiet" aria-pressed={open} aria-label={t("kanban.fromConversation.configureAria", { stage: name })} data-draft-configure={stage.id} onClick={onToggle}>
      <Settings2 aria-hidden />
      {t("kanban.fromConversation.configure")}
    </button>
  );
}
