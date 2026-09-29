import { ENGINE_MODELS, modelDisplayName, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import type { StageChipState } from "@/components/pipelines/pipelineModel";

/*
 * Which drawn glyph stands for the model a stage runs on
 * (docs/design/model-glyphs.md). Pure: no DOM, no React.
 *
 * Claude reads by family, through the same projection resume and migration
 * use, so `opus`, `opus-5-5` and `claude-opus-5` all draw Opus. Codex reads by
 * the name after the version (`gpt-6-sol` and `gpt-5.6-sol` are both Sol),
 * because the operator named the line, not a release. Anything else — another
 * engine, an uncatalogued family, a blank record — has no glyph, and the
 * surface keeps the stage dot it always drew.
 */

export type ModelGlyphKind = "opus" | "fable" | "sonnet" | "haiku" | "sol" | "astra" | "terra" | "luna";

export const MODEL_GLYPH_KINDS: readonly ModelGlyphKind[] = ["opus", "fable", "sonnet", "haiku", "sol", "astra", "terra", "luna"];

const CODEX_FAMILY = /^gpt-\d+(?:\.\d+)?-(sol|astra|terra|luna)$/;

export function modelGlyphKind(engine: string, model: string | null | undefined): ModelGlyphKind | null {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return null;
  if (engine === "claude") return normalizeClaudeLaunchModel(id);
  if (engine === "codex") return (CODEX_FAMILY.exec(id)?.[1] as ModelGlyphKind | undefined) ?? null;
  return null;
}

/** The model's full name for the glyph's accessible name: the catalogue's
    label ("GPT-6-Astra", not the pill's "6-Astra"), else the display name. */
export function modelGlyphName(engine: string, model: string): string {
  const catalogue = engine === "claude" || engine === "codex" ? ENGINE_MODELS[engine] : [];
  return catalogue.find((option) => option.id === model)?.label ?? modelDisplayName(engine, model);
}

/** The five readings a glyph has. Running moves and glows; the three settled
    states add a badge in the stage's tone; waiting is the glyph dimmed. */
export type GlyphState = "running" | "waiting" | "passed" | "failed" | "needs";

export const GLYPH_STATE: Record<StageChipState, GlyphState> = {
  pending: "waiting",
  skipped: "waiting",
  running: "running",
  committing: "running",
  reviewing: "running",
  passed: "passed",
  failed: "failed",
  needs_decision: "needs",
};
