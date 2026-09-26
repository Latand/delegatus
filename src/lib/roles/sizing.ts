/**
 * Launch sizing rules (docs/design/model-sizing-tiers.md §2). One pure check
 * every launch seam calls with the caller it already knows: pipeline create,
 * the graph edits that add or override a stage, a spawn, and (R1 only) a
 * mapping write. Client-safe: no node:* imports.
 */

import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { modelSizeClass } from "./costHints";
import type { RoleId, RoleParamValues } from "./types";

/** Who wrote the brief a launch runs on. The operator's own launches are the
    authority; an agent is judged by the runtime it runs on, null when that
    cannot be read. */
export type Briefer =
  | { kind: "operator" }
  | { kind: "agent"; runtime: LaunchRuntime | null };

export type LaunchRuntime = { engine: string; model: string | null };

/** The roles Sonnet and Haiku never run (rule 3 of the requirement). */
export const LIGHT_DENIED_ROLE_IDS: readonly RoleId[] = ["orchestrator", "architect", "reviewer", "verifier"];

export const LIGHT_DENIED_ROLE_MESSAGE =
  "Sonnet and Haiku do not run orchestrator, architect, reviewer or verifier work; name an Opus-class model or use the role's row.";

/** Whether a Claude runtime is Sonnet or Haiku. A dated id such as
    `claude-sonnet-5` goes through the family normalizer so it cannot pass as large. */
export function isLightClaudeRuntime(runtime: LaunchRuntime): boolean {
  if (runtime.engine !== "claude") return false;
  const family = normalizeClaudeLaunchModel(runtime.model);
  return family === "sonnet" || family === "haiku";
}

/** A runtime below the large class: Claude Sonnet or Haiku, or a Codex model
    whose size class is under 3 (both Lunas, Terra). */
export function isLightRuntime(runtime: LaunchRuntime): boolean {
  if (runtime.engine === "claude") return isLightClaudeRuntime(runtime);
  if (runtime.engine === "codex") return runtime.model !== null && modelSizeClass(runtime.model) < 3;
  return false;
}

/** A runtime that may brief a trivial lane: Claude Opus or Fable (a null model
    is the engine default, Opus), or a large Codex model (Astra, both Sols; a
    null model is the account default, Astra). Copilot never is. */
export function isOpusClass(runtime: LaunchRuntime | null): boolean {
  if (!runtime) return false;
  if (runtime.engine === "claude") {
    const family = runtime.model === null ? "opus" : normalizeClaudeLaunchModel(runtime.model);
    return family === "opus" || family === "fable";
  }
  if (runtime.engine === "codex") return runtime.model === null || modelSizeClass(runtime.model) === 3;
  return false;
}

export function runtimeName(runtime: LaunchRuntime | null): string {
  if (!runtime) return "an agent whose runtime cannot be read";
  return `${runtime.engine}/${runtime.model ?? "default"}`;
}

/**
 * The refusal for one launch, or null when it may run.
 *
 * - R1: orchestrator, architect, reviewer and verifier never resolve to Claude
 *   Sonnet or Haiku, whether the runtime came from the mapping or an override.
 * - R2: `size=trivial` needs a brief from an Opus-class agent.
 * - R3: a builder (or a role-less run stage) reaches a light runtime through an
 *   explicit engine/model override only with `size=trivial`. A light runtime
 *   the mapping chose (the fix round, an install's own row) passes.
 *
 * The operator's own launches pass every rule.
 */
export function launchSizingRefusal(input: {
  /** null is a role-less stage, judged as a builder. */
  roleId: RoleId | string | null;
  params: RoleParamValues | undefined;
  /** The resolved runtime, overrides applied. A null model is the engine default. */
  config: LaunchRuntime;
  /** The caller set engine or model itself. */
  explicitRuntime: boolean;
  briefer: Briefer;
}): string | null {
  if (input.briefer.kind === "operator") return null;
  const roleId = input.roleId ?? "builder";
  if ((LIGHT_DENIED_ROLE_IDS as readonly string[]).includes(roleId) && isLightClaudeRuntime(input.config)) {
    return LIGHT_DENIED_ROLE_MESSAGE;
  }
  const trivial = input.params?.size === "trivial";
  if (trivial && !isOpusClass(input.briefer.runtime)) {
    return `size=trivial runs a light model and needs a brief written by an Opus-class agent; this brief comes from ${runtimeName(input.briefer.runtime)}.`;
  }
  if (roleId === "builder" && !trivial && input.explicitRuntime && isLightRuntime(input.config)) {
    return `a builder runs ${runtimeName(input.config)} only as size=trivial; drop the explicit model to use the builder's row, or brief the change precisely and set size=trivial.`;
  }
  return null;
}

/** R1 alone, for a mapping row: a row is a standing default agents then launch. */
export function mappingRowRefusal(roleId: RoleId, runtime: LaunchRuntime): string | null {
  return (LIGHT_DENIED_ROLE_IDS as readonly string[]).includes(roleId) && isLightClaudeRuntime(runtime)
    ? `${roleId}: ${LIGHT_DENIED_ROLE_MESSAGE}`
    : null;
}

/**
 * The sizing rules for a spawn. A role launch is judged by its resolved role;
 * a role-less one that names its own engine and model is judged as a builder
 * whose runtime was set by hand, as a role-less pipeline stage is.
 */
export function spawnSizingRefusal(input: {
  role: { role: RoleId; params: RoleParamValues; config: LaunchRuntime; explicitRuntime: boolean } | null;
  engine?: unknown;
  model?: unknown;
  briefer: Briefer;
}): string | null {
  if (input.role) {
    return launchSizingRefusal({
      roleId: input.role.role,
      params: input.role.params,
      config: input.role.config,
      explicitRuntime: input.role.explicitRuntime,
      briefer: input.briefer,
    });
  }
  const engine = typeof input.engine === "string" ? input.engine : null;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (!engine || !model) return null;
  return launchSizingRefusal({ roleId: null, params: undefined, config: { engine, model }, explicitRuntime: true, briefer: input.briefer });
}
