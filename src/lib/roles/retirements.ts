/**
 * Stale preset overrides (docs/design/model-sizing-tiers.md §5). One pass at
 * the serving release's boot, journaled in role-presets.json itself:
 *
 * 1. Normalize: a row equal to the value shipped now is dropped. Nothing
 *    changes at runtime; the row stops being pinned, so the next change to a
 *    shipped default reaches it.
 * 2. Retire: each value listed below that a row still holds exactly is reset
 *    to the default, once per install, with the old value recorded so the
 *    operator sees it and can restore it in one click. A row holding anything
 *    else is the operator's choice and is left alone.
 */

import fs from "node:fs";
import path from "node:path";

import { assertStateStartupMutation } from "@/lib/stateOwnership";

import { ROLE_DEFAULTS } from "./defaults";
import { shippedVariantConfig } from "./paramConfig";
import { loadRoleOverrides, roleOverridesFile, sameConfig, saveRoleOverrides } from "./store";
import type { RoleConfig, RoleId, RoleMappingRetirementRecord, RoleOverride, RoleVariantId } from "./types";

export type RoleMappingRetirement = {
  id: string;
  /** A mapping row key: `builder`, `builder:frontend`. */
  row: string;
  config: RoleConfig;
};

export const ROLE_MAPPING_RETIREMENTS: readonly RoleMappingRetirement[] = [
  /* Never a shipped value: an install wrote it by hand before #2174 moved the
     frontend builder's effort ladder to high. */
  { id: "2026-09-builder-frontend-opus-xhigh", row: "builder:frontend", config: { engine: "claude", model: "opus", effort: "xhigh" } },
];

export type RoleMappingRetirementOutcome =
  | { state: "absent" | "unreadable" | "unchanged" }
  | { state: "written"; normalized: string[]; reset: string[] };

function parseRow(row: string): { roleId: RoleId; variant: RoleVariantId | null } {
  const [roleId, variant] = row.split(":", 2) as [RoleId, RoleVariantId | undefined];
  return { roleId, variant: variant ?? null };
}

function shippedFor(roleId: RoleId, variant: RoleVariantId | null): RoleConfig | null {
  if (variant) return shippedVariantConfig(roleId, variant);
  return ROLE_DEFAULTS.find((role) => role.id === roleId)?.config ?? null;
}

function storedRow(override: RoleOverride | undefined, variant: RoleVariantId | null): Partial<RoleConfig> | undefined {
  return variant ? override?.variants?.[variant] : override?.config;
}

function dropRow(overrides: Partial<Record<RoleId, RoleOverride>>, roleId: RoleId, variant: RoleVariantId | null): void {
  const row: RoleOverride = { ...overrides[roleId] };
  if (variant) {
    const variants = { ...row.variants };
    delete variants[variant];
    if (Object.keys(variants).length) row.variants = variants;
    else delete row.variants;
  } else {
    delete row.config;
  }
  if (Object.keys(row).length) overrides[roleId] = row;
  else delete overrides[roleId];
}

/** Every stored runtime row, as [row key, role, variant]. Scaffolds are not rows. */
function storedRows(overrides: Partial<Record<RoleId, RoleOverride>>): [string, RoleId, RoleVariantId | null][] {
  return (Object.entries(overrides) as [RoleId, RoleOverride][]).flatMap(([roleId, override]) => [
    ...(override.config ? [[roleId, roleId, null] as [string, RoleId, null]] : []),
    ...Object.keys(override.variants ?? {}).map((key) => [`${roleId}:${key}`, roleId, key as RoleVariantId] as [string, RoleId, RoleVariantId]),
  ]);
}

/**
 * The boot pass. Never creates the file when it is absent and never deletes
 * it (its existence is the onboarding marker); a file that fails validation is
 * left as it is. Only a process that owns the state directory's startup
 * mutations may run it against the operator's own directory.
 */
export function applyRoleMappingRetirements(
  retirements: readonly RoleMappingRetirement[] = ROLE_MAPPING_RETIREMENTS,
  now: () => string = () => new Date().toISOString(),
): RoleMappingRetirementOutcome {
  const file = roleOverridesFile();
  assertStateStartupMutation(path.dirname(file), "role mapping retirement");
  if (!fs.existsSync(file)) return { state: "absent" };
  let stored: ReturnType<typeof loadRoleOverrides>;
  try {
    stored = loadRoleOverrides();
  } catch {
    return { state: "unreadable" };
  }
  const overrides = structuredClone(stored.overrides);
  const journal: Record<string, RoleMappingRetirementRecord> = structuredClone(stored.retirements ?? {});
  const reset: string[] = [];
  const normalized: string[] = [];
  const at = now();

  for (const retirement of retirements) {
    if (journal[retirement.id]) continue;
    const { roleId, variant } = parseRow(retirement.row);
    const shipped = shippedFor(roleId, variant);
    const row = storedRow(overrides[roleId], variant);
    if (shipped && row && sameConfig({ ...shipped, ...row }, retirement.config)) {
      dropRow(overrides, roleId, variant);
      journal[retirement.id] = { at, reset: { row: retirement.row, from: { ...retirement.config } } };
      reset.push(retirement.row);
    } else {
      /* Applied either way, so an operator who restores the old value keeps it. */
      journal[retirement.id] = { at };
    }
  }

  for (const [key, roleId, variant] of storedRows(overrides)) {
    const shipped = shippedFor(roleId, variant);
    const row = storedRow(overrides[roleId], variant);
    if (shipped && row && sameConfig({ ...shipped, ...row }, shipped)) {
      dropRow(overrides, roleId, variant);
      normalized.push(key);
    }
  }

  const journalChanged = Object.keys(journal).length !== Object.keys(stored.retirements ?? {}).length;
  if (!reset.length && !normalized.length && !journalChanged) return { state: "unchanged" };
  saveRoleOverrides(overrides, journal);
  return { state: "written", normalized, reset };
}
