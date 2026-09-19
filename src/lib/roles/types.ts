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
  /** Builder only: the runtime of its two parameter variants, shipped values
      merged with this install's mapping (#1876). */
  variants?: Record<BuilderVariantId, RoleConfig>;
};

/** The builder's two parameter combinations that run on their own runtime:
    `domain=frontend` and `mode=apply-fixes`. */
export const BUILDER_VARIANT_IDS = ["frontend", "apply-fixes"] as const;
export type BuilderVariantId = typeof BUILDER_VARIANT_IDS[number];

export type RoleOverride = {
  config?: Partial<RoleConfig>;
  promptScaffold?: string;
  /** Valid on `builder` only. */
  variants?: Partial<Record<BuilderVariantId, Partial<RoleConfig>>>;
};

export type RoleOverridesFile = {
  /** 2 only when a `variants` key is present, so a mapping without variants
      stays readable by an older build sharing the config directory. */
  schemaVersion: 1 | 2;
  overrides: Partial<Record<RoleId, RoleOverride>>;
};

export type RoleParamValues = Record<string, string | number>;

export type ResolvedRole = {
  definition: RoleDefinition;
  config: RoleConfig;
  params: RoleParamValues;
  "prompt": string;
  requiresDeploymentConfirmation: boolean;
};
