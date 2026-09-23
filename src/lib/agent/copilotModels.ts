import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { ENGINE_MODELS, type AgentModelOption } from "./models";
import { effortScale } from "./efforts";

export interface CopilotModelEntry {
  id: string;
  name: string;
  efforts: string[] | null;
  pickerEnabled: boolean;
}

export interface CopilotModelCatalog {
  accountId: string;
  capturedAt: string;
  source: "acp-config" | "slash-model" | "static";
  models: CopilotModelEntry[];
}

type ModelInfo = { id: string; name?: string; efforts?: readonly string[]; pickerEnabled?: boolean };
interface StoredCatalogs { version: 1; catalogs: Record<string, CopilotModelCatalog> }

const transcriptInfoCache = new Map<string, { size: number; mtimeMs: number; models: ModelInfo[] }>();

const MODEL_CONFIG_IDS = new Set(["model", "models"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse only the model option from ACP `session/new`; unknown option shapes
    return an empty result so the explicit static fallback can be used. */
export function copilotModelsFromConfigOptions(configOptions: unknown): CopilotModelEntry[] {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.map(record).find((item) => item && (
    (typeof item.id === "string" && MODEL_CONFIG_IDS.has(item.id.toLowerCase()))
    || (typeof item.category === "string" && item.category.toLowerCase() === "model")
  ));
  if (!option || !Array.isArray(option.options)) return [];
  const models = option.options.flatMap((raw): CopilotModelEntry[] => {
    const item = record(raw);
    const id = typeof item?.value === "string" ? item.value : typeof item?.id === "string" ? item.id : null;
    if (!id || id.length > 128 || !/^[a-z0-9][a-z0-9.-]*$/.test(id)) return [];
    const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim()
      : typeof item?.label === "string" && item.label.trim() ? item.label.trim() : id;
    return [{ id, name, efforts: null, pickerEnabled: item?.model_picker_enabled !== false && item?.pickerEnabled !== false }];
  });
  const unique = new Map<string, CopilotModelEntry>();
  for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
  return [...unique.values()];
}

export function mergeCopilotModelInfo(models: readonly CopilotModelEntry[], info: readonly ModelInfo[]): CopilotModelEntry[] {
  const byId = new Map(info.map((model) => [model.id, model]));
  return models.map((model) => {
    const discovered = byId.get(model.id);
    const efforts = discovered?.efforts?.filter((effort) => typeof effort === "string") ?? model.efforts;
    return {
      ...model,
      ...(discovered?.name ? { name: discovered.name } : {}),
      efforts: efforts?.length ? [...efforts] : null,
      pickerEnabled: discovered?.pickerEnabled ?? model.pickerEnabled,
    };
  });
}

export function modelInfoFromCopilotTranscript(sessionStateDir: string): ModelInfo[] {
  let directories: fs.Dirent[];
  try { directories = fs.readdirSync(sessionStateDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); }
  catch { return []; }
  const found = new Map<string, ModelInfo>();
  const root = path.resolve(sessionStateDir) + path.sep;
  const livePaths = new Set(directories.map((directory) => path.join(sessionStateDir, directory.name, "events.jsonl")));
  for (const cachedPath of transcriptInfoCache.keys()) {
    if (cachedPath.startsWith(root) && !livePaths.has(cachedPath)) transcriptInfoCache.delete(cachedPath);
  }
  for (const directory of directories) {
    const pathname = path.join(sessionStateDir, directory.name, "events.jsonl");
    let fileStat: fs.Stats;
    try { fileStat = fs.statSync(pathname); } catch { transcriptInfoCache.delete(pathname); continue; }
    const cached = transcriptInfoCache.get(pathname);
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      for (const model of cached.models) found.set(model.id, model);
      continue;
    }
    let descriptor: number;
    try { descriptor = fs.openSync(pathname, "r"); } catch { continue; }
    try {
      const fileModels = new Map<string, ModelInfo>();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let linePrefix = "";
      let targetLine: string | null = null;
      let lineLength = 0;
      const consume = (line: string) => {
        if (!line.includes('"model.model_call_started"')) return;
        try {
          const event = record(JSON.parse(line));
          if (event?.type !== "model.model_call_started") return;
          const data = record(event.data);
          const raw = record(data?.modelInfo);
          const capabilities = record(raw?.capabilities);
          const supports = record(capabilities?.supports);
          const id = typeof raw?.id === "string" ? raw.id : null;
          const efforts = Array.isArray(supports?.reasoning_effort) && supports.reasoning_effort.every((entry) => typeof entry === "string")
            ? supports.reasoning_effort as string[] : null;
          if (!id || !efforts) return;
          fileModels.set(id, { id, name: typeof raw?.name === "string" ? raw.name : undefined, efforts, pickerEnabled: raw?.model_picker_enabled !== false });
        } catch { /* malformed transcript line */ }
      };
      let offset = 0;
      for (;;) {
        const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
        if (!read) break;
        offset += read;
        let start = 0;
        for (let index = 0; index < read; index++) {
          if (chunk[index] !== 0x0a) continue;
          const fragment = chunk.subarray(start, index).toString("utf8");
          if (targetLine !== null) consume(targetLine + linePrefix + fragment);
          else if (linePrefix.includes('"model.model_call_started"') || fragment.includes('"model.model_call_started"')) consume(linePrefix + fragment);
          linePrefix = "";
          targetLine = null;
          lineLength = 0;
          start = index + 1;
        }
        if (start < read) {
          const fragment = chunk.subarray(start, read).toString("utf8");
          lineLength += fragment.length;
          if (targetLine !== null) targetLine += fragment;
          else if (linePrefix.length < 2048) linePrefix += fragment.slice(0, 2048 - linePrefix.length);
          if (lineLength > 2 * 1024 * 1024) { linePrefix = ""; targetLine = null; }
          else if (linePrefix.includes('"model.model_call_started"')) { targetLine = linePrefix; linePrefix = ""; }
        }
      }
      if (targetLine !== null) consume(targetLine + linePrefix);
      const models = [...fileModels.values()];
      transcriptInfoCache.set(pathname, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, models });
      for (const model of models) found.set(model.id, model);
    } finally { fs.closeSync(descriptor); }
  }
  return [...found.values()];
}

function fallbackModels(): CopilotModelEntry[] {
  return (ENGINE_MODELS.copilot as readonly AgentModelOption[]).map(({ id, label }) => ({
    id, name: label, efforts: id === "auto" ? null : [...(effortScale("copilot", id) ?? [])], pickerEnabled: true,
  }));
}

function readStore(): StoredCatalogs {
  try {
    const value = JSON.parse(fs.readFileSync(statePath("copilot-model-catalogs.json"), "utf8")) as Partial<StoredCatalogs>;
    if (value.version !== 1 || !value.catalogs || typeof value.catalogs !== "object" || Array.isArray(value.catalogs)) return { version: 1, catalogs: {} };
    return { version: 1, catalogs: value.catalogs as Record<string, CopilotModelCatalog> };
  } catch { return { version: 1, catalogs: {} }; }
}

function writeStore(store: StoredCatalogs): void {
  const file = statePath("copilot-model-catalogs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function writeCopilotModelCatalog(
  accountId: string,
  models: readonly CopilotModelEntry[],
  source: CopilotModelCatalog["source"] = "acp-config",
): CopilotModelCatalog {
  const catalog: CopilotModelCatalog = {
    accountId,
    capturedAt: new Date().toISOString(),
    source,
    models: mergeCopilotModelInfo(models, []),
  };
  const store = readStore();
  writeStore({ version: 1, catalogs: { ...store.catalogs, [accountId]: catalog } });
  return catalog;
}

export function copilotModelCatalog(accountId: string, sessionStateDir?: string): CopilotModelCatalog {
  const stored = readStore().catalogs[accountId];
  const fallback = fallbackModels();
  const base = stored?.models?.length ? stored : {
    accountId,
    capturedAt: new Date(0).toISOString(),
    source: "static" as const,
    models: fallback,
  };
  const info = sessionStateDir ? modelInfoFromCopilotTranscript(sessionStateDir) : [];
  const merged = mergeCopilotModelInfo(base.models, info);
  const auto = merged.find((model) => model.id === "auto") ?? fallback[0]!;
  return { ...base, models: [auto, ...merged.filter((model) => model.id !== "auto" && model.pickerEnabled)] };
}
