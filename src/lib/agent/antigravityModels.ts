import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { effortScale, registerAntigravityEffortScales } from "./efforts";
import { ENGINE_MODELS, type AgentModelOption } from "./models";

/**
 * Antigravity CLI (`agy`) model catalog and combined-id resolution
 * (docs/design/antigravity-engine.md §2.4 & §3.4).
 *
 * `agy models` prints combined `<base>-<effort>` identifiers (for example
 * `gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)`), whereas ACP `session/new`
 * exposes both `models.availableModels` (the combined ids) and `configOptions`
 * (`model` base ids + per-model `thought_level` options).
 *
 * Callers may pass either a base model + effort (`gemini-4-neon` + `xhigh`) or
 * a combined `agy models` id (`gemini-4-neon-xhigh`). This module resolves both
 * forms consistently and persists discovered catalogs atomically per account.
 */

export interface AntigravityModelEntry {
  id: string;
  name: string;
  efforts: string[] | null;
  combinedIds: string[];
  pickerEnabled: boolean;
}

export interface AntigravityModelCatalog {
  accountId: string;
  capturedAt: string;
  source: "acp-config" | "cli-models" | "static";
  models: AntigravityModelEntry[];
}

export interface ResolvedAntigravityModel {
  baseModel: string | null;
  thoughtLevel: string | null;
  combinedId: string | null;
}

interface StoredCatalogs {
  version: 1;
  catalogs: Record<string, AntigravityModelCatalog>;
}

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORT_SUFFIXES = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_ORDER = new Map<string, number>(EFFORT_SUFFIXES.map((effort, index) => [effort, index]));

/** Models whose own canonical ACP `model` config value carries a tier-like
    suffix or has no separate `thought_level` dial in `agy 1.5.13`. */
export const ANTIGRAVITY_FIXED_MODEL_IDS = new Set([
  "gpt-oss-120b-medium",
  "gemini-pro-orchestrator-neon",
  "gemini-pro-orchestrator-g1-pro",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sortEfforts(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)]
    .filter((effort) => typeof effort === "string" && effort.trim().length > 0)
    .sort((left, right) => {
      const l = EFFORT_ORDER.get(left) ?? 999;
      const r = EFFORT_ORDER.get(right) ?? 999;
      return l - r || left.localeCompare(right);
    });
}

function cloneEntry(entry: AntigravityModelEntry): AntigravityModelEntry {
  return {
    id: entry.id,
    name: entry.name,
    efforts: entry.efforts ? [...entry.efforts] : null,
    combinedIds: [...entry.combinedIds],
    pickerEnabled: entry.pickerEnabled,
  };
}

function cloneCatalog(catalog: AntigravityModelCatalog): AntigravityModelCatalog {
  return {
    accountId: catalog.accountId,
    capturedAt: catalog.capturedAt,
    source: catalog.source,
    models: catalog.models.map(cloneEntry),
  };
}

/** Splits a combined `agy models` id like `gemini-4-neon-xhigh` into its ACP
    base model (`gemini-4-neon`) and `thought_level` (`xhigh`). Fixed models
    such as `gpt-oss-120b-medium` keep their full id intact. */
export function splitCombinedAntigravityModelId(modelId: string): { baseModel: string; suffixEffort: string | null } {
  const trimmed = modelId.trim();
  if (!trimmed || ANTIGRAVITY_FIXED_MODEL_IDS.has(trimmed)) {
    return { baseModel: trimmed, suffixEffort: null };
  }
  for (const suffix of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (trimmed.endsWith(marker) && trimmed.length > marker.length) {
      return { baseModel: trimmed.slice(0, -marker.length), suffixEffort: suffix };
    }
  }
  return { baseModel: trimmed, suffixEffort: null };
}

/** Resolves a launch model + optional effort into the ACP `model` and
    `thought_level` config values. An explicit effort overrides any suffix on a
    combined model id. */
export function resolveAntigravityModelAndEffort(
  model?: string | null,
  effort?: string | null,
): ResolvedAntigravityModel {
  const rawModel = typeof model === "string" ? model.trim() : "";
  const rawEffort = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  if (!rawModel) {
    return {
      baseModel: null,
      thoughtLevel: rawEffort || null,
      combinedId: null,
    };
  }
  if (ANTIGRAVITY_FIXED_MODEL_IDS.has(rawModel)) {
    return {
      baseModel: rawModel,
      thoughtLevel: rawEffort && rawEffort !== "medium" ? rawEffort : null,
      combinedId: rawModel,
    };
  }
  const { baseModel, suffixEffort } = splitCombinedAntigravityModelId(rawModel);
  const thoughtLevel = rawEffort || suffixEffort || null;
  return {
    baseModel,
    thoughtLevel,
    combinedId: thoughtLevel ? `${baseModel}-${thoughtLevel}` : baseModel,
  };
}

function stripDisplayEffortSuffix(name: string): string {
  return name.replace(/\s*\((?:Low|Medium|High|XHigh|Extra|Max)\)\s*$/i, "").trim() || name.trim();
}

/** Parses `agy models` stdout (`<modelId>\t<displayName>` per line). */
export function parseAntigravityModelsOutput(stdout: string): AntigravityModelEntry[] {
  const byBase = new Map<string, { id: string; name: string; efforts: Set<string>; combinedIds: Set<string> }>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    const rawId = (tab >= 0 ? line.slice(0, tab) : line.split(/\s+/)[0] ?? "").trim();
    if (!rawId || !MODEL_ID_PATTERN.test(rawId)) continue;
    const rawName = (tab >= 0 ? line.slice(tab + 1) : rawId).trim() || rawId;
    const { baseModel, suffixEffort } = splitCombinedAntigravityModelId(rawId);
    const existing = byBase.get(baseModel);
    if (existing) {
      if (suffixEffort) existing.efforts.add(suffixEffort);
      existing.combinedIds.add(rawId);
      continue;
    }
    const efforts = new Set<string>();
    if (suffixEffort) efforts.add(suffixEffort);
    else if (rawId === "gpt-oss-120b-medium") efforts.add("medium");
    byBase.set(baseModel, {
      id: baseModel,
      name: suffixEffort ? stripDisplayEffortSuffix(rawName) : rawName,
      efforts,
      combinedIds: new Set([rawId]),
    });
  }
  return [...byBase.values()].map((item) => {
    const sorted = sortEfforts(item.efforts);
    return {
      id: item.id,
      name: item.name,
      efforts: sorted.length ? sorted : null,
      combinedIds: [...item.combinedIds],
      pickerEnabled: true,
    };
  });
}

/** Parses ACP `session/new` / `session/resume` / `session/set_config_option`
    metadata into normalized Antigravity model entries. */
export function antigravityModelsFromAcp(
  configOptions: unknown,
  availableModels?: unknown,
): AntigravityModelEntry[] {
  const byId = new Map<string, AntigravityModelEntry>();
  const upsert = (id: string, name: string, efforts: string[] | null, combinedIds: string[]) => {
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        name,
        efforts: efforts?.length ? sortEfforts(efforts) : null,
        combinedIds: [...new Set(combinedIds)],
        pickerEnabled: true,
      });
      return;
    }
    if (name && existing.name === existing.id) existing.name = name;
    if (efforts?.length) {
      existing.efforts = sortEfforts([...(existing.efforts ?? []), ...efforts]);
    }
    if (combinedIds.length) {
      existing.combinedIds = [...new Set([...existing.combinedIds, ...combinedIds])];
    }
  };

  if (Array.isArray(configOptions)) {
    const options = configOptions.map(record).filter((item): item is Record<string, unknown> => item !== null);
    const modelOption = options.find((item) => item.id === "model" || item.category === "model");
    const thoughtOption = options.find((item) => item.id === "thought_level" || item.category === "thought_level");
    const currentModel = typeof modelOption?.currentValue === "string" ? modelOption.currentValue.trim() : null;
    const currentEfforts = Array.isArray(thoughtOption?.options)
      ? sortEfforts(thoughtOption.options.flatMap((raw) => {
        const opt = record(raw);
        const value = typeof opt?.value === "string" ? opt.value.trim().toLowerCase() : null;
        return value ? [value] : [];
      }))
      : null;

    if (Array.isArray(modelOption?.options)) {
      for (const raw of modelOption.options) {
        const opt = record(raw);
        const id = typeof opt?.value === "string" ? opt.value.trim()
          : typeof opt?.id === "string" ? opt.id.trim() : null;
        if (!id || !MODEL_ID_PATTERN.test(id)) continue;
        const name = typeof opt?.name === "string" && opt.name.trim() ? opt.name.trim() : id;
        const efforts = currentModel === id && currentEfforts?.length ? currentEfforts : null;
        upsert(id, name, efforts, []);
      }
    }
  }

  if (Array.isArray(availableModels)) {
    const lines: string[] = [];
    for (const raw of availableModels) {
      const item = record(raw);
      const modelId = typeof item?.modelId === "string" ? item.modelId.trim() : null;
      if (!modelId || !MODEL_ID_PATTERN.test(modelId)) continue;
      const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : modelId;
      lines.push(`${modelId}\t${name}`);
    }
    for (const parsed of parseAntigravityModelsOutput(lines.join("\n"))) {
      upsert(parsed.id, parsed.name, parsed.efforts, parsed.combinedIds);
    }
  }

  return [...byId.values()].map(cloneEntry);
}

export function mergeAntigravityModelEntries(
  existing: readonly AntigravityModelEntry[],
  incoming: readonly AntigravityModelEntry[],
): AntigravityModelEntry[] {
  const byId = new Map<string, AntigravityModelEntry>();
  for (const item of existing) byId.set(item.id, cloneEntry(item));
  for (const item of incoming) {
    const prior = byId.get(item.id);
    if (!prior) {
      byId.set(item.id, cloneEntry(item));
      continue;
    }
    byId.set(item.id, {
      id: item.id,
      name: item.name || prior.name,
      efforts: item.efforts?.length ? sortEfforts(item.efforts) : prior.efforts ? [...prior.efforts] : null,
      combinedIds: [...new Set([...prior.combinedIds, ...item.combinedIds])],
      pickerEnabled: item.pickerEnabled,
    });
  }
  return [...byId.values()].map(cloneEntry);
}

function fallbackModels(): AntigravityModelEntry[] {
  return (ENGINE_MODELS.antigravity as readonly AgentModelOption[]).map(({ id, label }) => {
    const scale = effortScale("antigravity", id);
    const efforts = scale ? [...scale] : null;
    const combinedIds = ANTIGRAVITY_FIXED_MODEL_IDS.has(id) || !efforts?.length
      ? [id]
      : efforts.map((effort) => `${id}-${effort}`);
    return { id, name: label, efforts, combinedIds, pickerEnabled: true };
  });
}

function catalogFilePath(): string {
  return statePath("antigravity-model-catalogs.json");
}

function readStore(): StoredCatalogs {
  try {
    const value = JSON.parse(fs.readFileSync(catalogFilePath(), "utf8")) as Partial<StoredCatalogs>;
    if (value.version !== 1 || !value.catalogs || typeof value.catalogs !== "object" || Array.isArray(value.catalogs)) {
      return { version: 1, catalogs: {} };
    }
    return { version: 1, catalogs: value.catalogs as Record<string, AntigravityModelCatalog> };
  } catch {
    return { version: 1, catalogs: {} };
  }
}

function writeStore(store: StoredCatalogs): void {
  const file = catalogFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Persists discovered models atomically and updates the runtime effort ladder
    cache. Returns a fresh caller-owned copy. */
export function writeAntigravityModelCatalog(
  accountId: string,
  models: readonly AntigravityModelEntry[],
  source: AntigravityModelCatalog["source"] = "acp-config",
): AntigravityModelCatalog {
  const store = readStore();
  const prior = store.catalogs[accountId]?.models ?? [];
  const merged = mergeAntigravityModelEntries(prior, models);
  const catalog: AntigravityModelCatalog = {
    accountId,
    capturedAt: new Date().toISOString(),
    source,
    models: merged,
  };
  writeStore({ version: 1, catalogs: { ...store.catalogs, [accountId]: catalog } });
  registerAntigravityEffortScales(merged);
  return cloneCatalog(catalog);
}

/** Returns the persisted catalog for `accountId`, or the static fallback.
    Always returns fresh caller-owned arrays and objects. */
export function antigravityModelCatalog(accountId = "default"): AntigravityModelCatalog {
  const stored = readStore().catalogs[accountId];
  if (stored?.models?.length) {
    registerAntigravityEffortScales(stored.models);
    return cloneCatalog(stored);
  }
  return {
    accountId,
    capturedAt: new Date(0).toISOString(),
    source: "static",
    models: fallbackModels(),
  };
}

/** On-demand bounded refresh via `agy models`. Never invoked at import time or
    on periodic polling loops. */
export function refreshAntigravityModelsFromCli(
  binary: string,
  accountId = "default",
  timeoutMs = 10_000,
): Promise<AntigravityModelCatalog> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["models"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`agy models failed: ${error.message}`));
        return;
      }
      const parsed = parseAntigravityModelsOutput(stdout);
      if (!parsed.length) {
        reject(new Error("agy models returned no model entries"));
        return;
      }
      resolve(writeAntigravityModelCatalog(accountId, parsed, "cli-models"));
    });
  });
}
