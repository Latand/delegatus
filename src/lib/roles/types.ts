export const ROLE_IDS = [
  "orchestrator",
  "reviewer",
  "verifier",
  "builder",
  "architect",
  "cleaner",
  "prod-auditor",
  "deployer",
] as const;

export type RoleId = typeof ROLE_IDS[number];

export type RoleEngine = "claude" | "codex";

export type RoleConfig = {
  engine: RoleEngine;
  model: string;
  effort: string;
};

type RoleParameterBase = {
  key: string;
  label: string;
  description: string;
  required?: boolean;
};

export type RoleParameter = RoleParameterBase & ({
  kind: "text";
  default?: string;
} | {
  kind: "integer";
  default?: number;
  min?: number;
  max?: number;
} | {
  kind: "select";
  default?: string;
  options?: readonly string[];
});

export type RoleDefinition = {
  id: RoleId;
  name: string;
  description: string;
  config: RoleConfig;
  parameters: readonly RoleParameter[];
  promptScaffold: string;
  safetyFences: readonly string[];
  capabilities: readonly ("read-only" | "production-read" | "production-write" | "spawn")[];
  /** Builder and reviewer only: the runtime of each parameter variant,
      shipped values merged with this install's mapping (#1876). */
  variants?: Partial<Record<RoleVariantId, RoleConfig>>;
};

/** A settings/manager snapshot identifies validated content independently from
    the on-disk file schema. */
export type RoleRegistryHealth =
  | { state: "healthy" }
  | { state: "degraded"; reason: "preset unavailable" };

/** A mapping row a retirement set back to its default, shown until the
    operator touches the row (docs/design/model-sizing-tiers.md §5). */
export type RoleMappingReset = { id: string; row: string; from: RoleConfig; at: string };

export type RoleRegistrySnapshot = {
  roles: RoleDefinition[];
  revision: string;
  health: RoleRegistryHealth;
  resets?: RoleMappingReset[];
};

/** Existing manager-table callers retain registry provenance on the list they
    already persist for delivery retries. */
export type RegistryRoleDefinitions = RoleDefinition[] & {
  registry?: Pick<RoleRegistrySnapshot, "revision" | "health" | "resets">;
};

/** The parameter combinations that run on their own runtime, per role, in
    the order the mapping lists them. `trivial` is `size=trivial`, the
    small-change tier (docs/design/model-sizing-tiers.md §1). */
export const ROLE_VARIANT_IDS = {
  builder: ["trivial", "frontend", "docs", "apply-fixes"],
  reviewer: ["trivial"],
} as const;
export type VariantRoleId = keyof typeof ROLE_VARIANT_IDS;
export type RoleVariantId = typeof ROLE_VARIANT_IDS[VariantRoleId][number];
export type BuilderVariantId = typeof ROLE_VARIANT_IDS.builder[number];
/** The two variants an older build already knew; a file carrying only these
    stays schema 2. */
export const SCHEMA_2_VARIANT_IDS: readonly string[] = ["frontend", "apply-fixes"];

export type RoleOverride = {
  config?: Partial<RoleConfig>;
  promptScaffold?: string;
  /** Valid on `builder` and `reviewer` only, keyed by that role's variants. */
  variants?: Partial<Record<RoleVariantId, Partial<RoleConfig>>>;
};

/** One once-per-install retirement of a stale mapping value (§5). `reset` is
    present while the operator has not touched the row since it was reset. */
export type RoleMappingRetirementRecord = {
  at: string;
  reset?: { row: string; from: RoleConfig };
};

export type RoleOverridesFile = {
  /** 1 without variants; 2 with only the variants an older build knew; 3 once
      a newer variant (builder trivial/docs, reviewer trivial) is stored, so an
      older build degrades to its defaults instead of misreading the row. */
  schemaVersion: 1 | 2 | 3;
  overrides: Partial<Record<RoleId, RoleOverride>>;
  retirements?: Record<string, RoleMappingRetirementRecord>;
};

export type RoleParamValues = Record<string, string | number>;

export type ResolvedRole = {
  definition: RoleDefinition;
  config: RoleConfig;
  params: RoleParamValues;
  "prompt": string;
  requiresDeploymentConfirmation: boolean;
};
