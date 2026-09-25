"use client";

import { useState } from "react";

import { Select } from "@/components/ui/Select";
import { MAX_FAIL_EDGE_ROUNDS } from "@/lib/pipelines/limits";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineFailEdgeExhaustion, PipelineStage } from "@/lib/pipelines/types";

import { setPipelineEdge, stageAttempts, stageChipLabel, stageFailEdgeFrozen } from "./pipelineModel";

/** What a spent budget does, as the board offers it (#2187 §3.3): the fix
    stage always takes the last findings, and the choice is whether the lane
    then goes on or waits for the operator. `park` stays readable, not offered. */
const EXHAUSTION_CHOICES = ["advance", "stop-after-fix"] as const satisfies readonly PipelineFailEdgeExhaustion[];

/**
 * Keyboard/mobile-safe edge editing (#353): the stage config card's "Connect"
 * pickers rewire the stage's pass edge (direct links, merges — the server
 * validates acyclicity) and fail edge (cycles, with a bounded round budget and
 * what a spent budget does: fix once more and go on, or fix and wait for the
 * operator, #1868, #2187).
 * Frozen edges — a pass edge on a stage that already ran, a fail edge already
 * traversed — render as disabled with an explanation, mirroring the API's
 * evidence-freeze guards so the control never fires a PATCH the server rejects.
 */
export function StageEdgeControls({
  pipeline,
  stage,
  disabled = false,
}: {
  pipeline: Pipeline;
  stage: PipelineStage;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = pipeline.state === "completed" || pipeline.state === "closed";
  const passFrozen = stageAttempts(pipeline, stage.id).length > 0;
  const failFrozen = stageFailEdgeFrozen(pipeline, stage);
  /* A pass edge targets a different stage so the pass graph stays acyclic. A fail
     edge legally loops back to the stage itself, the only cycle a one-stage
     pipeline can carry (#353), so the fail picker offers the current stage and
     the pass picker omits it. */
  const passTargets = pipeline.stages.filter((candidate) => candidate.id !== stage.id);
  const failTargets = pipeline.stages;
  const apply = async (edge: "pass" | "fail", to: string | null, maxRounds?: number, onExhausted?: PipelineFailEdgeExhaustion) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setError(await setPipelineEdge(pipeline, stage.id, edge, to, maxRounds, onExhausted));
    setBusy(false);
  };
  const exhaustion: PipelineFailEdgeExhaustion = stage.onFail?.onExhausted ?? "advance";
  const fieldLabel = "text-caption font-semibold text-muted";
  const selectClass = "w-full";

  return (
    <div data-stage-edges className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-2.5 py-1.5" aria-label={t("pipelineSlot.connectHeading")}>
      <span className="text-caption font-bold uppercase tracking-wide text-muted">{t("pipelineSlot.connectHeading")}</span>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[140px] flex-1 flex-col gap-1">
          <span className={fieldLabel}>{t("pipelineSlot.passEdgeLabel")}</span>
          <Select
            className={selectClass}
            value={stage.next ?? ""}
            disabled={disabled || busy || terminal || passFrozen}
            onChange={(event) => void apply("pass", event.target.value || null)}
          >
            <option value="">{t("pipelineSlot.passEdgeEnd")}</option>
            {passTargets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{stageChipLabel(t, candidate)}</option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-[140px] flex-1 flex-col gap-1">
          <span className={fieldLabel}>{t("pipelineSlot.failEdgeLabel")}</span>
          <Select
            className={selectClass}
            value={stage.onFail?.to ?? ""}
            disabled={disabled || busy || terminal || failFrozen}
            onChange={(event) => void apply(
              "fail",
              event.target.value || null,
              event.target.value ? stage.onFail?.maxRounds : undefined,
              event.target.value ? stage.onFail?.onExhausted : undefined,
            )}
          >
            <option value="">{t("pipelineSlot.failEdgeNone")}</option>
            {failTargets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.id === stage.id ? t("pipelineSlot.failEdgeSelf") : stageChipLabel(t, candidate)}
              </option>
            ))}
          </Select>
        </label>
        {stage.onFail ? (
          <label className="flex w-[92px] flex-col gap-1">
            <span className={fieldLabel}>{t("pipelineSlot.failEdgeRounds")}</span>
            <input
              type="number"
              min={1}
              max={MAX_FAIL_EDGE_ROUNDS}
              value={stage.onFail.maxRounds}
              disabled={disabled || busy || terminal || failFrozen}
              onChange={(event) => {
                const rounds = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_FAIL_EDGE_ROUNDS) {
                  void apply("fail", stage.onFail!.to, rounds, stage.onFail!.onExhausted);
                }
              }}
              className="h-7 w-full rounded-control border border-border bg-canvas px-2 text-ui font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
            />
          </label>
        ) : null}
        {stage.onFail ? (
          /* Its own row at 210 px or more (#2187 §3.3): beside the other edge
             fields the Ukrainian option wrapped inside a 170 px select. */
          <label className="flex min-w-[210px] basis-full flex-col gap-1" data-edge-exhausted>
            <span className={fieldLabel}>{t("pipelineSlot.failEdgeExhausted")}</span>
            <Select
              className={selectClass}
              value={exhaustion}
              disabled={disabled || busy || terminal || failFrozen}
              onChange={(event) => void apply("fail", stage.onFail!.to, stage.onFail!.maxRounds, event.target.value as PipelineFailEdgeExhaustion)}
            >
              {EXHAUSTION_CHOICES.map((choice) => (
                <option key={choice} value={choice} title={t(`pipelineSlot.failEdgeExhaustedHint.${choice}`)}>{t(`pipelineSlot.failEdgeExhaustedOption.${choice}`)}</option>
              ))}
              {/* A stored `park` edge reads as what it is; the board no longer offers it. */}
              {exhaustion === "park" ? <option value="park" disabled>{t("pipelineSlot.failEdgeExhaustedOption.park")}</option> : null}
            </Select>
            <span className="text-caption font-medium text-muted" data-edge-exhausted-hint={exhaustion}>{t(`pipelineSlot.failEdgeExhaustedHint.${exhaustion}`)}</span>
          </label>
        ) : null}
      </div>
      {passFrozen && !terminal ? <span className="text-caption font-medium text-muted">{t("pipelineSlot.passEdgeFrozen")}</span> : null}
      {failFrozen && !terminal ? <span className="text-caption font-medium text-muted">{t("pipelineSlot.failEdgeFrozen")}</span> : null}
      {error ? <span role="alert" className="text-caption font-semibold text-danger">{error}</span> : null}
    </div>
  );
}
