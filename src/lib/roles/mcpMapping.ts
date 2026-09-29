import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";

import { ROLE_VARIANT_DEFAULTS } from "./paramConfig";
import { ROLE_DEFAULTS } from "./defaults";
import type { RoleMappingPatch } from "./store";
import type { RoleConfig, RoleDefinition, RoleId, RoleRegistrySnapshot, RoleVariantId } from "./types";

/* What an agent may write into the role mapping over MCP (#2019). The store
   accepts any `gpt-*` id and any Claude family; a caller that cannot see the
   picker needs the launch catalogue itself, and a refusal that names it. */

const MAPPING_ENGINES = ["claude", "codex"] as const;
type MappingEngine = typeof MAPPING_ENGINES[number];

/** Every model a role row may run on, with the efforts each accepts. */
export function roleLaunchChoices(): Record<MappingEngine, Record<string, readonly string[]>> {
  const choices = { claude: {}, codex: {} } as Record<MappingEngine, Record<string, readonly string[]>>;
  for (const engine of MAPPING_ENGINES) {
    for (const option of ENGINE_MODELS[engine]) choices[engine][option.id] = effortScale(engine, option.id) ?? [];
  }
  return choices;
}

export type RoleMappingViolation = { field: string; message: string; expected: string };

function configViolations(field: string, config: RoleConfig): RoleMappingViolation[] {
  const engines: readonly string[] = MAPPING_ENGINES;
  if (!engines.includes(config.engine)) {
    return [{ field: `${field}.engine`, message: `unknown engine ${JSON.stringify(config.engine)}`, expected: `one of: ${MAPPING_ENGINES.join(", ")}` }];
  }
  const models = ENGINE_MODELS[config.engine].map((option) => option.id);
  if (!models.includes(config.model)) {
    return [{
      field: `${field}.model`,
      message: `unknown ${config.engine} model ${JSON.stringify(config.model)}`,
      expected: `one of: ${models.join(", ")}`,
    }];
  }
  const scale = effortScale(config.engine, config.model) ?? [];
  if (!scale.includes(config.effort)) {
    return [{
      field: `${field}.effort`,
      message: `effort ${JSON.stringify(config.effort)} is not valid for ${config.engine}/${config.model}`,
      expected: `one of: ${scale.join(", ")}`,
    }];
  }
  return [];
}

/** Every row of a patch that names a runtime outside the launch catalogue,
    collected together so one refusal lists all of them and nothing is written. */
export function roleMappingViolations(patch: Partial<Record<RoleId, RoleMappingPatch>>): RoleMappingViolation[] {
  const violations: RoleMappingViolation[] = [];
  for (const [id, change] of Object.entries(patch) as [RoleId, RoleMappingPatch][]) {
    if (change.config) violations.push(...configViolations(`overrides.${id}.config`, change.config));
    for (const [key, variant] of Object.entries(change.variants ?? {})) {
      if (variant) violations.push(...configViolations(`overrides.${id}.variants.${key}`, variant));
    }
  }
  return violations;
}

/** The registry as an agent reads it: each role's runtime and variants beside
    the shipped ones, without the prompt scaffolds. */
export function roleRegistryAnswer(snapshot: RoleRegistrySnapshot): Record<string, unknown> {
  return {
    revision: snapshot.revision,
    health: snapshot.health,
    roles: snapshot.roles.map((role) => {
      const shipped = ROLE_DEFAULTS.find((candidate) => candidate.id === role.id)!;
      const shippedVariants = role.id in ROLE_VARIANT_DEFAULTS ? ROLE_VARIANT_DEFAULTS[role.id as keyof typeof ROLE_VARIANT_DEFAULTS] : undefined;
      return {
        id: role.id,
        name: role.name,
        config: role.config,
        ...(role.variants ? { variants: role.variants } : {}),
        shipped: { config: shipped.config, ...(shippedVariants ? { variants: shippedVariants } : {}) },
        promptScaffoldOverridden: role.promptScaffold !== shipped.promptScaffold,
      };
    }),
    resets: snapshot.resets ?? [],
  };
}

/* ── the audit log ───────────────────────────────────────────────────────── */

export type RoleMappingAuditRow = { row: string; before: unknown; after: unknown };

export type RoleMappingAuditEntry = {
  at: string;
  actor: { kind: string; conversationId: string | null; role: string | null; via?: { deputy: string } };
  clientRequestId: string | null;
  revisionBefore: string;
  revisionAfter: string;
  rows: RoleMappingAuditRow[];
};

/** Append-only, one JSON object per line, beside role-presets.json. */
export const roleMappingAuditFile = () => statePath("role-presets-audit.jsonl");

export function appendRoleMappingAudit(entry: RoleMappingAuditEntry): void {
  const file = roleMappingAuditFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

const SHIPPED_TEXT = "shipped";
const OVERRIDDEN_TEXT = "override";

/** The mapping rows whose runtime differs between two merged registries, each
    with both sides. A prompt scaffold row records only whether the shipped text
    is in force, since the text itself is not writable over this surface. */
export function changedMappingRows(before: readonly RoleDefinition[], after: readonly RoleDefinition[]): RoleMappingAuditRow[] {
  const rows: RoleMappingAuditRow[] = [];
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  for (const next of after) {
    const previous = before.find((role) => role.id === next.id);
    if (!previous) continue;
    if (differs(previous.config, next.config)) rows.push({ row: next.id, before: previous.config, after: next.config });
    for (const key of Object.keys(next.variants ?? {}) as RoleVariantId[]) {
      if (differs(previous.variants?.[key], next.variants?.[key])) {
        rows.push({ row: `${next.id}:${key}`, before: previous.variants?.[key] ?? null, after: next.variants?.[key] ?? null });
      }
    }
    if (previous.promptScaffold !== next.promptScaffold) {
      const shipped = ROLE_DEFAULTS.find((role) => role.id === next.id)!.promptScaffold;
      rows.push({
        row: `${next.id}:promptScaffold`,
        before: previous.promptScaffold === shipped ? SHIPPED_TEXT : OVERRIDDEN_TEXT,
        after: next.promptScaffold === shipped ? SHIPPED_TEXT : OVERRIDDEN_TEXT,
      });
    }
  }
  return rows;
}
