/**
 * The model a role lands on when its engine flips (#1876, design §4.3): the
 * banner's "Move them to {engine}" and the engine segment of one row both read
 * this table. A known row takes the runtime the operator approved for it while
 * the other engine is out of quota (model landscape 2026-09, §4.3); any other
 * config maps model to model, and effort keeps its tier when the target scale
 * has it and is clamped otherwise. Client-safe.
 */

import { clampEffortToScale } from "@/lib/agent/efforts";
import {
  CODEX_ASTRA_MODEL,
  CODEX_GPT6_LUNA_MODEL,
  CODEX_GPT6_SOL_MODEL,
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
} from "@/lib/agent/models";

import type { BuilderVariantId, RoleConfig, RoleEngine, RoleId } from "./types";

/** One row of the agent mapping: a role, or one of the builder's variants. */
export type EquivalentRow = { roleId: RoleId; variant?: BuilderVariantId };

// GPT-6 Luna misses details a fix or a cleanup needs, so it lands one tier up.
const CODEX_TO_CLAUDE: Record<string, string> = {
  [CODEX_ASTRA_MODEL]: "opus",
  [CODEX_GPT6_SOL_MODEL]: "opus",
  [CODEX_GPT6_LUNA_MODEL]: "sonnet",
  [CODEX_SOL_MODEL]: "opus",
  [CODEX_TERRA_MODEL]: "sonnet",
  [CODEX_LUNA_MODEL]: "haiku",
};

// The GPT-6 line has no Terra, so Sonnet lands on GPT-6 Sol.
const CLAUDE_TO_CODEX: Record<string, string> = {
  opus: CODEX_ASTRA_MODEL,
  fable: CODEX_ASTRA_MODEL,
  sonnet: CODEX_GPT6_SOL_MODEL,
  haiku: CODEX_GPT6_LUNA_MODEL,
};

const OPUS_HIGH: RoleConfig = { engine: "claude", model: "opus", effort: "high" };

/** Per row, the runtime on each target engine. Moving to Claude, every row runs
    Opus high except the fix round and the cleaner; moving to Codex, only the
    rows that live on Claude by default have an approved target. */
const ROW_TARGETS: Record<RoleEngine, Readonly<Record<string, RoleConfig>>> = {
  claude: {
    orchestrator: OPUS_HIGH,
    reviewer: OPUS_HIGH,
    verifier: OPUS_HIGH,
    builder: OPUS_HIGH,
    "builder:frontend": OPUS_HIGH,
    "builder:apply-fixes": { engine: "claude", model: "opus", effort: "medium" },
    architect: OPUS_HIGH,
    cleaner: { engine: "claude", model: "sonnet", effort: "high" },
    "prod-auditor": OPUS_HIGH,
    deployer: OPUS_HIGH,
  },
  codex: {
    orchestrator: { engine: "codex", model: CODEX_ASTRA_MODEL, effort: "medium" },
    architect: { engine: "codex", model: CODEX_ASTRA_MODEL, effort: "high" },
    "builder:frontend": { engine: "codex", model: CODEX_ASTRA_MODEL, effort: "high" },
  },
};

function rowKey(row: EquivalentRow): string {
  return row.variant ? `${row.roleId}:${row.variant}` : row.roleId;
}

/** The equivalent model on `engine`; an unknown source model maps to the target's largest. */
export function equivalentModel(model: string, engine: RoleEngine): string {
  if (engine === "claude") return CODEX_TO_CLAUDE[model] ?? "opus";
  return CLAUDE_TO_CODEX[model] ?? CODEX_ASTRA_MODEL;
}

/** `config` moved onto `engine`: the row's approved runtime there, else the
    equivalent model and a clamped effort. */
export function equivalentConfig(config: RoleConfig, engine: RoleEngine, row?: EquivalentRow): RoleConfig {
  if (config.engine === engine) return config;
  const target = row ? ROW_TARGETS[engine][rowKey(row)] : undefined;
  if (target) return { ...target };
  const model = equivalentModel(config.model, engine);
  return { engine, model, effort: clampEffortToScale(engine, model, config.effort) ?? config.effort };
}
