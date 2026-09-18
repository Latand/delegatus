import { ENGINE_MODELS, defaultModelFor } from "@/lib/agent/models";
import { edgeRoundsUsed } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineEdgeKind, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

import { operationalAttempts } from "./pipelineGraph";

/*
 * Who runs a stage, and how hard it thinks (#1743): the one rule every drawn
 * surface reads — the graph node on the card and in the modal, the minimized
 * chip, the modal's nav chip and the pane header.
 *
 * The rule has one shape and two sources. A stage that has launched shows the
 * values its latest own attempt was actually bound to (`attempt.effectiveRole`,
 * account-driven fallbacks included), so an edit made after the launch never
 * rewrites history. A stage that has not launched shows its configuration,
 * marked as configuration so the surface can mute it. When the two differ, the
 * launched values stay on the node and a separate `next` carries what the next
 * attempt would run — the edit is visible without pretending it already ran.
 *
 * Pure: no DOM, no React, no i18n. The components decide how to draw it.
 */

export type IdentitySource = "launched" | "configured";

export interface StageRunValues {
  engine: string;
  /** The raw model id as recorded or configured, or the engine default when blank. */
  model: string;
  /** The catalogue's short label, or the raw id for an uncatalogued model. */
  modelLabel: string;
  /** The raw CLI effort token, "" when none is recorded. */
  effort: string;
}

export interface StageIdentityView extends StageRunValues {
  /** Where the drawn values came from. */
  source: IdentitySource;
  /** The model is the engine's own default, so a minimized chip may drop it. */
  modelIsDefault: boolean;
  /** Set when the stage's configuration has moved on from what last launched. */
  next: StageRunValues | null;
}

/** An attempt that was bound but never left the queue carries no launched truth. */
const LAUNCHED = (attempt: PipelineStageAttempt) => attempt.state !== "pending";

function shortLabel(engine: string, model: string): string {
  const catalogue = engine === "claude" || engine === "codex" ? ENGINE_MODELS[engine] : [];
  return catalogue.find((option) => option.id === model)?.shortLabel ?? model;
}

function valuesOf(role: { engine: string; model: string | null; effort: string | null }): StageRunValues {
  const engine = role.engine;
  const fallback = engine === "claude" || engine === "codex" ? defaultModelFor(engine) : "";
  const model = (role.model ?? "").trim() || fallback;
  return { engine, model, modelLabel: shortLabel(engine, model), effort: (role.effort ?? "").trim() };
}

const sameValues = (a: StageRunValues, b: StageRunValues) =>
  a.engine === b.engine && a.model === b.model && a.effort === b.effort;

/**
 * What a stage says it runs on. `launched` wins over `configured`, and a
 * configuration that has moved on since the launch becomes `next`.
 */
export function stageIdentity(pipeline: Pipeline, stage: PipelineStage): StageIdentityView {
  const configured = valuesOf(stage.effectiveRole);
  const launchedAttempt = operationalAttempts(pipeline, stage.id).filter(LAUNCHED).at(-1) ?? null;
  if (!launchedAttempt) {
    return { ...configured, source: "configured", modelIsDefault: isDefaultModel(configured), next: null };
  }
  const launched = valuesOf(launchedAttempt.effectiveRole);
  return {
    ...launched,
    source: "launched",
    modelIsDefault: isDefaultModel(launched),
    next: sameValues(launched, configured) ? null : configured,
  };
}

function isDefaultModel(values: StageRunValues): boolean {
  const engine = values.engine;
  if (engine !== "claude" && engine !== "codex") return false;
  return values.model === defaultModelFor(engine);
}

/* ── Edge counts ──────────────────────────────────────────────────────────── */

export interface EdgeCount {
  /** Times the edge fired, from the attempts' `activatedBy` provenance. */
  fired: number;
  /** A fail edge's configured budget; null on a pass edge, which has none. */
  max: number | null;
  /** The edge has been travelled at least once, so it is drawn as travelled. */
  travelled: boolean;
  /** A fail edge whose budget is spent: no return is left. */
  exhausted: boolean;
}

/**
 * How often an edge fired and what is left of its budget — the one reading the
 * arrow, the loop chip and the legend all draw. The count is never guessed from
 * attempt totals: it comes from {@link edgeRoundsUsed}, the engine's own rule,
 * so a manual retry of the target (a fresh attempt carrying the same activation)
 * spends no round and adds no number to the arrow.
 */
export function edgeCount(
  pipeline: Pipeline,
  edge: { from: string; to: string; kind: PipelineEdgeKind; maxRounds?: number | null },
): EdgeCount {
  const fired = edgeRoundsUsed(pipeline, edge);
  const max = edge.kind === "fail" ? edge.maxRounds ?? null : null;
  return { fired, max, travelled: fired > 0, exhausted: max !== null && fired >= max };
}
