import { effortScale } from "@/lib/agent/efforts";
import { validateLaunchModel } from "@/lib/agent/models";

import { ORCHESTRATOR_TASK_OWNERSHIP_HEADING } from "@/lib/orchestrator/prompt";

import { BUILDER_FINISH_LINE, FIX_ROUND_FINISH_LINE, ORCHESTRATOR_WITHOUT_MANDATE_RULES } from "./defaults";
import { roleEngineRefusal } from "./locks";
import { configForVariant } from "./paramConfig";
import { defaultRoleParameterValue } from "./parameters";
import { loadRoleDefinitions } from "./store";
import type { ResolvedRole, RoleConfig, RoleDefinition, RoleId, RoleParamValues } from "./types";

type ExplicitRoleConfig = Partial<RoleConfig>;
type RoleResolution = { ok: true; value: ResolvedRole } | { ok: false; error: string };
type SpawnRoleResolution = {
  ok: true;
  value: {
    config: RoleConfig;
    scaffold: string;
    role: RoleId;
    params: RoleParamValues;
    /** The request's engine or model moved the runtime off the role's row. */
    explicitRuntime: boolean;
  } | null;
} | { ok: false; error: string };

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 2_000 ? text : null;
}

/**
 * Canonical role-parameter validation: unknown keys, select options, integer
 * bounds, and text length are always enforced. `requireRequired` gates the
 * missing-required check so contexts where a parameter is optional (pipeline
 * stages resolve absent params to registry defaults) can reuse the same value
 * checks without forcing spawn-time required fields.
 */
export function validateRoleParams(
  definition: RoleDefinition,
  raw: unknown,
  { requireRequired = true }: { requireRequired?: boolean } = {},
): { ok: true; value: RoleParamValues } | { ok: false; error: string } {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return { ok: false, error: "roleParams must be an object" };
  const source = (raw ?? {}) as Record<string, unknown>;
  const byKey = new Map(definition.parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(source)) {
    /* Name the accepted alternatives (#774): the caller can only see the key it
       guessed wrong, and this role's parameter set is right here. */
    if (!byKey.has(key)) {
      const allowed = definition.parameters.map((parameter) => parameter.key).join(", ") || "none";
      return { ok: false, error: `unknown role parameter: ${key} (${definition.id} accepts: ${allowed})` };
    }
  }
  const values: RoleParamValues = {};
  for (const parameter of definition.parameters) {
    const input = source[parameter.key];
    if (input === undefined || input === "") {
      if (parameter.required && requireRequired) return { ok: false, error: `missing required role parameter: ${parameter.key}` };
      values[parameter.key] = defaultRoleParameterValue(parameter);
      continue;
    }
    if (parameter.kind === "integer") {
      if (!Number.isInteger(input) || typeof input !== "number" || (parameter.min !== undefined && input < parameter.min) || (parameter.max !== undefined && input > parameter.max)) {
        return { ok: false, error: `invalid role parameter: ${parameter.key}` };
      }
      values[parameter.key] = input;
      continue;
    }
    const value = boundedText(input);
    if (!value || (parameter.kind === "select" && !parameter.options?.includes(value))) return { ok: false, error: `invalid role parameter: ${parameter.key}` };
    values[parameter.key] = value;
  }
  return { ok: true, value: values };
}

/** Labelled parameter lines a scaffold drops when their value is empty, so an
    optional parameter never renders as a dangling label. */
const OPTIONAL_PARAMETER_LINES = ["Repository", "Issue query", "Urgent list", "Merge policy", "Completion policy", "Change under review", "Pull request", "Claims", "Questions"];
/** The orchestrator lines that belong to backlog-campaign mode alone; in any
    other mode they would read as standing rules (agent-prompt-contract.md N6). */
const BACKLOG_CAMPAIGN_LINES = ["Repository", "Issue query", "Urgent list", "Merge policy", "Completion policy", "Backlog campaign"];

function withoutLines(text: string, labels: readonly string[], emptyOnly: boolean): string {
  const value = emptyOnly ? "[ \\t]*" : "[^\\n]*";
  return text.replace(new RegExp(`^(?:${labels.join("|")}):${value}(?:\\n|$)`, "gm"), "");
}

function renderScaffold(definition: RoleDefinition, params: RoleParamValues): string {
  const rendered = definition.promptScaffold.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => String(params[key] ?? ""));
  const scoped = definition.id === "orchestrator" && params.mode !== "backlog-campaign"
    ? withoutLines(rendered, BACKLOG_CAMPAIGN_LINES, false)
    : rendered;
  return withoutLines(scoped, OPTIONAL_PARAMETER_LINES, true);
}

/** Fix rounds repair discoveries within the spec; reviewers own the grade. */
export const APPLY_FIXES_GUIDANCE = "Apply-fixes guidance: Fix every handed finding and anything you notice yourself within the pinned specification, including OVER-BUILT cuts and P0 findings. Add or adjust focused checks where the project has them and report verification evidence. Do not grade your own work; reviewers evaluate it. Never return fail because of an issue you found yourself: fix it immediately, or list it under Notes if it is outside the specification. A finding you judge wrong stays unfixed with evidence in your summary for the reviewer. Return fail only when you are blocked: you cannot build, cannot run required checks, or a handed finding is impossible within the specification. Set blocked:true only when you cannot proceed, and give the reason in blockedReason. Use these structured fields in stage_report or the fallback fenced JSON verdict. Omit blocked or set it false when you can proceed; your verdict is pass unless blocked. An observation outside the specification belongs under Notes.";

/**
 * The rendered scaffold body — parameter substitution plus any role-specific
 * guidance (Builder's domain=frontend contract and its fix-round rules) — with the safety-fence block
 * kept separate so a length-capped caller (the pipeline lookup) can trim the
 * body without ever cutting a fence. This is the single source of the frontend
 * guidance; the pipeline reuses it, so a re-render can't drop it.
 */
export function roleScaffoldBody(definition: RoleDefinition, params: RoleParamValues): string {
  const frontendGuidance = definition.id === "builder" && params.domain === "frontend"
    ? "\n\nUI/frontend implementation guidance: follow the approved interaction and visual contract, preserve accessible semantics and responsive behaviour, and keep every language the project ships in step. Reuse the colours, type, spacing and components the surrounding UI already uses; add no new colour, font, pill or card shape, or decorative label the brief does not ask for."
    : "";
  const fixRound = definition.id === "builder" && params.mode === "apply-fixes";
  /* A fix round has one finish line, scoped to its findings. */
  const rendered = fixRound ? renderScaffold(definition, params)
    .replace(BUILDER_FINISH_LINE, FIX_ROUND_FINISH_LINE)
    .replace("Review your own diff before you finish and report the verification evidence.", "Report the verification evidence; fix any issue you notice within the specification before finishing.")
    : renderScaffold(definition, params);
  return rendered + frontendGuidance + (fixRound ? `\n\n${APPLY_FIXES_GUIDANCE}` : "");
}

/** How a spawned role agent ends (docs/design/agent-prompt-contract.md §2.2):
    it has no stage to report to, so it ends in a line the seat reads, in the
    same three words a stage uses. The orchestrator reports outcomes and never
    gets it. */
export const SPAWN_COMPLETION = "When you finish, end your final message with one line: Verdict: pass, Verdict: fail or Verdict: needs_decision. They mean what they mean for a pipeline stage: pass when the brief's contract is complete, with any notes above that line; fail with the findings listed above it; needs_decision with the question, the options and your recommendation above it. That line replaces any other ending the brief asks for (REVIEW_READY, VERDICT: APPROVE, VERDICT: REQUEST_CHANGES, NO FINDINGS).";

/** Whether a brief carries the seat mandate: every delivered mandate carries
    the task-ownership section, since delivery appends it when missing. */
function carriesSeatMandate(text: string): boolean {
  return text.includes(ORCHESTRATOR_TASK_OWNERSHIP_HEADING);
}

/** The first message of a role spawn: the scaffold, the caller's brief and the
    completion line; a spawn without a role is the brief alone. An orchestrator
    reports outcomes and gets no completion line; one launched without the
    mandate gets the shared rules its scaffold leaves to the mandate. */
export function roleSpawnPrompt(role: { role: RoleId; scaffold: string } | null, userPrompt: string): string {
  if (!role) return userPrompt;
  const ending = role.role !== "orchestrator"
    ? SPAWN_COMPLETION
    : carriesSeatMandate(userPrompt) ? "" : ORCHESTRATOR_WITHOUT_MANDATE_RULES;
  return [role.scaffold, userPrompt, ending].filter(Boolean).join("\n\n");
}

/** The trailing safety-fence block for a role, or "" when it declares none. */
export function roleFenceBlock(definition: RoleDefinition): string {
  if (!definition.safetyFences.length) return "";
  return `\n\nSafety fences:\n${definition.safetyFences.map((fence) => `- ${fence}`).join("\n")}`;
}

function promptWithFences(definition: RoleDefinition, params: RoleParamValues): string {
  return roleScaffoldBody(definition, params) + roleFenceBlock(definition);
}

/** The runtime a role runs on for these parameters. A variant row
    (`variantForParams`) reads the install's mapping (#1876) over its shipped value. */
export function configForParams(definition: RoleDefinition, params: RoleParamValues): RoleConfig {
  return configForVariant(definition, params);
}

function resolveConfig(definition: RoleDefinition, params: RoleParamValues, explicit: ExplicitRoleConfig): { ok: true; value: RoleConfig } | { ok: false; error: string } {
  const config = { ...configForParams(definition, params), ...explicit };
  if (config.engine !== "claude" && config.engine !== "codex") return { ok: false, error: "engine must be claude or codex" };
  const locked = roleEngineRefusal(definition.id, config.engine);
  if (locked) return { ok: false, error: locked };
  const model = validateLaunchModel(config.engine, config.model);
  if ("error" in model) return { ok: false, error: model.error };
  config.model = model.model;
  const scale = effortScale(config.engine, config.model)!;
  if (!scale.includes(config.effort)) return { ok: false, error: `effort for ${config.engine} must be one of: ${scale.join(", ")}` };
  return { ok: true, value: config };
}

export function resolveRole(role: string, params: unknown = {}, explicit: ExplicitRoleConfig = {}, definitions: RoleDefinition[] = loadRoleDefinitions()): RoleResolution {
  const definition = definitions.find((candidate) => candidate.id === role);
  if (!definition) return { ok: false, error: `unknown role: ${role} (allowed: ${definitions.map((candidate) => candidate.id).join(", ")})` };
  const parsedParams = validateRoleParams(definition, params);
  if (!parsedParams.ok) return parsedParams;
  const config = resolveConfig(definition, parsedParams.value, explicit);
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      definition,
      config: config.value,
      params: parsedParams.value,
      "prompt": promptWithFences(definition, parsedParams.value),
      requiresDeploymentConfirmation: definition.id === "deployer",
    },
  };
}

export function listRoles(): RoleDefinition[] {
  return loadRoleDefinitions();
}

/** Resolve a role-shaped spawn body before the route creates a CLI spec. */
export function resolveSpawnRole(body: { role?: unknown; roleParams?: unknown; confirm?: unknown; engine?: unknown; model?: unknown; effort?: unknown }): SpawnRoleResolution {
  if (body.role === undefined || body.role === null || body.role === "") return { ok: true, value: null };
  if (typeof body.role !== "string") return { ok: false, error: "role must be a string" };
  const base = resolveRole(body.role, body.roleParams);
  if (!base.ok) return base;
  const explicit: ExplicitRoleConfig = {};
  if (body.engine !== undefined) {
    if (body.engine !== "claude" && body.engine !== "codex") return { ok: false, error: "engine must be claude or codex" };
    if (body.engine !== base.value.config.engine && body.model === undefined) return { ok: false, error: "model is required when overriding a role engine" };
    explicit.engine = body.engine;
  }
  if (typeof body.model === "string" && body.model.trim()) explicit.model = body.model.trim();
  if (typeof body.effort === "string" && body.effort.trim()) explicit.effort = body.effort.trim();
  const resolved = resolveRole(body.role, body.roleParams, explicit);
  if (!resolved.ok) return resolved;
  if (resolved.value.requiresDeploymentConfirmation && body.confirm !== "deploy") {
    return { ok: false, error: "deployer requires confirm: deploy" };
  }
  const explicitRuntime = resolved.value.config.engine !== base.value.config.engine || resolved.value.config.model !== base.value.config.model;
  return { ok: true, value: { config: resolved.value.config, scaffold: resolved.value.prompt, role: resolved.value.definition.id, params: resolved.value.params, explicitRuntime } };
}
