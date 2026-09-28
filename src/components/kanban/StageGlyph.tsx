"use client";

import { useId } from "react";

import { useLocale } from "@/lib/i18n";
import { STAGE_MARK } from "@/components/pipelines/pipelineBlockModel";
import { STAGE_TONES, type StageChipState } from "@/components/pipelines/pipelineModel";

import { svgProps } from "./kanbanGlyphs";
import { GLYPH_STATE, modelGlyphKind, modelGlyphName, type ModelGlyphKind } from "./modelGlyph";
import { STAGE_TONE } from "./pipelineGraph";

/*
 * The mark in front of a stage: the model that runs it, drawn, in the state it
 * is in (docs/design/model-glyphs.md). One component for the graph node, the
 * Stages sheet, the card's pills, the task row and the phone, so a stage reads
 * the same wherever it is drawn.
 *
 * The four Claude glyphs share the orange family, and each is an object its
 * name brings to mind: Opus the Claude spark itself, Sonnet the poet's quill,
 * Haiku a sakura blossom, Fable the fable's fox. The Codex line is its sky:
 * Sol a yellow sun, Astra a blazing blue sun, Terra the Earth, Luna the Moon.
 * A model with no glyph keeps the stage dot or mark the host always drew, so
 * nothing changes for it.
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
 * drew, `tone` the small dot in the stage's tone a stage pane's header drew.
 * `live` animates a settled stage whose conversation works again.
 *
 * Like the dot it replaces, the glyph is decoration by default: its hosts
 * already say the model and the state, in their label or their visible text
 * (the stage's identity sentence and its state word), and the card's line is
 * passive text with nothing in it for a screen reader to stop on. `named`
 * gives the glyph its own name ("Opus 5.5: running") where no host does.
 *
 * A settled state rides the glyph's corner as a badge. A host that prints the
 * state word beside the glyph (the graph node, the pane, the phone's stage
 * row) passes `badge={false}`: the word and the host's border say it, and the
 * glyph keeps all of its ink.
 */
export function StageGlyph({ state, model, live = false, fallback, named = false, badge = true, title, className }: {
  state: StageChipState;
  model: GlyphModel | null;
  live?: boolean;
  fallback: "mark" | "dot" | "tone";
  named?: boolean;
  badge?: boolean;
  title?: string;
  className?: string;
}) {
  const { t } = useLocale();
  const kind = model ? modelGlyphKind(model.engine, model.model) : null;
  const reading = GLYPH_STATE[state];
  const moving = live || reading === "running";
  if (!kind || !model) {
    if (fallback === "mark") return <StageToneMark state={state} live={live} className={className} />;
    if (fallback === "tone") {
      return (
        <span
          className={`h-2 w-2 shrink-0 rounded-full${moving ? " animate-pulse" : ""}${className ? ` ${className}` : ""}`}
          style={{ backgroundColor: STAGE_TONES[state].color }}
          title={title}
        />
      );
    }
    return <i className={`pdot${className ? ` ${className}` : ""}`} aria-hidden="true" />;
  }
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
      title={title}
      {...name}
    >
      <GlyphDrawing kind={kind} />
      {badge && (reading === "passed" || reading === "failed" || reading === "needs") ? <StateBadge reading={reading} /> : null}
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
/** A point given in a petal's own frame (x across, y up from the centre), turned `degrees` about the centre. */
function turned(x: number, y: number, degrees: number): string {
  const angle = (degrees * Math.PI) / 180;
  return `${r2(8 + x * Math.cos(angle) + y * Math.sin(angle))} ${r2(8 + x * Math.sin(angle) - y * Math.cos(angle))}`;
}

/** A lens-shaped petal from the centre out to `length`, `width` across at its middle. */
function petal(degrees: number, length: number, width: number): string {
  const [tx, ty] = at(length, degrees);
  const [mx, my] = at(length / 2, degrees);
  const angle = (degrees * Math.PI) / 180;
  const [px, py] = [Math.cos(angle) * width, Math.sin(angle) * width];
  return `M8 8Q${r2(mx + px)} ${r2(my + py)} ${tx} ${ty}Q${r2(mx - px)} ${r2(my - py)} 8 8Z`;
}

/** A star whose points alternate between the given outer radii and one inner radius. */
function star(outer: readonly number[], inner: number): string {
  const step = 360 / outer.length;
  const points = outer.flatMap((radius, index) => [at(radius, index * step), at(inner, index * step + step / 2)]);
  return `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`;
}

const every = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => offset + (index * 360) / count);
const lines = (segments: ReadonlyArray<readonly (readonly [number, number])[]>) =>
  segments.map(([[x1, y1], [x2, y2]]) => `M${x1} ${y1}L${x2} ${y2}`).join("");

/* Opus, the complete work: the Claude spark itself, eight full petals round a
   solid core, the family's heaviest mark. */
const OPUS = every(8).map((degrees) => petal(degrees, 7.7, 2.3)).join("");

/* Sonnet: the poet's quill, one feather laid on the diagonal with its nib at
   the lower left. Drawn along the quill's own axis, `s` units from the nib's
   point, `w` across it (negative toward the broad upper vane). */
const NIB = [1.6, 14.4] as const;
function onQuill(s: number, w: number): string {
  const k = Math.SQRT1_2;
  return `${r2(NIB[0] + (s + w) * k)} ${r2(NIB[1] + (w - s) * k)}`;
}
const quill = (points: ReadonlyArray<readonly [number, number]>) => `M${points.map(([s, w]) => onQuill(s, w)).join("L")}Z`;
const SONNET = [
  /* The vane: broad on the upper side, a barb split on the lower. */
  quill([[5.4, -0.55], [7, -2], [9.4, -2.95], [12, -3.2], [14.6, -2.7], [16.7, -1.5], [18.3, 0], [16.9, 1.05], [14.6, 1.75], [12, 2.05], [10.4, 1.8], [9.5, 0.8], [9.1, 1.75], [7.3, 1.25], [5.4, 0.55]]),
  /* The shaft down to the nib's shoulder, then the nib to its point. */
  quill([[5.6, -0.5], [3.4, -0.5], [3.1, -0.95], [0, 0], [3.1, 0.95], [3.4, 0.5], [5.6, 0.5]]),
].join("");
/* The rachis, cut out of the vane so it reads as a feather and not a leaf. */
const SONNET_RACHIS = quill([[7.4, -0.28], [15.6, -0.12], [15.6, 0.12], [7.4, 0.28]]);

/* Haiku: a single sakura blossom, five round petals, each notched at its tip. */
const HAIKU = every(5).map((degrees) =>
  `M${turned(0, 1.3, degrees)}C${turned(-2.7, 2.4, degrees)} ${turned(-3.3, 5.9, degrees)} ${turned(-1.45, 7.4, degrees)}`
  + `L${turned(0, 6.2, degrees)}L${turned(1.45, 7.4, degrees)}C${turned(3.3, 5.9, degrees)} ${turned(2.7, 2.4, degrees)} ${turned(0, 1.3, degrees)}Z`).join("");

/* Fable: the fox of the fables. Tall ears, the cheek tufts flared out, and a
   long muzzle down to a clear point; the white cheek mask is cut out of the
   head, which is what tells a fox from a cat. */
const FOX_HEAD = "M8 5.3L10.9 3.6L14 .8L14.5 6.2L15.7 8.8L11.3 11L8 15.4L4.7 11L.3 8.8L1.5 6.2L2 .8L5.1 3.6Z";
const FOX_MASK = "M2.8 8.55L6.35 8.2L5.3 10.35ZM13.2 8.55L9.65 8.2L10.7 10.35Z";

/* Sol: a round sun and eight detached, rounded rays. */
const SOL_RAYS = every(8, 22.5).map((degrees) => [at(5.3, degrees), at(7.3, degrees)]);

/* Astra: a blue sun brighter than Sol. A filled disc with a white-hot centre
   and a corona of twelve sharp rays out to the grid's edge: pointed and
   attached where Sol's are rounded and detached, so the two part by shape. */
const ASTRA_CORONA = star(Array.from({ length: 12 }, () => 7.9), 4.1);

/* Terra: land drawn twice across one turn, so it can slide round the disc. */
const TERRA_LAND = "M1.4 4.6Q3.6 3.4 5.3 4.4Q6.1 5.7 4.9 6.9Q3.6 7.6 4.1 9.2Q4.6 10.9 3.3 11.9Q1.8 11.2 1.2 8.9ZM8.2 2.4Q10.6 2 12.2 3.6Q11.6 5 10 5Q9.2 6.2 10.4 7.4Q12.2 7.6 12.6 9.4Q12 11.8 10.2 13.3Q9 12 9.3 10.3Q8.3 9 7.3 8.1Q6.9 6.2 8 5.2Q7.4 3.6 8.2 2.4Z";

function GlyphDrawing({ kind }: { kind: ModelGlyphKind }) {
  /* Terra's clip, Luna's phase mask and Astra's core need an id of their own per instance. */
  const id = `mg${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  switch (kind) {
    case "opus":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <g className="mg-turn"><g className="mg-breathe"><path className="mg-fill" d={OPUS} /><circle className="mg-fill" cx="8" cy="8" r="2.2" /></g></g>
        </svg>
      );
    case "sonnet":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-fill mg-write" fillRule="evenodd" d={`${SONNET}${SONNET_RACHIS}`} />
        </svg>
      );
    case "haiku":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-fill mg-sway" d={HAIKU} />
        </svg>
      );
    case "fable":
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="mg-fill mg-tilt" fillRule="evenodd" d={`${FOX_HEAD}${FOX_MASK}`} />
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
          <defs>
            <radialGradient id={id}>
              <stop offset="0" style={{ stopColor: "var(--glyph-astra-core)" }} />
              <stop offset="0.45" style={{ stopColor: "var(--glyph-astra-core)" }} />
              <stop offset="1" style={{ stopColor: "var(--glyph-astra-core)", stopOpacity: 0 }} />
            </radialGradient>
          </defs>
          <path className="mg-fill mg-corona" d={ASTRA_CORONA} />
          <circle className="mg-fill" cx="8" cy="8" r="4.1" />
          <circle className="mg-core" cx="8" cy="8" r="2.3" fill={`url(#${id})`} />
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
