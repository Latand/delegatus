/**
 * Launch sizing rules (docs/design/model-sizing-tiers.md §2). One pure check
 * every launch seam calls with the caller it already knows: pipeline create,
 * the graph edits that add or override a stage, a spawn, and (R1 only) a
 * mapping write. Client-safe: no node:* imports.
 */

import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { modelSizeClass } from "./costHints";
import type { RoleId, RoleParamValues, RoleVariantId } from "./types";

/** Who wrote the brief a launch runs on. The operator's own launches are the
    authority; an agent is judged by the runtime it runs on, null when that
    cannot be read. */
export type Briefer =
  | { kind: "operator" }
  | { kind: "agent"; runtime: LaunchRuntime | null };

export type LaunchRuntime = { engine: string; model: string | null };

/** The roles Haiku never runs, and Sonnet runs only where `sonnetMayRun` says
    (rule 3 of the requirement, relaxed for Sonnet 5.5 by the model table). */
export const LIGHT_DENIED_ROLE_IDS: readonly RoleId[] = ["orchestrator", "architect", "reviewer", "verifier"];

export const LIGHT_DENIED_ROLE_MESSAGE =
  "Sonnet does not run orchestrator, architect or a reviewer above size=trivial, and Haiku runs none of orchestrator, architect, reviewer or verifier; name a large model (Claude Opus or Fable, or a large Codex model) or use the role's row.";

/** A stage that judges another stage's work (a review-loop stage, or a stage
    whose fail verdict routes to a fix stage) is reviewer work under R1,
    whatever role it names. */
export const REVIEW_GATE_MESSAGE = `a review gate is reviewer work whatever role it names: ${LIGHT_DENIED_ROLE_MESSAGE}`;

/** What Sonnet may judge: any verifier, and a review of a size=trivial change. */
function sonnetMayRun(roleId: string, params: RoleParamValues | undefined): boolean {
  return roleId === "verifier" || (roleId === "reviewer" && params?.size === "trivial");
}

/** R1 for a review gate: Sonnet gates a size=trivial stage and a verifier
    stage (the verifier role has no size); Haiku never. */
export function reviewGateRefusal(runtime: LaunchRuntime, params?: RoleParamValues, roleId?: RoleId | string | null): string | null {
  if (!isLightClaudeRuntime(runtime)) return null;
  return isClaudeSonnet(runtime) && (params?.size === "trivial" || roleId === "verifier") ? null : REVIEW_GATE_MESSAGE;
}

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

/** Claude Sonnet, the one light model with standing work: a builder at any size
    when a large model briefs it, a verifier, a size=trivial reviewer. Haiku and
    the light Codex models keep the size=trivial rule. */
function isClaudeSonnet(config: LaunchRuntime): boolean {
  return config.engine === "claude" && normalizeClaudeLaunchModel(config.model) === "sonnet";
}

/** R1 for one role on one runtime: the refusal, or null when the runtime may run it. */
function lightRoleRefusal(roleId: string, params: RoleParamValues | undefined, runtime: LaunchRuntime): string | null {
  if (!(LIGHT_DENIED_ROLE_IDS as readonly string[]).includes(roleId) || !isLightClaudeRuntime(runtime)) return null;
  return isClaudeSonnet(runtime) && sonnetMayRun(roleId, params) ? null : LIGHT_DENIED_ROLE_MESSAGE;
}

/**
 * The refusal for one launch, or null when it may run.
 *
 * - R1: orchestrator, architect and a reviewer above size=trivial never resolve
 *   to Claude Sonnet, and Haiku runs none of those four roles plus the
 *   verifier, whether the runtime came from the mapping or an override. Sonnet
 *   may run the verifier and a size=trivial reviewer. A review gate counts as
 *   reviewer work whatever role it names; Sonnet gates a size=trivial stage or a verifier.
 * - R2: `size=trivial` needs a brief from a large model (`isOpusClass`).
 * - R3: a builder (or a role-less run stage) reaches a light runtime through an
 *   explicit engine/model override only with `size=trivial`, except Claude
 *   Sonnet, which builds at any size when an Opus-class runtime wrote the brief
 *   (Opus writes the description, Sonnet builds). A light runtime the mapping
 *   chose (the fix round, an install's own row) passes.
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
  /** The stage judges another stage's work: a review-loop stage, or one
      carrying a fail edge to its fix stage. */
  reviewGate?: boolean;
}): string | null {
  if (input.briefer.kind === "operator") return null;
  const roleId = input.roleId ?? "builder";
  const denied = lightRoleRefusal(roleId, input.params, input.config);
  if (denied) return denied;
  if (input.reviewGate) {
    const gate = reviewGateRefusal(input.config, input.params, roleId);
    if (gate) return gate;
  }
  const trivial = input.params?.size === "trivial";
  if (trivial && !isOpusClass(input.briefer.runtime)) {
    return `size=trivial runs a light model and needs a brief written by a large model (Claude Opus or Fable, or a large Codex model); this brief comes from ${runtimeName(input.briefer.runtime)}.`;
  }
  if (roleId === "builder" && !trivial && input.explicitRuntime && isLightRuntime(input.config)) {
    if (isClaudeSonnet(input.config)) {
      if (isOpusClass(input.briefer.runtime)) return null;
      return `a builder runs Claude Sonnet when a large model (Claude Opus or Fable, or a large Codex model) or the operator wrote its brief; this brief comes from ${runtimeName(input.briefer.runtime)}.`;
    }
    return `a builder runs ${runtimeName(input.config)} only as size=trivial; drop the explicit model to use the builder's row, or brief the change precisely and set size=trivial.`;
  }
  return null;
}

/** R1 alone, for a mapping row: a row is a standing default agents then launch.
    The `trivial` variant of a role is the size=trivial row. */
export function mappingRowRefusal(roleId: RoleId, runtime: LaunchRuntime, variant?: RoleVariantId | null): string | null {
  const refusal = lightRoleRefusal(roleId, variant === "trivial" ? { size: "trivial" } : undefined, runtime);
  return refusal ? `${roleId}: ${refusal}` : null;
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
