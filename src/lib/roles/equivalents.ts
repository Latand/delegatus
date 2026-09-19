/**
 * The model a role lands on when its engine flips (#1876, design §4.3): the
 * banner's "Move them to {engine}" and the engine segment of one row both read
 * this table. Effort keeps its tier when the target scale has it and is clamped
 * otherwise. Client-safe.
 */

import { clampEffortToScale } from "@/lib/agent/efforts";
import { CODEX_ASTRA_MODEL, CODEX_LUNA_MODEL, CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";

import type { RoleConfig, RoleEngine } from "./types";

const CODEX_TO_CLAUDE: Record<string, string> = {
  [CODEX_ASTRA_MODEL]: "opus",
  [CODEX_SOL_MODEL]: "opus",
  [CODEX_TERRA_MODEL]: "sonnet",
  [CODEX_LUNA_MODEL]: "haiku",
};

const CLAUDE_TO_CODEX: Record<string, string> = {
  opus: CODEX_ASTRA_MODEL,
  fable: CODEX_ASTRA_MODEL,
  sonnet: CODEX_TERRA_MODEL,
  haiku: CODEX_LUNA_MODEL,
};

/** The equivalent model on `engine`; an unknown source model maps to the target's largest. */
export function equivalentModel(model: string, engine: RoleEngine): string {
  if (engine === "claude") return CODEX_TO_CLAUDE[model] ?? "opus";
  return CLAUDE_TO_CODEX[model] ?? CODEX_ASTRA_MODEL;
}

/** `config` moved onto `engine`: the equivalent model and a clamped effort. */
export function equivalentConfig(config: RoleConfig, engine: RoleEngine): RoleConfig {
  if (config.engine === engine) return config;
  const model = equivalentModel(config.model, engine);
  return { engine, model, effort: clampEffortToScale(engine, model, config.effort) ?? config.effort };
}
