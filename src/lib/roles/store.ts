import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { effortScale } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { ROLE_DEFAULTS } from "./defaults";
import { ROLE_VARIANT_DEFAULTS, shippedVariantConfig } from "./paramConfig";
import { mappingRowRefusal } from "./sizing";
import { ROLE_IDS, ROLE_VARIANT_IDS, SCHEMA_2_VARIANT_IDS, type RegistryRoleDefinitions, type RoleConfig, type RoleDefinition, type RoleId, type RoleMappingReset, type RoleMappingRetirementRecord, type RoleOverride, type RoleOverridesFile, type RoleRegistryHealth, type RoleRegistrySnapshot, type RoleVariantId, type VariantRoleId } from "./types";

/** The newest schema this build reads and writes. A file is written at the
    lowest schema that holds its rows (see RoleOverridesFile). */
export const ROLE_OVERRIDES_SCHEMA_VERSION = 3;
const ROLE_REGISTRY_REVISION_VERSION = 1;
const READABLE_SCHEMA_VERSIONS: readonly unknown[] = [1, 2, 3];

/** Shipped runtime of each builder variant; a saved variant mapping merges over it. */
export const BUILDER_VARIANT_DEFAULTS = ROLE_VARIANT_DEFAULTS.builder;

/** Hard cap for any persisted prompt scaffold, shared with the pipeline store
    so a value that saves is always a value that loads. */
export const MAX_SCAFFOLD_LENGTH = 12_000;

export class RoleStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoleStoreError";
  }
}

export const roleOverridesFile = () => statePath("role-presets.json");
const overridesFile = roleOverridesFile;

export function atomicWriteJson(filePath: string, value: unknown): void {
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

function hasVariants(id: string): id is VariantRoleId {
  return Object.hasOwn(ROLE_VARIANT_IDS, id);
}

function isVariantOf(id: string, value: string): value is RoleVariantId {
  return hasVariants(id) && (ROLE_VARIANT_IDS[id] as readonly string[]).includes(value);
}

function isAnyVariantId(value: string): boolean {
  return Object.values(ROLE_VARIANT_IDS).some((ids) => (ids as readonly string[]).includes(value));
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
      if (!isAnyVariantId(key) || !isPartialConfig(variant)) return false;
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
  /* Variants belong to the parameter combinations of the builder and the
     reviewer; no other role has them, and each role only its own. */
  if (!hasVariants(id)) return false;
  return Object.entries(override.variants).every(([key, variant]) =>
    isVariantOf(id, key) && isCompatibleConfig(`${id}.${key}`, { ...shippedVariantConfig(id, key)!, ...variant }));
}

/* The retirement journal is advisory: a malformed entry is dropped on read
   rather than taking the whole registry down (§5). */
function readRetirements(value: unknown): Record<string, RoleMappingRetirementRecord> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, RoleMappingRetirementRecord> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as { at?: unknown; reset?: unknown };
    if (typeof record.at !== "string") continue;
    const reset = record.reset as { row?: unknown; from?: unknown } | undefined;
    out[id] = reset && typeof reset === "object" && typeof reset.row === "string" && isFullConfig(reset.from)
      ? { at: record.at, reset: { row: reset.row, from: { engine: reset.from.engine, model: reset.from.model, effort: reset.from.effort } } }
      : { at: record.at };
  }
  return out;
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
  const retirements = readRetirements(raw.retirements);
  return { schemaVersion: schemaVersionFor(overrides), overrides, ...(retirements ? { retirements } : {}) };
}

function schemaVersionFor(overrides: Partial<Record<RoleId, RoleOverride>>): 1 | 2 | 3 {
  const variantKeys = Object.values(overrides).flatMap((override) => override?.variants ? Object.keys(override.variants) : []);
  const anyVariants = Object.values(overrides).some((override) => override?.variants !== undefined);
  if (!anyVariants) return 1;
  /* A newer variant, or any variant on a role other than the builder, is
     schema 3, so an older build refuses the file instead of misreading it. */
  const reviewerVariants = overrides.reviewer?.variants !== undefined;
  return reviewerVariants || variantKeys.some((key) => !SCHEMA_2_VARIANT_IDS.includes(key)) ? 3 : 2;
}

/** Write the overrides, keeping the retirement journal. `retirements`
    undefined keeps whatever the file holds now. */
export function saveRoleOverrides(
  overrides: Partial<Record<RoleId, RoleOverride>>,
  retirements?: Record<string, RoleMappingRetirementRecord>,
): void {
  for (const [id, override] of Object.entries(overrides)) {
    if (!isRoleId(id) || !isOverride(override) || !isCompatibleOverride(id, override)) throw new RoleStoreError(`invalid role override: ${id}`);
  }
  const journal = retirements ?? storedRetirements();
  atomicWriteJson(overridesFile(), {
    schemaVersion: schemaVersionFor(overrides),
    overrides,
    ...(journal && Object.keys(journal).length ? { retirements: journal } : {}),
  });
}

function storedRetirements(): Record<string, RoleMappingRetirementRecord> | undefined {
  try {
    return readRetirements((JSON.parse(fs.readFileSync(overridesFile(), "utf8")) as { retirements?: unknown }).retirements);
  } catch {
    return undefined;
  }
}

/** The mapping row key a retirement names: `builder`, `builder:frontend`. */
export function mappingRowKey(roleId: RoleId, variant?: RoleVariantId | null): string {
  return variant ? `${roleId}:${variant}` : roleId;
}

/** The resets still shown to the operator: rows a retirement set back to the
    default that nobody has touched since. */
export function roleMappingResets(file: Pick<RoleOverridesFile, "retirements">): RoleMappingReset[] {
  return Object.entries(file.retirements ?? {}).flatMap(([id, record]) =>
    record.reset ? [{ id, row: record.reset.row, from: record.reset.from, at: record.at }] : []);
}

/** One role's runtime mapping as `PUT /api/roles` carries it: a full config sets
    the row, `null` resets it to the shipped value, an absent key leaves it. */
export type RoleMappingPatch = {
  config?: RoleConfig | null;
  variants?: Partial<Record<RoleVariantId, RoleConfig | null>>;
};

export function sameConfig(left: RoleConfig, right: RoleConfig): boolean {
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
    if (row.config) {
      const refusal = mappingRowRefusal(id, row.config);
      if (refusal) return refusal;
    }
    if (entry.variants !== undefined) {
      if (!hasVariants(id)) return `overrides.${id}.variants: only builder and reviewer have variants`;
      if (!entry.variants || typeof entry.variants !== "object" || Array.isArray(entry.variants)) return `overrides.${id}.variants must be an object`;
      row.variants = {};
      for (const [key, variant] of Object.entries(entry.variants as Record<string, unknown>)) {
        if (!isVariantOf(id, key)) return `unknown ${id} variant: ${key}`;
        if (variant !== null && !isFullConfig(variant)) return `overrides.${id}.variants.${key} must be { engine, model, effort } or null`;
        if (variant !== null) {
          const refusal = mappingRowRefusal(id, variant);
          if (refusal) return refusal;
        }
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
      for (const [key, variant] of Object.entries(change.variants) as [RoleVariantId, RoleConfig | null][]) {
        const shippedVariant = shippedVariantConfig(id, key);
        if (variant === null || (shippedVariant && sameConfig(variant, shippedVariant))) delete variants[key];
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

/** The rows a patch writes, as mapping row keys. */
function patchedRows(patch: Partial<Record<RoleId, RoleMappingPatch>>): Set<string> {
  const rows = new Set<string>();
  for (const [id, change] of Object.entries(patch) as [RoleId, RoleMappingPatch][]) {
    if (change.config !== undefined) rows.add(mappingRowKey(id));
    for (const key of Object.keys(change.variants ?? {}) as RoleVariantId[]) rows.add(mappingRowKey(id, key));
  }
  return rows;
}

/** Read, patch, validate and write the mapping in one step; answers the merged
    catalog. A write to a row a retirement reset clears that reset's notice,
    and the retirement stays applied. */
export function saveRoleMapping(patch: Partial<Record<RoleId, RoleMappingPatch>>): RoleDefinition[] {
  const stored = loadRoleOverrides();
  const next = applyRoleMappingPatch(stored.overrides, patch);
  const touched = patchedRows(patch);
  const retirements = Object.fromEntries(Object.entries(stored.retirements ?? {}).map(([id, record]) =>
    [id, record.reset && touched.has(record.reset.row) ? { at: record.at } : record]));
  saveRoleOverrides(next, retirements);
  return mergeRoleDefinitions(next);
}

export function mergeRoleDefinitions(overrides: Partial<Record<RoleId, RoleOverride>>): RoleDefinition[] {
  return ROLE_DEFAULTS.map((role) => {
    const override = overrides[role.id];
    return {
      ...role,
      config: { ...role.config, ...override?.config },
      promptScaffold: override?.promptScaffold ?? role.promptScaffold,
      ...(hasVariants(role.id) ? {
        variants: Object.fromEntries((ROLE_VARIANT_IDS[role.id] as readonly RoleVariantId[]).map((key) =>
          [key, { ...shippedVariantConfig(role.id, key)!, ...override?.variants?.[key] }])),
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
    shippedReviewerVariants: ROLE_VARIANT_DEFAULTS.reviewer,
  };
  return `roles-${ROLE_REGISTRY_REVISION_VERSION}-${createHash("sha256").update(canonicalJson(content)).digest("hex").slice(0, 20)}`;
}

function registrySnapshot(overrides: Partial<Record<RoleId, RoleOverride>>, health: RoleRegistryHealth, resets: RoleMappingReset[] = []): RoleRegistrySnapshot {
  return { roles: mergeRoleDefinitions(overrides), revision: registryRevision(overrides), health, resets };
}

export function loadRoleRegistrySnapshot(): RoleRegistrySnapshot {
  const file = loadRoleOverrides();
  return registrySnapshot(file.overrides, { state: "healthy" }, roleMappingResets(file));
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
    value: { revision: snapshot.revision, health: snapshot.health, resets: snapshot.resets ?? [] },
    enumerable: false,
  });
  return roles;
}
