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
  CODEX_GPT61_SOL_MODEL,
  CODEX_GPT6_LUNA_MODEL,
  CODEX_GPT6_SOL_MODEL,
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
} from "@/lib/agent/models";

import type { RoleConfig, RoleEngine, RoleId, RoleVariantId } from "./types";

/** One row of the agent mapping: a role, or one of its variants. */
export type EquivalentRow = { roleId: RoleId; variant?: RoleVariantId };

// GPT-6 Luna misses details a fix or a cleanup needs, so it lands one tier up.
const CODEX_TO_CLAUDE: Record<string, string> = {
  [CODEX_ASTRA_MODEL]: "opus",
  [CODEX_GPT61_SOL_MODEL]: "opus",
  [CODEX_GPT6_SOL_MODEL]: "opus",
  [CODEX_GPT6_LUNA_MODEL]: "sonnet",
  [CODEX_SOL_MODEL]: "opus",
  [CODEX_TERRA_MODEL]: "sonnet",
  [CODEX_LUNA_MODEL]: "haiku",
};

// The GPT-6 line has no Terra, so Sonnet, pinned or by alias, lands on GPT-6.1 Sol.
const CLAUDE_TO_CODEX: Record<string, string> = {
  opus: CODEX_GPT61_SOL_MODEL,
  fable: CODEX_GPT61_SOL_MODEL,
  sonnet: CODEX_GPT61_SOL_MODEL,
  "claude-sonnet-5-5": CODEX_GPT61_SOL_MODEL,
  haiku: CODEX_GPT6_LUNA_MODEL,
};

const OPUS_HIGH: RoleConfig = { engine: "claude", model: "opus", effort: "high" };
/* Sonnet 5.5 pinned by id: the `sonnet` alias moves with the next Sonnet. */
const SONNET_HIGH: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
const SONNET_MEDIUM: RoleConfig = { ...SONNET_HIGH, effort: "medium" };

/** Per row, the runtime on each target engine. Moving to Claude follows the
    Sonnet 5.5 / Opus 5.5 table (docs/design/model-sizing-tiers.md §7): Sonnet
    5.5 runs the well-scoped rows (every builder row, the cleaner, the verifier
    and the trivial reviewer), Opus the rows that need judgment (orchestrator,
    architect, reviewer, prod-auditor, deployer). Moving to Codex, only the rows
    that live on Claude by default (and the trivial reviewer, which lives on
    Luna) have an approved target. Sonnet never lands on the orchestrator, the
    architect or a reviewer above size=trivial. */
const ROW_TARGETS: Record<RoleEngine, Readonly<Record<string, RoleConfig>>> = {
  claude: {
    orchestrator: OPUS_HIGH,
    reviewer: OPUS_HIGH,
    verifier: SONNET_MEDIUM,
    builder: SONNET_HIGH,
    "builder:frontend": SONNET_HIGH,
    "builder:apply-fixes": SONNET_HIGH,
    "builder:trivial": SONNET_HIGH,
    "builder:docs": SONNET_HIGH,
    "builder:frontend-fixes": SONNET_HIGH,
    "builder:docs-fixes": SONNET_HIGH,
    "reviewer:trivial": SONNET_MEDIUM,
    architect: OPUS_HIGH,
    cleaner: SONNET_HIGH,
    maintainer: { engine: "claude", model: "opus", effort: "medium" },
    "prod-auditor": OPUS_HIGH,
    deployer: OPUS_HIGH,
    "visual-critic": OPUS_HIGH,
  },
  codex: {
    orchestrator: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "medium" },
    architect: { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    "builder:frontend": { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    "builder:trivial": { engine: "codex", model: CODEX_GPT6_LUNA_MODEL, effort: "high" },
    "builder:docs": { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "medium" },
    /* The Sonnet fix rows land where CLAUDE_TO_CODEX puts Sonnet. */
    "builder:frontend-fixes": { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    "builder:docs-fixes": { engine: "codex", model: CODEX_GPT61_SOL_MODEL, effort: "high" },
    "reviewer:trivial": { engine: "codex", model: CODEX_GPT6_LUNA_MODEL, effort: "high" },
  },
};

function rowKey(row: EquivalentRow): string {
  return row.variant ? `${row.roleId}:${row.variant}` : row.roleId;
}

/** The equivalent model on `engine`; an unknown source model maps to the target's largest. */
export function equivalentModel(model: string, engine: RoleEngine): string {
  if (engine === "claude") return CODEX_TO_CLAUDE[model] ?? "opus";
  return CLAUDE_TO_CODEX[model] ?? CODEX_GPT61_SOL_MODEL;
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
