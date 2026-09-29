import type { RoleConfig, RoleId, RoleParamValues, RoleVariantId } from "./types";

/**
 * Shipped variant configs for the parameter combinations that run on their own
 * runtime. They override the role's base config, and the install's agent
 * mapping (#1876) overrides them per variant through `variants` in
 * role-presets.json. Client-safe (no node:* imports) so the draft pane, the
 * role table and the launch line share `variantForParams` with the registry.
 */
/* Sonnet 5.5 runs the well-scoped rows, pinned by id (the `sonnet` alias moves
   with the next Sonnet): docs/design/model-sizing-tiers.md §1. */
export const BUILDER_TRIVIAL_CONFIG: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
export const BUILDER_FRONTEND_CONFIG: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
export const BUILDER_DOCS_CONFIG: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
/* docs/design/agent-prompt-contract.md §3 (a): a fix round runs a light model
   by its lane's domain, and its brief is a list of findings, each with a place. */
export const BUILDER_APPLY_FIXES_CONFIG: RoleConfig = { engine: "codex", model: "gpt-6-luna", effort: "high" };
export const BUILDER_FRONTEND_FIXES_CONFIG: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
export const BUILDER_DOCS_FIXES_CONFIG: RoleConfig = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" };
/* Astra does not review trivial diffs; Luna is the Codex reviewer of the light
   class, and a Claude install's row is Sonnet 5.5 (equivalents.ts). */
export const REVIEWER_TRIVIAL_CONFIG: RoleConfig = { engine: "codex", model: "gpt-6-luna", effort: "high" };

/** Shipped runtime of every variant, per role. */
export const ROLE_VARIANT_DEFAULTS = {
  builder: {
    trivial: BUILDER_TRIVIAL_CONFIG,
    frontend: BUILDER_FRONTEND_CONFIG,
    docs: BUILDER_DOCS_CONFIG,
    "apply-fixes": BUILDER_APPLY_FIXES_CONFIG,
    "frontend-fixes": BUILDER_FRONTEND_FIXES_CONFIG,
    "docs-fixes": BUILDER_DOCS_FIXES_CONFIG,
  },
  reviewer: { trivial: REVIEWER_TRIVIAL_CONFIG },
} as const satisfies Record<string, Partial<Record<RoleVariantId, RoleConfig>>>;

/**
 * The variant these parameters select, or null for the role's base row. The
 * one statement of the precedence (trivial > frontend-fixes > docs-fixes >
 * frontend > docs > apply-fixes): `trivial` wins over everything so a trivial
 * lane's fix round runs the same light row as its build; a fix round in a
 * frontend or docs lane runs that domain's fix row, so the domain rows stay the
 * implementer's; and a general fix round runs the general fix row.
 */
export function variantForParams(roleId: RoleId | string | null | undefined, params: RoleParamValues | undefined): RoleVariantId | null {
  const values = params ?? {};
  if (roleId === "reviewer") return values.size === "trivial" ? "trivial" : null;
  if (roleId !== "builder") return null;
  if (values.size === "trivial") return "trivial";
  const fixRound = values.mode === "apply-fixes";
  if (fixRound && values.domain === "frontend") return "frontend-fixes";
  if (fixRound && values.domain === "docs") return "docs-fixes";
  if (values.domain === "frontend") return "frontend";
  if (values.domain === "docs") return "docs";
  if (values.mode === "apply-fixes") return "apply-fixes";
  return null;
}

/** The shipped runtime of `variant` on `roleId`, or null when the role has no such variant. */
export function shippedVariantConfig(roleId: RoleId | string, variant: RoleVariantId): RoleConfig | null {
  const table = (ROLE_VARIANT_DEFAULTS as Partial<Record<string, Partial<Record<RoleVariantId, RoleConfig>>>>)[roleId];
  return table?.[variant] ?? null;
}

/** The runtime a role definition runs on for these parameters: the selected
    variant's row (the install's mapping over its shipped value), else the base. */
export function configForVariant(definition: { id: RoleId; config: RoleConfig; variants?: Partial<Record<RoleVariantId, RoleConfig>> }, params: RoleParamValues | undefined): RoleConfig {
  const variant = variantForParams(definition.id, params);
  if (!variant) return definition.config;
  return definition.variants?.[variant] ?? shippedVariantConfig(definition.id, variant) ?? definition.config;
}

/**
 * One launch's runtime as the launch answers state it (§3):
 * `builder·trivial claude/sonnet/high`, `(explicit)` when the caller set the
 * engine or model itself. A role-less launch is its runtime alone.
 */
export function launchRuntimeLabel(input: {
  roleId: string | null;
  variant: RoleVariantId | null;
  engine: string;
  model: string | null;
  effort: string | null;
  explicit: boolean;
}): string {
  const role = input.roleId ? `${input.roleId}${input.variant ? `·${input.variant}` : ""} ` : "";
  return `${role}${input.engine}/${input.model ?? "default"}/${input.effort ?? "default"}${input.explicit ? " (explicit)" : ""}`;
}

/** The parameters that select each variant, as a caller names them. */
export const VARIANT_PARAMS: Record<RoleVariantId, RoleParamValues> = {
  trivial: { size: "trivial" },
  frontend: { domain: "frontend" },
  docs: { domain: "docs" },
  "apply-fixes": { mode: "apply-fixes" },
  "frontend-fixes": { domain: "frontend", mode: "apply-fixes" },
  "docs-fixes": { domain: "docs", mode: "apply-fixes" },
};

/** `size=trivial`, `domain=frontend`: how a caller selects a variant. */
export function variantParamLabel(variant: RoleVariantId): string {
  return Object.entries(VARIANT_PARAMS[variant]).map(([key, value]) => `${key}=${value}`).join(" ");
}
