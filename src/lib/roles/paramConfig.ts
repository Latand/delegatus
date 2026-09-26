import type { RoleConfig, RoleId, RoleParamValues, RoleVariantId } from "./types";

/**
 * Shipped variant configs for the parameter combinations that run on their own
 * runtime. They override the role's base config, and the install's agent
 * mapping (#1876) overrides them per variant through `variants` in
 * role-presets.json. Client-safe (no node:* imports) so the draft pane, the
 * role table and the launch line share `variantForParams` with the registry.
 */
export const BUILDER_TRIVIAL_CONFIG: RoleConfig = { engine: "claude", model: "sonnet", effort: "high" };
export const BUILDER_FRONTEND_CONFIG: RoleConfig = { engine: "claude", model: "opus", effort: "high" };
export const BUILDER_DOCS_CONFIG: RoleConfig = { engine: "claude", model: "opus", effort: "medium" };
export const BUILDER_APPLY_FIXES_CONFIG: RoleConfig = { engine: "codex", model: "gpt-5.6-terra", effort: "low" };
/* Astra does not review trivial diffs, and Sonnet may not review at all; Luna
   is the Codex reviewer of the Sonnet class. */
export const REVIEWER_TRIVIAL_CONFIG: RoleConfig = { engine: "codex", model: "gpt-6-luna", effort: "high" };

/** Shipped runtime of every variant, per role. */
export const ROLE_VARIANT_DEFAULTS = {
  builder: {
    trivial: BUILDER_TRIVIAL_CONFIG,
    frontend: BUILDER_FRONTEND_CONFIG,
    docs: BUILDER_DOCS_CONFIG,
    "apply-fixes": BUILDER_APPLY_FIXES_CONFIG,
  },
  reviewer: { trivial: REVIEWER_TRIVIAL_CONFIG },
} as const satisfies Record<string, Partial<Record<RoleVariantId, RoleConfig>>>;

/**
 * The variant these parameters select, or null for the role's base row. The
 * one statement of the precedence (trivial > frontend > docs > apply-fixes):
 * `trivial` wins over the domain so a trivial UI tweak runs the light row and
 * keeps the frontend scaffold guidance, and `docs` wins over `apply-fixes` so
 * a writing lane's fix stage stays on Claude.
 */
export function variantForParams(roleId: RoleId | string | null | undefined, params: RoleParamValues | undefined): RoleVariantId | null {
  const values = params ?? {};
  if (roleId === "reviewer") return values.size === "trivial" ? "trivial" : null;
  if (roleId !== "builder") return null;
  if (values.size === "trivial") return "trivial";
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
};

/** `size=trivial`, `domain=frontend`: how a caller selects a variant. */
export function variantParamLabel(variant: RoleVariantId): string {
  return Object.entries(VARIANT_PARAMS[variant]).map(([key, value]) => `${key}=${value}`).join(" ");
}
