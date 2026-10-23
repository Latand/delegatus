"use client";

import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { PipelineLinkSource } from "@/lib/pipelines/linkSource";
import type { Pipeline, PipelineRepoPreflightErrorCode } from "@/lib/pipelines/types";

import {
  PIPELINE_TEMPLATES,
  preflightPipelineRepository,
  resolvePipelineLinkSource,
  type PipelineClientResult,
  type PipelineDraftSource,
  type PipelineLinkClientResult,
  type PipelineTemplate,
} from "./pipelineModel";
import { Z } from "@/components/layers";

/* A paste resolves at once; typing waits this long after the last key. */
const LINK_SETTLE_MS = 350;

/** The last link read, kept with the link and checkout it answers for. */
type LinkAnswer = {
  link: string;
  repoDir: string;
  result: { ok: true; source: PipelineLinkSource } | { ok: false; message: string };
};

type LinkState =
  | { phase: "empty" }
  | { phase: "resolving"; repoDir: string }
  | { phase: "resolved"; repoDir: string; source: PipelineLinkSource; taskId: string | null }
  | { phase: "refused"; message: string };

function linkRefusal(result: Extract<PipelineLinkClientResult, { ok: false }>, t: TFunction): string {
  if (result.code === "failed") return result.error;
  return t(`pipelineLink.refused.${result.code}`, result.params ?? {});
}

type PickerState =
  | { phase: "checking" }
  | { phase: "ready"; repoDir: string }
  | { phase: "creating"; repoDir: string }
  | { phase: "blocked"; code: PipelineRepoPreflightErrorCode; path: string; error?: string };

/**
 * Template-first pipeline entry (issue #196): picking a template drops a DRAFT
 * pipeline on the canvas with the template's WHOLE role chain — every stage
 * lands as a dashed placeholder window before anything spawns. "Blank canvas"
 * keeps the #136 empty-draft path (assemble stages by hand). Bottom sheet on
 * the phone, centered dialog on desktop; every row is a 44px target.
 */
export function PipelineTemplatePicker({
  repoDir,
  onCreate,
  onCreated,
  onClose,
}: {
  repoDir: string;
  /** `from` carries a resolved PR or issue link; the result is still a draft. */
  onCreate: (template: PipelineTemplate | null, canonicalRepoDir: string, from?: PipelineDraftSource) => Promise<PipelineClientResult>;
  onCreated: (pipeline: Pipeline) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [repoInput, setRepoInput] = useState(repoDir);
  const [retry, setRetry] = useState(0);
  // An empty directory mounts already blocked (#404): "checking" — and its
  // spinner — exists only while a preflight request is actually in flight.
  const [state, setState] = useState<PickerState>(() =>
    repoDir.trim() ? { phase: "checking" } : { phase: "blocked", code: "missing", path: "" });
  const generation = useRef(0);
  const [linkInput, setLinkInput] = useState("");
  const [answer, setAnswer] = useState<LinkAnswer | null>(null);
  const [taskChoice, setTaskChoice] = useState<{ source: PipelineLinkSource; taskId: string | null } | null>(null);
  const pasted = useRef(false);

  useEffect(() => {
    const requestedRepo = repoInput.trim();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    if (!requestedRepo) return () => controller.abort();
    void preflightPipelineRepository(requestedRepo, controller.signal).then((result) => {
      if (currentGeneration !== generation.current || controller.signal.aborted) return;
      if (result.ok) setState({ phase: "ready", repoDir: result.repoDir });
      else setState({ phase: "blocked", code: result.code, path: result.path, error: result.error });
    }).catch((error) => {
      if (currentGeneration !== generation.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ phase: "blocked", code: "missing", path: requestedRepo, error: t("common.serverUnavailable") });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale copy is resolved when the request settles; repository generations drive this effect
  }, [repoInput, retry]);

  /* The link is read against the admitted checkout, never a typed path, and
     an answer counts only for the link and checkout it was read for. */
  const admittedRepo = state.phase === "ready" || state.phase === "creating" ? state.repoDir : null;
  const requestedLink = linkInput.trim();
  useEffect(() => {
    if (!requestedLink || !admittedRepo) return;
    const controller = new AbortController();
    const settle = pasted.current ? 0 : LINK_SETTLE_MS;
    pasted.current = false;
    const timer = setTimeout(() => {
      void resolvePipelineLinkSource(requestedLink, admittedRepo, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setAnswer({ link: requestedLink, repoDir: admittedRepo, result: result.ok ? result : { ok: false, message: linkRefusal(result, t) } });
      }).catch((error) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setAnswer({ link: requestedLink, repoDir: admittedRepo, result: { ok: false, message: t("common.serverUnavailable") } });
      });
    }, settle);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale copy is resolved when the request settles; the link and the admitted checkout drive this effect
  }, [requestedLink, admittedRepo]);
  const current = answer && answer.link === requestedLink && answer.repoDir === admittedRepo ? answer.result : null;
  const link: LinkState = !requestedLink || !admittedRepo ? { phase: "empty" }
    : !current ? { phase: "resolving", repoDir: admittedRepo }
    : current.ok ? { phase: "resolved", repoDir: admittedRepo, source: current.source,
      taskId: taskChoice && taskChoice.source === current.source ? taskChoice.taskId : current.source.tasks[0]?.id ?? null }
    : { phase: "refused", message: current.message };

  const creating = state.phase === "creating";
  /* A typed link must resolve first: a refused or unread link never falls
     back to a plain draft the operator did not ask for. */
  const ready = state.phase === "ready" && (link.phase === "empty" || link.phase === "resolved");
  const shownRepoDir = state.phase === "ready" || state.phase === "creating" ? state.repoDir : repoInput;
  const create = async (template: PipelineTemplate | null) => {
    if (state.phase !== "ready") return;
    const canonicalRepoDir = state.repoDir;
    const from = link.phase === "resolved" ? { source: link.source, taskId: link.taskId } : undefined;
    setState({ phase: "creating", repoDir: canonicalRepoDir });
    const result = await (from ? onCreate(template, canonicalRepoDir, from) : onCreate(template, canonicalRepoDir));
    if (result.pipeline) {
      onCreated(result.pipeline);
      return;
    }
    setState({
      phase: "blocked",
      code: result.code ?? "missing",
      path: result.path ?? canonicalRepoDir,
      error: result.code === "initialization_refused" || !result.code ? result.error : undefined,
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || creating) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creating, onClose]);
  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  const blockedPath = state.phase === "blocked" ? (state.path || shownRepoDir).trim() : "";
  const blockedMessage = state.phase === "blocked"
    ? state.error ?? (blockedPath
      ? t(`pipelinePreflight.${state.code}`, { path: blockedPath })
      : t("pipelinePreflight.empty"))
    : null;
  return (
    <div
      data-pipeline-picker-state={state.phase}
      className={`fixed inset-0 ${Z.modal} flex items-end justify-center bg-black/40 sm:items-center`}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineTemplates.title")}
        className="max-h-[100dvh] w-full max-w-[460px] overflow-y-auto overscroll-contain rounded-t-surface bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 sm:max-h-[calc(100dvh-2rem)] sm:rounded-surface sm:pb-3"
      >
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-title font-bold text-primary">{t("pipelineTemplates.title")}</div>
            <div className="text-ui text-muted">{t("pipelineTemplates.subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <label className="mb-2 flex flex-col gap-1">
          <span className="text-label font-semibold text-secondary">{t("pipelineTemplates.repoDir")}</span>
          <input
            value={shownRepoDir}
            disabled={creating}
            autoFocus={!repoDir.trim()}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setRepoInput(value);
              setState(value.trim()
                ? { phase: "checking" }
                : { phase: "blocked", code: "missing", path: "" });
            }}
            className="h-11 w-full rounded-control border border-border bg-canvas px-3 text-ui font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
        </label>
        <div className="mb-2 flex min-h-8 items-center gap-2 text-ui font-semibold text-muted" aria-live="polite">
          {state.phase === "checking" ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />{t("pipelineTemplates.checking")}</> : null}
          {state.phase === "ready" ? <span className="text-success">{t("pipelineTemplates.ready")}</span> : null}
          {state.phase === "creating" ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />{t("pipelineTemplates.creating")}</> : null}
          {state.phase === "blocked" ? (
            <span className="flex w-full items-start gap-2 rounded-control border border-danger/30 bg-danger-soft px-2 py-1.5 text-danger" role="alert">
              <span className="min-w-0 flex-1">{blockedMessage}</span>
              <button
                type="button"
                className="min-h-8 shrink-0 rounded-control border border-danger/30 px-2 text-label font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                onClick={() => {
                  // Retrying an empty input has no request to wait for (#404):
                  // stay blocked instead of stranding a "checking" spinner.
                  if (repoInput.trim()) setState({ phase: "checking" });
                  setRetry((value) => value + 1);
                }}
              >
                {t("pipelineTemplates.retry")}
              </button>
            </span>
          ) : null}
        </div>
        <label className="mb-2 flex flex-col gap-1">
          <span className="text-label font-semibold text-secondary">{t("pipelineLink.label")}</span>
          <input
            data-pipeline-link-input
            value={linkInput}
            disabled={creating}
            inputMode="url"
            spellCheck={false}
            placeholder={t("pipelineLink.placeholder")}
            onPaste={() => { pasted.current = true; }}
            onInput={(event) => setLinkInput(event.currentTarget.value)}
            className="h-11 w-full rounded-control border border-border bg-canvas px-3 text-ui font-semibold text-primary placeholder:font-normal placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
        </label>
        <LinkSourcePreview link={link} disabled={creating} onTask={(taskId) => { if (link.phase === "resolved") setTaskChoice({ source: link.source, taskId }); }} />
        <div className="flex flex-col gap-1">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={!ready}
              onClick={() => void create(template)}
              className="flex min-h-11 w-full flex-col justify-center gap-1 rounded-control px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            >
              <span className="text-body font-semibold text-primary">{t(template.labelKey)}</span>
              <span className="flex flex-wrap items-center gap-1" aria-hidden>
                {template.stages.map((stage, index) => (
                  <span key={index} className="flex items-center gap-1">
                    {index ? <span className="text-label font-bold text-strong">→</span> : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-caption font-semibold ${
                        stage.kind === "review-loop" ? "bg-accent-soft text-accent" : "bg-sunken text-secondary"
                      }`}
                    >
                      {stage.kind === "review-loop" ? "⟳ " : ""}
                      {stage.roleId || t("pipelineTemplates.noRole")}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled={!ready}
            onClick={() => void create(null)}
            className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-control border border-dashed border-strong px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
          >
            <span className="text-body font-semibold text-primary">{t("pipelineTemplates.blank")}</span>
            <span className="text-label text-muted">{t("pipelineTemplates.blankHint")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a pasted link resolved to: the repository, base and head the draft
 * will use, and the task it joins. Read-only apart from the task choice.
 */
function LinkSourcePreview({ link, disabled, onTask }: { link: LinkState; disabled: boolean; onTask: (taskId: string | null) => void }) {
  const { t } = useLocale();
  if (link.phase === "empty") return null;
  if (link.phase === "resolving") {
    return (
      <div data-pipeline-link-state="resolving" className="mb-2 flex min-h-8 items-center gap-2 text-ui font-semibold text-muted" aria-live="polite">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />{t("pipelineLink.resolving")}
      </div>
    );
  }
  if (link.phase === "refused") {
    return (
      <div data-pipeline-link-state="refused" role="alert" className="mb-2 rounded-control border border-danger/30 bg-danger-soft px-2 py-1.5 text-ui font-semibold text-danger">
        {link.message}
      </div>
    );
  }
  const { source } = link;
  const head = source.head;
  const row = "grid grid-cols-[minmax(72px,auto)_1fr] gap-x-2";
  return (
    <div data-pipeline-link-state="resolved" data-pipeline-link-source={source.kind} className="mb-2 flex flex-col gap-1.5 rounded-control border border-border bg-sunken px-3 py-2 text-ui">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-bold text-primary">{t(source.kind === "pr" ? "pipelineLink.pr" : "pipelineLink.issue", { number: source.number })}</span>
        <span className="text-label font-semibold text-muted">{t(`pipelineLink.state.${source.state}`)}</span>
      </div>
      <span className="break-words font-semibold text-primary">{source.title}</span>
      <dl className="flex flex-col gap-0.5 text-label">
        <div className={row}><dt className="text-muted">{t("pipelineLink.repository")}</dt><dd className="break-all font-semibold text-secondary">{source.repository}</dd></div>
        <div className={row}><dt className="text-muted">{t("pipelineLink.base")}</dt><dd className="break-all font-semibold text-secondary">{source.base.branch}</dd></div>
        <div className={row}>
          <dt className="text-muted">{t("pipelineLink.head")}</dt>
          <dd className="break-all font-semibold text-secondary">{head ? `${head.branch} · ${head.sha.slice(0, 7)}` : t("pipelineLink.headNew")}</dd>
        </div>
        {head?.fork ? (
          <div className={row}>
            <dt className="text-muted">{t("pipelineLink.pushesTo")}</dt>
            <dd data-pipeline-link-fork className="break-all font-semibold text-secondary">{`${t("pipelineLink.fork", { repository: head.repository })} · ${head.remote}`}</dd>
          </div>
        ) : null}
      </dl>
      {head?.fork && head.maintainerCanModify === false ? (
        <span data-pipeline-link-warning className="text-label font-semibold text-warning">{t("pipelineLink.forkLocked")}</span>
      ) : null}
      {source.tasks.length ? (
        <fieldset data-pipeline-link-task className="flex flex-col gap-0.5" disabled={disabled}>
          <legend className="mb-0.5 text-label font-semibold text-secondary">{t("pipelineLink.task")}</legend>
          {[...source.tasks.map((task) => ({ id: task.id as string | null, text: task.text })), { id: null, text: t("pipelineLink.taskNone") }].map((option) => (
            <label key={option.id ?? ""} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 hover:bg-canvas">
              <input
                type="radio"
                name="pipeline-link-task"
                value={option.id ?? ""}
                checked={link.taskId === option.id}
                onChange={() => onTask(option.id)}
                className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              <span className={`min-w-0 flex-1 break-words text-ui ${option.id ? "font-semibold text-primary" : "text-muted"}`}>{option.text}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <span data-pipeline-link-no-task className="text-label text-muted">{t("pipelineLink.noTask")}</span>
      )}
      <span className="text-label text-muted">{t(head ? "pipelineLink.startHintPr" : "pipelineLink.startHintIssue")}</span>
    </div>
  );
}
