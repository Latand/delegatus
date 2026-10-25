"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronLeft, ChevronRight } from "@/components/icons";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import { stageChipLabel } from "./pipelineModel";

/*
 * Where a lane's heavy checks run (docs/design/cloud-checks.md): the project
 * default, the lane's own choice, and the choice of the stage the lane stands
 * on, which is the stage its publication runs for (LLV_GATE_STAGE_ID). The
 * effective value is the stage's, else the lane's, else the project's, as
 * scripts/cloud-check-settings.ts resolves it.
 */
export type CheckExecution = "cloud" | "local";
export type CheckScope = "stage" | "lane" | "project";
export interface CheckSettings {
  project: CheckExecution;
  override: CheckExecution | null;
  stageOverride?: CheckExecution | null;
  effective: CheckExecution;
}
/* A read still out and a read that failed are separate states; neither is an
   answer, so neither shows a choice. */
export type CheckSettingsRead = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; settings: CheckSettings };

const isExecution = (value: unknown): value is CheckExecution => value === "cloud" || value === "local";
function parseSettings(value: unknown): CheckSettings | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!isExecution(body.project) || !isExecution(body.effective) || !(body.override === null || isExecution(body.override))) return null;
  if (body.stageOverride !== undefined && !(body.stageOverride === null || isExecution(body.stageOverride))) return null;
  return { project: body.project, override: body.override, effective: body.effective, ...(body.stageOverride !== undefined ? { stageOverride: body.stageOverride } : {}) };
}

/** The stage a lane's publication runs for: the one its cursor stands on. */
export const publishingStage = (pipeline: Pipeline): string | null => pipeline.cursor?.stageId ?? null;

/**
 * The lane's check settings while `enabled` (its menu is open): read once on
 * opening and again when the publishing stage moves, written through the same
 * route the MCP tool uses. An answer that belongs to an older read or write
 * is dropped.
 */
export function usePipelineChecks(pipelineId: string, stageId: string | null, enabled: boolean) {
  /* Each opening is a fresh read: the generation counts the times `enabled` turned on. */
  const [opening, setOpening] = useState({ enabled, generation: enabled ? 1 : 0 });
  if (opening.enabled !== enabled) setOpening({ enabled, generation: opening.generation + (enabled ? 1 : 0) });
  const [attempt, setAttempt] = useState(0);
  const url = `/api/pipelines/${encodeURIComponent(pipelineId)}/checks`;
  /* Every answer is kept under the read it belongs to, so one for an older
     opening, stage or retry is never shown. */
  const key = enabled ? `${url} ${stageId ?? ""} ${opening.generation} ${attempt}` : null;
  const [answer, setAnswer] = useState<{ key: string; read: CheckSettingsRead; saving: boolean; saveFailed: boolean } | null>(null);
  const current = key !== null && answer?.key === key ? answer : null;
  const latest = useRef(0);
  useEffect(() => {
    if (key === null) return;
    const seq = ++latest.current;
    void fetch(stageId ? `${url}?stageId=${encodeURIComponent(stageId)}` : url).then(async (response) => {
      const settings = response.ok ? parseSettings(await response.json()) : null;
      if (seq !== latest.current) return;
      setAnswer({ key, read: settings ? { kind: "ready", settings } : { kind: "failed" }, saving: false, saveFailed: false });
    }).catch(() => { if (seq === latest.current) setAnswer({ key, read: { kind: "failed" }, saving: false, saveFailed: false }); });
    return () => { latest.current += 1; };
  }, [key, url, stageId]);
  const save = useCallback(async (scope: CheckScope, execution: CheckExecution | null) => {
    if (key === null) return;
    const seq = ++latest.current;
    const settle = (next: (previous: NonNullable<typeof answer>) => NonNullable<typeof answer>) =>
      setAnswer((previous) => (previous && previous.key === key ? next(previous) : previous));
    settle((previous) => ({ ...previous, saving: true, saveFailed: false }));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, execution, ...(stageId ? { stageId } : {}) }),
      });
      const settings = response.ok ? parseSettings(await response.json()) : null;
      if (seq !== latest.current) return;
      settle((previous) => (settings ? { key, read: { kind: "ready", settings }, saving: false, saveFailed: false } : { ...previous, saving: false, saveFailed: true }));
    } catch {
      if (seq === latest.current) settle((previous) => ({ ...previous, saving: false, saveFailed: true }));
    }
  }, [key, url, stageId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { read: current?.read ?? { kind: "loading" } as CheckSettingsRead, saving: current?.saving ?? false, saveFailed: current?.saveFailed ?? false, save, reload };
}

/** Words that differ by surface: the board names a lane «pipeline», the phone «lane». */
export interface CheckTerms {
  laneHeading: MessageKey;
  stageInherit: MessageKey;
}
export const STRIP_CHECK_TERMS: CheckTerms = { laneHeading: "pipelineStrip.checksLane", stageInherit: "pipelineStrip.checksStageInherit" };

export interface CheckChoice { key: string; label: string; checked: boolean; execution: CheckExecution | null }
export interface CheckChoiceGroup { scope: CheckScope; heading: string; choices: CheckChoice[] }

export const checkValueLabel = (t: TFunction, value: CheckExecution): string => t(value === "cloud" ? "pipelineStrip.checksCloud" : "pipelineStrip.checksLocal");

/** The radio groups of the checks face: the publishing stage's (when the lane
    stands on one), the lane's, and the project default. Each inherited choice
    names the value it resolves to. */
export function checkChoiceGroups(t: TFunction, terms: CheckTerms, settings: CheckSettings, stageName: string | null): CheckChoiceGroup[] {
  const laneValue = settings.override ?? settings.project;
  const options = (current: CheckExecution | null, inherit: { label: string } | null): CheckChoice[] => [
    ...(inherit ? [{ key: "inherit", label: inherit.label, checked: current === null, execution: null }] : []),
    ...(["cloud", "local"] as const).map((value) => ({ key: value, label: checkValueLabel(t, value), checked: current === value, execution: value })),
  ];
  return [
    ...(stageName !== null ? [{
      scope: "stage" as const,
      heading: t("pipelineStrip.checksStage", { stage: stageName }),
      choices: options(settings.stageOverride ?? null, { label: t(terms.stageInherit, { value: checkValueLabel(t, laneValue) }) }),
    }] : []),
    { scope: "lane", heading: t(terms.laneHeading), choices: options(settings.override, { label: t("pipelineStrip.checksLaneInherit", { value: checkValueLabel(t, settings.project) }) }) },
    { scope: "project", heading: t("pipelineStrip.checksProject"), choices: options(settings.project, null) },
  ];
}

/** The checks row's trailing word for each read state. */
export function checkRowValue(t: TFunction, read: CheckSettingsRead): string {
  if (read.kind === "loading") return t("pipelineStrip.checksLoading");
  if (read.kind === "failed") return t("pipelineStrip.checksRetry");
  return checkValueLabel(t, read.settings.effective);
}

const ROW = "flex min-h-9 w-full items-center gap-2 rounded-control px-2 text-left text-ui font-semibold hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The board's ⋯ menu, with the checks row first: «Checks · Cloud» opens the
 * checks face in place of the lane's actions (`children`), as the runtime
 * pill's submenus do, and its back row returns to them.
 */
export function PipelineCheckMenu({ pipeline, firstRef, children }: {
  pipeline: Pipeline;
  firstRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const [face, setFace] = useState<"actions" | "checks">("actions");
  const stageId = publishingStage(pipeline);
  const checks = usePipelineChecks(pipeline.id, stageId, true);
  const backRef = useRef<HTMLButtonElement>(null);
  const switched = useRef(false);
  useLayoutEffect(() => {
    if (!switched.current) return;
    (face === "checks" ? backRef : firstRef).current?.focus();
  }, [face, firstRef]);
  const show = (next: "actions" | "checks") => { switched.current = true; setFace(next); };
  const value = checkRowValue(t, checks.read);
  if (face === "actions") {
    return <>
      <button
        ref={firstRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-label={t("pipelineStrip.checksAria", { value })}
        aria-busy={checks.read.kind === "loading" || undefined}
        aria-disabled={checks.read.kind === "loading" || undefined}
        data-pipeline-checks-row={checks.read.kind}
        onClick={() => {
          if (checks.read.kind === "failed") checks.reload();
          else if (checks.read.kind === "ready") show("checks");
        }}
        className={`${ROW} text-secondary`}
      >
        <span className="min-w-0 flex-1 truncate">{t("pipelineStrip.checks")}</span>
        <span className={`shrink-0 text-caption ${checks.read.kind === "failed" ? "text-accent" : "text-muted"}`}>{value}</span>
        {checks.read.kind === "ready" ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden /> : null}
      </button>
      {checks.read.kind === "failed" ? <span role="alert" data-pipeline-checks-error="load" className="px-2 pb-1 text-caption font-semibold text-danger">{t("pipelineStrip.checksLoadFailed")}</span> : null}
      {children}
    </>;
  }
  /* The stage as the strip's own chip names it. */
  const stage = stageId ? pipeline.stages.find((entry) => entry.id === stageId) : undefined;
  const stageName = stageId ? (stage ? stageChipLabel(t, stage) : stageId) : null;
  return <>
    <button
      ref={backRef}
      type="button"
      role="menuitem"
      aria-label={t("pipelineStrip.checksBack")}
      data-pipeline-checks-back=""
      onClick={() => show("actions")}
      className={`${ROW} gap-1 text-secondary`}
    >
      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      {t("pipelineStrip.checks")}
    </button>
    {checks.read.kind === "ready" ? checkChoiceGroups(t, STRIP_CHECK_TERMS, checks.read.settings, stageName).map((group) => (
      <span key={group.scope} role="group" aria-labelledby={`checks-${pipeline.id}-${group.scope}`} data-pipeline-checks-group={group.scope} className="flex flex-col border-t border-border pt-1">
        <span id={`checks-${pipeline.id}-${group.scope}`} title={group.heading} className="truncate px-2 py-1 text-caption font-semibold text-muted">{group.heading}</span>
        {group.choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            role="menuitemradio"
            aria-checked={choice.checked}
            disabled={checks.saving}
            data-pipeline-checks-choice={`${group.scope}:${choice.key}`}
            onClick={() => { if (!choice.checked) void checks.save(group.scope, choice.execution); }}
            className={`${ROW} ${choice.checked ? "text-primary" : "text-secondary"}`}
          >
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
            {choice.checked ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden /> : null}
          </button>
        ))}
      </span>
    )) : null}
    {checks.read.kind === "failed" ? <span role="alert" data-pipeline-checks-error="load" className="px-2 pb-1 text-caption font-semibold text-danger">{t("pipelineStrip.checksLoadFailed")}</span> : null}
    {checks.saveFailed ? <span role="alert" data-pipeline-checks-error="save" className="px-2 pb-1 text-caption font-semibold text-danger">{t("pipelineStrip.checksSaveFailed")}</span> : null}
  </>;
}
