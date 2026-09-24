import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { effortScale } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { ROLE_DEFAULTS } from "./defaults";
import { BUILDER_APPLY_FIXES_CONFIG, BUILDER_FRONTEND_CONFIG } from "./paramConfig";
import { BUILDER_VARIANT_IDS, ROLE_IDS, type BuilderVariantId, type RegistryRoleDefinitions, type RoleConfig, type RoleDefinition, type RoleId, type RoleOverride, type RoleOverridesFile, type RoleRegistryHealth, type RoleRegistrySnapshot } from "./types";

/** The newest schema this build reads and writes. A file without builder
    variants is still written as 1 (see RoleOverridesFile). */
export const ROLE_OVERRIDES_SCHEMA_VERSION = 2;
const ROLE_REGISTRY_REVISION_VERSION = 1;
const READABLE_SCHEMA_VERSIONS: readonly unknown[] = [1, 2];

/** Shipped runtime of each builder variant; a saved variant mapping merges over it. */
export const BUILDER_VARIANT_DEFAULTS: Record<BuilderVariantId, RoleConfig> = {
  frontend: BUILDER_FRONTEND_CONFIG,
  "apply-fixes": BUILDER_APPLY_FIXES_CONFIG,
};

/** Hard cap for any persisted prompt scaffold, shared with the pipeline store
    so a value that saves is always a value that loads. */
export const MAX_SCAFFOLD_LENGTH = 12_000;

export class RoleStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoleStoreError";
  }
}

const overridesFile = () => statePath("role-presets.json");

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);
}

function isPartialConfig(value: unknown): value is Partial<RoleConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "engine" && key !== "model" && key !== "effort")) return false;
  const { engine, model, effort } = value as Partial<RoleConfig>;
  if (engine !== undefined && engine !== "claude" && engine !== "codex") return false;
  if (model !== undefined && (typeof model !== "string" || model.length > 128)) return false;
  if (effort !== undefined && (typeof effort !== "string" || effort.length > 32)) return false;
  return true;
}

function isVariantId(value: string): value is BuilderVariantId {
  return (BUILDER_VARIANT_IDS as readonly string[]).includes(value);
}

function isOverride(value: unknown): value is RoleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "config" && key !== "promptScaffold" && key !== "variants")) return false;
  const override = value as RoleOverride;
  if (override.promptScaffold !== undefined && (typeof override.promptScaffold !== "string" || override.promptScaffold.length > MAX_SCAFFOLD_LENGTH)) return false;
  if (override.config !== undefined && !isPartialConfig(override.config)) return false;
  if (override.variants !== undefined) {
    if (!override.variants || typeof override.variants !== "object" || Array.isArray(override.variants)) return false;
    for (const [key, variant] of Object.entries(override.variants)) {
      if (!isVariantId(key) || !isPartialConfig(variant)) return false;
    }
  }
  return true;
}

function isCompatibleConfig(id: string, config: RoleConfig): boolean {
  if (config.model.length > 128 || /[\u0000-\u001f\u007f]/.test(config.model)) return false;
  if (config.engine === "claude" && !normalizeClaudeLaunchModel(config.model)) return false;
  if (config.engine === "codex" && !config.model.startsWith("gpt-")) return false;
  const scale = effortScale(config.engine, config.model)!;
  if (!scale.includes(config.effort)) {
    throw new RoleStoreError(`invalid role override: ${id}; effort for ${config.engine}/${config.model} must be one of: ${scale.join(", ")}`);
  }
  return true;
}

function isCompatibleOverride(id: RoleId, override: RoleOverride): boolean {
  const defaults = ROLE_DEFAULTS.find((role) => role.id === id)!;
  if (!isCompatibleConfig(id, { ...defaults.config, ...override.config })) return false;
  if (override.variants === undefined) return true;
  /* Variants belong to the builder's parameter combinations; no other role has them. */
  if (id !== "builder") return false;
  return Object.entries(override.variants).every(([key, variant]) =>
    isCompatibleConfig(`${id}.${key}`, { ...BUILDER_VARIANT_DEFAULTS[key as BuilderVariantId], ...variant }));
}

export function loadRoleOverrides(): RoleOverridesFile {
  let text: string;
  try {
    text = fs.readFileSync(overridesFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, overrides: {} };
    throw new RoleStoreError(`could not read role override registry: ${overridesFile()}`, { cause: error });
  }
  let raw: Partial<RoleOverridesFile>;
  try {
    raw = JSON.parse(text) as Partial<RoleOverridesFile>;
  } catch (error) {
    throw new RoleStoreError("role override registry contains malformed JSON", { cause: error });
  }
  if (!READABLE_SCHEMA_VERSIONS.includes(raw.schemaVersion)) {
    throw new RoleStoreError(`unsupported role override schema: ${String(raw.schemaVersion)}`);
  }
  if (!raw.overrides || typeof raw.overrides !== "object" || Array.isArray(raw.overrides)) {
    throw new RoleStoreError("role override registry must contain an overrides object");
  }
  const overrides: Partial<Record<RoleId, RoleOverride>> = {};
  for (const [id, override] of Object.entries(raw.overrides)) {
    if (!isRoleId(id) || !isOverride(override) || !isCompatibleOverride(id, override)) throw new RoleStoreError(`invalid role override: ${id}`);
    overrides[id] = override;
  }
  return { schemaVersion: schemaVersionFor(overrides), overrides };
}

function schemaVersionFor(overrides: Partial<Record<RoleId, RoleOverride>>): 1 | 2 {
  return Object.values(overrides).some((override) => override?.variants !== undefined) ? 2 : 1;
}

export function saveRoleOverrides(overrides: Partial<Record<RoleId, RoleOverride>>): void {
  for (const [id, override] of Object.entries(overrides)) {
    if (!isRoleId(id) || !isOverride(override) || !isCompatibleOverride(id, override)) throw new RoleStoreError(`invalid role override: ${id}`);
  }
  atomicWriteJson(overridesFile(), { schemaVersion: schemaVersionFor(overrides), overrides });
}

/** One role's runtime mapping as `PUT /api/roles` carries it: a full config sets
    the row, `null` resets it to the shipped value, an absent key leaves it. */
export type RoleMappingPatch = {
  config?: RoleConfig | null;
  variants?: Partial<Record<BuilderVariantId, RoleConfig | null>>;
};

function sameConfig(left: RoleConfig, right: RoleConfig): boolean {
  return left.engine === right.engine && left.model === right.model && left.effort === right.effort;
}

function isFullConfig(value: unknown): value is RoleConfig {
  if (!isPartialConfig(value)) return false;
  return typeof value.engine === "string" && typeof value.model === "string" && typeof value.effort === "string";
}

/** Shape check for a mapping request, before anything is read or written. */
export function parseRoleMappingPatch(raw: unknown): Partial<Record<RoleId, RoleMappingPatch>> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "overrides must be an object keyed by role id";
  const patch: Partial<Record<RoleId, RoleMappingPatch>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRoleId(id)) return `unknown role: ${id}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return `overrides.${id} must be an object`;
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "config" && key !== "variants")) return `overrides.${id} carries config and variants only`;
    const row: RoleMappingPatch = {};
    if (entry.config !== undefined) {
      if (entry.config !== null && !isFullConfig(entry.config)) return `overrides.${id}.config must be { engine, model, effort } or null`;
      row.config = entry.config as RoleConfig | null;
    }
    if (entry.variants !== undefined) {
      if (id !== "builder") return `overrides.${id}.variants: only builder has variants`;
      if (!entry.variants || typeof entry.variants !== "object" || Array.isArray(entry.variants)) return "overrides.builder.variants must be an object";
      row.variants = {};
      for (const [key, variant] of Object.entries(entry.variants as Record<string, unknown>)) {
        if (!isVariantId(key)) return `unknown builder variant: ${key}`;
        if (variant !== null && !isFullConfig(variant)) return `overrides.builder.variants.${key} must be { engine, model, effort } or null`;
        row.variants[key] = variant as RoleConfig | null;
      }
    }
    patch[id] = row;
  }
  return patch;
}

/**
 * Apply a mapping change to the stored overrides (#1876). The stored file is
 * the base, so a `promptScaffold` override survives an edit of the runtime; a
 * row equal to the shipped value is dropped, so "default" is a real state and a
 * later change to the shipped defaults reaches every role nobody touched.
 */
export function applyRoleMappingPatch(
  stored: Partial<Record<RoleId, RoleOverride>>,
  patch: Partial<Record<RoleId, RoleMappingPatch>>,
): Partial<Record<RoleId, RoleOverride>> {
  const next: Partial<Record<RoleId, RoleOverride>> = structuredClone(stored);
  for (const [id, change] of Object.entries(patch) as [RoleId, RoleMappingPatch][]) {
    const shipped = ROLE_DEFAULTS.find((role) => role.id === id)!.config;
    const row: RoleOverride = { ...next[id] };
    if (change.config !== undefined) {
      if (change.config === null || sameConfig(change.config, shipped)) delete row.config;
      else row.config = { engine: change.config.engine, model: change.config.model, effort: change.config.effort };
    }
    if (change.variants !== undefined) {
      const variants = { ...row.variants };
      for (const [key, variant] of Object.entries(change.variants) as [BuilderVariantId, RoleConfig | null][]) {
        if (variant === null || sameConfig(variant, BUILDER_VARIANT_DEFAULTS[key])) delete variants[key];
        else variants[key] = { engine: variant.engine, model: variant.model, effort: variant.effort };
      }
      if (Object.keys(variants).length) row.variants = variants;
      else delete row.variants;
    }
    if (Object.keys(row).length) next[id] = row;
    else delete next[id];
  }
  return next;
}

/** Read, patch, validate and write the mapping in one step; answers the merged catalog. */
export function saveRoleMapping(patch: Partial<Record<RoleId, RoleMappingPatch>>): RoleDefinition[] {
  const next = applyRoleMappingPatch(loadRoleOverrides().overrides, patch);
  saveRoleOverrides(next);
  return mergeRoleDefinitions(next);
}

export function mergeRoleDefinitions(overrides: Partial<Record<RoleId, RoleOverride>>): RoleDefinition[] {
  return ROLE_DEFAULTS.map((role) => {
    const override = overrides[role.id];
    return {
      ...role,
      config: { ...role.config, ...override?.config },
      promptScaffold: override?.promptScaffold ?? role.promptScaffold,
      ...(role.id === "builder" ? {
        variants: {
          frontend: { ...BUILDER_VARIANT_DEFAULTS.frontend, ...override?.variants?.frontend },
          "apply-fixes": { ...BUILDER_VARIANT_DEFAULTS["apply-fixes"], ...override?.variants?.["apply-fixes"] },
        },
      } : {}),
    };
  });
}

export function loadRoleDefinitions(): RoleDefinition[] {
  return mergeRoleDefinitions(loadRoleOverrides().overrides);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function registryRevision(overrides: Partial<Record<RoleId, RoleOverride>>): string {
  const content = {
    revisionVersion: ROLE_REGISTRY_REVISION_VERSION,
    overrides,
    shipped: ROLE_DEFAULTS.map(({ id, config }) => ({ id, config })),
    shippedBuilderVariants: BUILDER_VARIANT_DEFAULTS,
  };
  return `roles-${ROLE_REGISTRY_REVISION_VERSION}-${createHash("sha256").update(canonicalJson(content)).digest("hex").slice(0, 20)}`;
}

function registrySnapshot(overrides: Partial<Record<RoleId, RoleOverride>>, health: RoleRegistryHealth): RoleRegistrySnapshot {
  return { roles: mergeRoleDefinitions(overrides), revision: registryRevision(overrides), health };
}

export function loadRoleRegistrySnapshot(): RoleRegistrySnapshot {
  const { overrides } = loadRoleOverrides();
  return registrySnapshot(overrides, { state: "healthy" });
}

export function loadRoleRegistrySnapshotOrDefaults(): RoleRegistrySnapshot {
  try {
    return loadRoleRegistrySnapshot();
  } catch (error) {
    console.warn("[roles] override registry unreadable; falling back to built-in defaults", error);
    return registrySnapshot({}, { state: "degraded", reason: "preset unavailable" });
  }
}

/** Seed catalogs must stay renderable when the overrides file fails closed
    (hand edit, or schema skew between viewer versions sharing one config
    dir) — they degrade to the built-in role defaults instead of taking the
    importing module down with them. */
export function loadRoleDefinitionsOrDefaults(): RegistryRoleDefinitions {
  const snapshot = loadRoleRegistrySnapshotOrDefaults();
  const roles = snapshot.roles as RegistryRoleDefinitions;
  Object.defineProperty(roles, "registry", {
    value: { revision: snapshot.revision, health: snapshot.health },
    enumerable: false,
  });
  return roles;
}
