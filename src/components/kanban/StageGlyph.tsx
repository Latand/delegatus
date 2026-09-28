"use client";

import { useId } from "react";

import { useLocale } from "@/lib/i18n";
import { STAGE_MARK } from "@/components/pipelines/pipelineBlockModel";
import type { StageChipState } from "@/components/pipelines/pipelineModel";

import { svgProps } from "./kanbanGlyphs";
import { GLYPH_STATE, modelGlyphKind, modelGlyphName, type ModelGlyphKind } from "./modelGlyph";
import { STAGE_TONE } from "./pipelineGraph";

/*
 * The mark in front of a stage: the model that runs it, drawn, in the state it
 * is in (docs/design/model-glyphs.md). One component for the graph node, the
 * Stages sheet, the card's pills, the task row and the phone, so a stage reads
 * the same wherever it is drawn.
 *
 * The four Claude glyphs share the orange family and are built from one
 * figure, the spark, counted like the literary form each model is named after;
 * Fable, a form with no line count, is drawn as the fable's own animal. The
 * Codex line is its sky: Sol a yellow sun, Astra a blue-white star, Terra the
 * Earth, Luna the Moon. A model with no glyph keeps the stage dot or mark the
 * host always drew, so nothing changes for it.
 *
 * Every drawing is original, on a 16-unit grid, painted through the `--glyph-*`
 * tokens (tokens.css) so both themes re-tint it in one place.
 */

const LIVE_CHIP_STATES = new Set<StageChipState>(["running", "reviewing", "committing"]);

/** The mark in front of a stage's name when no model glyph applies: its shape
    carries the state and its colour is the stage's `STAGE_TONE`, the one tone
    map the graph reads. `live` marks work in flight where the state alone does
    not say so: a settled stage whose conversation works again (#1744). */
export function StageToneMark({ state, className, live = false }: { state: StageChipState; className?: string; live?: boolean }) {
  const shape = STAGE_MARK[state];
  return (
    <i
      className={`pmark tone-${STAGE_TONE[state]}${className ? ` ${className}` : ""}`}
      data-mark={shape}
      data-live={live || LIVE_CHIP_STATES.has(state) ? "1" : undefined}
      aria-hidden="true"
    >
      {shape === "check" ? <svg {...svgProps} strokeWidth={3}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : null}
      {shape === "cross" ? <svg {...svgProps} strokeWidth={3}><path d="M17 7 7 17M7 7l10 10" /></svg> : null}
      {shape === "alert" ? <span className="pmark-bang">!</span> : null}
    </i>
  );
}

/** The model a stage runs on, as the glyph reads it. */
export interface GlyphModel {
  engine: string;
  model: string;
}

/**
 * The stage's glyph, or the host's own mark when its model has none.
 *
 * `fallback` names that mark: `mark` is {@link StageToneMark} (pills, strips,
 * the phone's rows), `dot` the plain dot the graph node and the Stages sheet
 * drew. `live` animates a settled stage whose conversation works again.
 *
 * Like the dot it replaces, the glyph is decoration by default: its hosts
 * already say the model and the state, in their label or their visible text
 * (the stage's identity sentence and its state word), and the card's line is
 * passive text with nothing in it for a screen reader to stop on. `named`
 * gives the glyph its own name ("Opus 5.5: running") where no host does.
 */
export function StageGlyph({ state, model, live = false, fallback, named = false, className }: {
  state: StageChipState;
  model: GlyphModel | null;
  live?: boolean;
  fallback: "mark" | "dot";
  named?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  const kind = model ? modelGlyphKind(model.engine, model.model) : null;
  if (!kind || !model) {
    return fallback === "mark"
      ? <StageToneMark state={state} live={live} className={className} />
      : <i className={`pdot${className ? ` ${className}` : ""}`} aria-hidden="true" />;
  }
  const reading = GLYPH_STATE[state];
  const moving = live || reading === "running";
  const name = named
    ? { role: "img" as const, "aria-label": t("kanban.modelGlyph.aria", { model: modelGlyphName(model.engine, model.model), state: t(`kanban.graphState.${state}`) }) }
    : { "aria-hidden": true as const };
  return (
    <span
      className={`mglyph g-${kind} tone-${STAGE_TONE[state]}${className ? ` ${className}` : ""}`}
      data-glyph={kind}
      data-glyph-engine={model.engine}
      data-glyph-state={reading}
      data-live={moving ? "1" : undefined}
      {...name}
    >
      <GlyphDrawing kind={kind} />
      {reading === "passed" || reading === "failed" || reading === "needs" ? <StateBadge reading={reading} /> : null}
    </span>
  );
}

/* A settled state rides the glyph's corner as a badge in the stage's tone, in
   the shape the stage mark already gave it: a tick, a cross, a bang. */
function StateBadge({ reading }: { reading: "passed" | "failed" | "needs" }) {
  return (
    <span className="mg-badge" aria-hidden="true">
      {reading === "passed" ? <svg viewBox="0 0 8 8"><path d="m1.9 4.1 1.4 1.4 2.9-3" /></svg> : null}
      {reading === "failed" ? <svg viewBox="0 0 8 8"><path d="m2.4 2.4 3.2 3.2m0-3.2L2.4 5.6" /></svg> : null}
      {reading === "needs" ? <svg viewBox="0 0 8 8"><path d="M4 1.9v2.3" /><circle cx="4" cy="6" r=".55" /></svg> : null}
    </span>
  );
}

/* ── Geometry ──────────────────────────────────────────────────────────────
   Angles are degrees clockwise from twelve o'clock around the grid's centre. */

const r2 = (value: number) => Math.round(value * 100) / 100;
function at(radius: number, degrees: number, cx = 8, cy = 8): [number, number] {
  const angle = (degrees * Math.PI) / 180;
  return [r2(cx + radius * Math.sin(angle)), r2(cy - radius * Math.cos(angle))];
}

/** A lens-shaped petal from the centre out to `length`, `width` across at its middle. */
function petal(degrees: number, length: number, width: number, cx = 8, cy = 8): string {
  const [tx, ty] = at(length, degrees, cx, cy);
  const [mx, my] = at(length / 2, degrees, cx, cy);
  const angle = (degrees * Math.PI) / 180;
  const [px, py] = [Math.cos(angle) * width, Math.sin(angle) * width];
  return `M${cx} ${cy}Q${r2(mx + px)} ${r2(my + py)} ${tx} ${ty}Q${r2(mx - px)} ${r2(my - py)} ${cx} ${cy}Z`;
}

/** A star whose points alternate between the given outer radii and one inner radius. */
function star(outer: readonly number[], inner: number): string {
  const step = 360 / outer.length;
  const points = outer.flatMap((radius, index) => [at(radius, index * step), at(inner, index * step + step / 2)]);
  return `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
}

const every = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => offset + (index * 360) / count);

/* Opus, the complete work: eight full petals, nothing left short. */
const OPUS = every(8).map((degrees) => petal(degrees, 7.5, 1.6)).join("");
/* Sonnet, iambic pentameter: five feet of short then long, ten rays. */
const SONNET_SHORT = every(5, 36).map((degrees) => [at(2.4, degrees), at(4.9, degrees)]);
const SONNET_LONG = every(5).map((degrees) => [at(2.4, degrees), at(7.3, degrees)]);
/* Haiku, three lines of five, seven and five: three petals, the middle one longest. */
const HAIKU_CENTRE = [8, 8.9] as const;
const HAIKU = [petal(0, 7.6, 1.9, ...HAIKU_CENTRE), petal(120, 5.4, 1.65, ...HAIKU_CENTRE), petal(240, 5.4, 1.65, ...HAIKU_CENTRE)].join("");
/* Fable: the fox of the fables, ears up, chin down; eyes and inner ears are cut out. */
const FOX_HEAD = "M8 5L11.6 3.1L13.7 1.3L14.1 6.4Q15.3 7.9 14.4 9L8.9 14.2Q8 15 7.1 14.2L1.6 9Q.7 7.9 1.9 6.4L2.3 1.3L4.4 3.1Z";
const FOX_CUTS = "M3.2 3.2L3.1 5.5L4.8 4.2ZM12.8 3.2L12.9 5.5L11.2 4.2ZM4.3 8.4Q5.4 7.2 6.5 8.4Q5.4 9.1 4.3 8.4ZM9.5 8.4Q10.6 7.2 11.7 8.4Q10.6 9.1 9.5 8.4Z";
/* Sol: a round sun and eight detached rays. */
const SOL_RAYS = every(8, 22.5).map((degrees) => [at(5.3, degrees), at(7.3, degrees)]);
/* Astra: a blue-white star, four long points and four short. */
const ASTRA = star([7.8, 4.4, 7.8, 4.4, 7.8, 4.4, 7.8, 4.4], 1.9);
/* Terra: land drawn twice across one turn, so it can slide round the disc. */
const TERRA_LAND = "M1.4 4.6Q3.6 3.4 5.3 4.4Q6.1 5.7 4.9 6.9Q3.6 7.6 4.1 9.2Q4.6 10.9 3.3 11.9Q1.8 11.2 1.2 8.9ZM8.2 2.4Q10.6 2 12.2 3.6Q11.6 5 10 5Q9.2 6.2 10.4 7.4Q12.2 7.6 12.6 9.4Q12 11.8 10.2 13.3Q9 12 9.3 10.3Q8.3 9 7.3 8.1Q6.9 6.2 8 5.2Q7.4 3.6 8.2 2.4Z";

const lines = (segments: ReadonlyArray<readonly (readonly [number, number])[]>) =>
  segments.map(([[x1, y1], [x2, y2]]) => `M${x1} ${y1}L${x2} ${y2}`).join("");

function GlyphDrawing({ kind }: { kind: ModelGlyphKind }) {
  /* Terra's clip and Luna's phase mask need an id of their own per instance. */
  const id = `mg${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  switch (kind) {
    case "opus":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <g className="mg-turn"><path className="mg-fill" d={OPUS} /><circle className="mg-fill" cx="8" cy="8" r="1.7" /></g>
        </svg>
      );
    case "sonnet":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-ray mg-long" d={lines(SONNET_LONG)} />
          <path className="mg-ray mg-short" d={lines(SONNET_SHORT)} />
        </svg>
      );
    case "haiku":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <g className="mg-sway"><path className="mg-fill" d={HAIKU} /><circle className="mg-fill" cx={HAIKU_CENTRE[0]} cy={HAIKU_CENTRE[1]} r="1.5" /></g>
        </svg>
      );
    case "fable":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-fill mg-tilt" fillRule="evenodd" d={`${FOX_HEAD}${FOX_CUTS}`} />
        </svg>
      );
    case "sol":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-ray mg-turn" d={lines(SOL_RAYS)} />
          <circle className="mg-disc" cx="8" cy="8" r="3.5" />
        </svg>
      );
    case "astra":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-fill mg-twinkle" d={ASTRA} />
          <circle className="mg-core" cx="8" cy="8" r="1.6" />
        </svg>
      );
    case "terra":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <defs><clipPath id={id}><circle cx="8" cy="8" r="6.6" /></clipPath></defs>
          <circle className="mg-sea" cx="8" cy="8" r="6.6" />
          <g clipPath={`url(#${id})`}>
            <g className="mg-spin"><path className="mg-land" d={TERRA_LAND} /><path className="mg-land" d={TERRA_LAND} transform="translate(13.2 0)" /></g>
          </g>
          <circle className="mg-rim" cx="8" cy="8" r="6.6" />
        </svg>
      );
    case "luna":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <defs>
            <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
              <rect width="16" height="16" fill="#fff" />
              <circle className="mg-phase" cx="11.2" cy="6.4" r="5.7" fill="#000" />
            </mask>
          </defs>
          <circle className="mg-earthshine" cx="8" cy="8" r="6.4" />
          <circle className="mg-fill" cx="8" cy="8" r="6.4" mask={`url(#${id})`} />
        </svg>
      );
  }
}
