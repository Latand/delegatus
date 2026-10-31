import fs from "node:fs";
import path from "node:path";

import { cachedJsonFile } from "@/lib/state/cachedJsonFile";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { statePath } from "@/lib/configDir";
import { FileTransactionBusyError, withFileTransaction, withFileTransactionSync } from "@/lib/state/fileTransaction";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { translate, type Locale } from "@/lib/i18n/core";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { canonicalProject, projectAliasKeys, projectAliasSnapshot, recordedProjectRemote } from "@/lib/projects/aliases";
import { assertAgentMemoryMax, validAgentMemoryMax } from "@/lib/runtime/agentMemoryConfig";

/*
 * Per-project settings (#2187 §4.1, docs/design/merge-policy-and-task-finishing.md).
 * Two settings: "merge when the review passes", absent reading as off, and
 * "bridge reports" (#2146), absent reading as on. Their own file, because the
 * other per-project stores each own something else (`project-curation.json`
 * crowns and manual projects, `seat-tick-settings.json` the monitor). Settings
 * retain a file snapshot read and an atomic write.
 *
 * Keyed by the canonical project key and read through `canonicalProject`, so a
 * folder whose key moved (AGENTS.md, succession) keeps its setting. An absent
 * entry reads as the setting's default, and no project is seeded.
 */

export interface ProjectSwitchSetting {
  enabled: boolean;
  /** Server clock, ISO. Null for a project that never had the setting written. */
  changedAt: string | null;
  changedBy: string | null;
}

export type MergeOnReviewSetting = ProjectSwitchSetting;
export type BridgeReportsSetting = ProjectSwitchSetting;

type StoredSwitch = { enabled: boolean; changedAt: string; changedBy: string };

/**
 * Where the project's manager reports go besides the bridge log
 * (docs/design/orchestrator-reports.md §3.6, §5.6): one allowlisted bot chat,
 * chosen by the operator in the setup guide, and the name report headers
 * carry. An explicit "Log only" is stored as `chat: null`, so it stays apart
 * from a project that never chose. Both report to the bridge log only: a
 * project posts to Telegram only once the operator chose a chat for it.
 */
export interface ReportTelegramSetting {
  /** The bot chat's alias. */
  chat: string;
  /** The project's name in report headers; never a local folder name. */
  name: string;
  topicId?: number;
  changedAt: string;
  changedBy: string;
}

/** The operator chose "Log only, no Telegram" for the project. */
export interface ReportLogOnlySetting {
  chat: null;
  changedAt: string;
  changedBy: string;
}

export type ReportTelegramChoice = ReportTelegramSetting | ReportLogOnlySetting;

/**
 * Where a project's reports actually go besides the bridge: the chat the
 * operator chose. There is no other source; a project that never chose
 * reports to the bridge log only.
 */
export interface EffectiveReportTelegram {
  chat: string;
  name: string;
  topicId?: number;
  source: "chosen";
}

interface ProjectSettingsEntry {
  codexCloudEnvironmentId?: string;
  pipelineStageRuntime?: "local" | "codex-cloud";
  cloudStageAccountCursor?: string;
  agentMemoryMaxBytes?: number | null;
  mergeOnReview?: StoredSwitch;
  /** #2146: whether the project's orchestrator files bridge reports and the
      voice relay delivers them. Absent reads as on. */
  bridgeReports?: StoredSwitch;
  reportTelegram?: ReportTelegramChoice;
}

type ProjectSwitchName = "mergeOnReview" | "bridgeReports";

export const REPORT_NAME_MAX_CHARS = 60;

interface ProjectSettingsFile {
  schemaVersion: 1;
  projects: Record<string, ProjectSettingsEntry>;
}

const DEFAULTS: Record<ProjectSwitchName, boolean> = { mergeOnReview: false, bridgeReports: true };

const cache = cachedJsonFile(decodeProjects);

function settingsFile(): string {
  return statePath("project-settings.json");
}

function switchOf(value: unknown): StoredSwitch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
  return { enabled: record.enabled, changedAt: record.changedAt, changedBy: record.changedBy };
}

function reportTelegramOf(value: unknown): ReportTelegramChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.chat === null) {
    if (typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
    return { chat: null, changedAt: record.changedAt, changedBy: record.changedBy };
  }
  if (typeof record.chat !== "string" || !record.chat.trim() || typeof record.name !== "string" || !record.name.trim()) return null;
  if (typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
  return { chat: record.chat, name: record.name, ...(typeof record.topicId === "number" && Number.isSafeInteger(record.topicId) && record.topicId > 0 ? { topicId: record.topicId } : {}), changedAt: record.changedAt, changedBy: record.changedBy };
}

/** A malformed setting reads as its default; the entry's other setting keeps its value. */
function entryOf(value: unknown): ProjectSettingsEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry: ProjectSettingsEntry = {};
  const cursor = (value as Record<string, unknown>).cloudStageAccountCursor;
  if (typeof cursor === "string" && cursor.length > 0 && cursor.length <= 100) entry.cloudStageAccountCursor = cursor;
  const runtime = (value as Record<string, unknown>).pipelineStageRuntime;
  if (validPipelineStageRuntime(runtime)) entry.pipelineStageRuntime = runtime;
  const cloud = (value as Record<string, unknown>).codexCloudEnvironmentId;
  if (validCodexCloudEnvironmentId(cloud)) entry.codexCloudEnvironmentId = cloud.trim();
  const memory = (value as Record<string, unknown>).agentMemoryMaxBytes;
  if (validAgentMemoryMax(memory) && memory !== undefined) entry.agentMemoryMaxBytes = memory;
  for (const name of Object.keys(DEFAULTS) as ProjectSwitchName[]) {
    const stored = switchOf((value as Record<string, unknown>)[name]);
    if (stored) entry[name] = stored;
  }
  const telegram = reportTelegramOf((value as Record<string, unknown>).reportTelegram);
  if (telegram) entry.reportTelegram = telegram;
  return entry;
}

function decodeProjects(raw: string | null): Record<string, ProjectSettingsEntry> {
  let projects: Record<string, ProjectSettingsEntry> = Object.create(null);
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<ProjectSettingsFile>;
    if (parsed.schemaVersion === 1 && parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)) {
      /* A malformed entry reads as off for its project only; the others keep theirs. */
      for (const [project, value] of Object.entries(parsed.projects)) {
        const entry = entryOf(value);
        if (entry) projects[project] = entry;
      }
    }
  } catch {
    projects = Object.create(null);
  }
  return projects;
}

function readProjects(): Record<string, ProjectSettingsEntry> {
  return cache.read(settingsFile());
}

function switchSetting(project: string, name: ProjectSwitchName): ProjectSwitchSetting {
  const projects = readProjects();
  const key = project.trim();
  const stored = projects[canonicalProject(key)]?.[name] ?? projects[key]?.[name];
  return stored ? { ...stored } : { enabled: DEFAULTS[name], changedAt: null, changedBy: null };
}

/** The setting as stored for this project, off when absent. */
export function mergeOnReviewSetting(project: string): MergeOnReviewSetting {
  return switchSetting(project, "mergeOnReview");
}

export function mergeOnReviewEnabled(project: string): boolean {
  return mergeOnReviewSetting(project).enabled;
}

/** Whether the project's bridge reports are on (#2146), on when absent. */
export function bridgeReportsSetting(project: string): BridgeReportsSetting {
  return switchSetting(project, "bridgeReports");
}

export function bridgeReportsEnabled(project: string): boolean {
  return bridgeReportsSetting(project).enabled;
}

/** Legacy manual override. The canonical choice (including an explicit clear)
 * wins, followed by predecessor keys in lexical order. Every alias agrees. */
export function codexCloudEnvironmentId(project: string): string {
  const projects = readProjects();
  const [current, ...predecessors] = projectAliasKeys(project.trim());
  for (const key of [current!, ...predecessors.sort()]) {
    const value = projects[key]?.codexCloudEnvironmentId;
    if (value !== undefined) return value;
  }
  return "";
}

export function validPipelineStageRuntime(value: unknown): value is "local" | "codex-cloud" {
  return value === "local" || value === "codex-cloud";
}

export function pipelineStageRuntime(project: string): "local" | "codex-cloud" {
  const projects = readProjects(), key = project.trim();
  return projects[canonicalProject(key)]?.pipelineStageRuntime ?? projects[key]?.pipelineStageRuntime ?? "local";
}

export function setPipelineStageRuntime(project: string, runtime: "local" | "codex-cloud"): boolean {
  if (!validPipelineStageRuntime(runtime)) return false;
  return underFileLock(() => {
    const key = canonicalProject(project.trim());
    if (!key) return false;
    const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
    projects[key] = { ...projects[key], pipelineStageRuntime: runtime };
    return writeProjects(projects);
  }, false);
}

/** A durable reservation spreads launches across the currently eligible pool.
 * Concurrent controllers share the settings lock; no history scan or cache. */
export async function reserveCloudStageAccount(project: string, eligible: readonly string[]): Promise<string | null> {
  const ids = [...new Set(eligible)].sort();
  if (!ids.length || ids.some(id => !id || id.length > 100)) return null;
  try { return await withFileTransaction(settingsFile(), "Cloud account reservation is busy", () => {
    cache.invalidate();
    const key = canonicalProject(project.trim());
    if (!key) return null;
    const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
    const prior = projects[key]?.cloudStageAccountCursor;
    const selected = ids[(ids.indexOf(prior ?? "") + 1) % ids.length]!;
    projects[key] = { ...projects[key], cloudStageAccountCursor: selected };
    return writeProjects(projects) ? selected : null;
  }); } catch (error) { if (error instanceof FileTransactionBusyError) return null; throw error; }
}

export function validCodexCloudEnvironmentId(value: unknown): value is string {
  return typeof value === "string" && (value.trim() === "" || /^[A-Za-z0-9][A-Za-z0-9_~-]{0,127}$/.test(value.trim()));
}

export function setCodexCloudEnvironmentId(project: string, value: string): boolean {
  if (!validCodexCloudEnvironmentId(value)) return false;
  return underFileLock(() => {
    const key = canonicalProject(project.trim());
    if (!key) return false;
    const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
    projects[key] = { ...projects[key], codexCloudEnvironmentId: value.trim() };
    return writeProjects(projects);
  }, false);
}

function writeProjects(projects: Record<string, ProjectSettingsEntry>): boolean {
  const file = settingsFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonDurably(file, { schemaVersion: 1, projects } satisfies ProjectSettingsFile);
    cache.invalidate();
    readProjects();
    return true;
  } catch {
    return false;
  }
}

/** Each read-modify-write holds the file's lock, which an install transfer
    holds while it writes the same file, so neither loses the other's entry. */
function underFileLock<T>(operation: () => T, refused: T): T {
  try { return withFileTransactionSync(settingsFile(), "project settings are busy", () => { cache.invalidate(); return operation(); }); }
  catch (error) { if (error instanceof FileTransactionBusyError) return refused; throw error; }
}

function setSwitch(name: ProjectSwitchName, project: string, enabled: boolean, changedBy: string, now: string): ProjectSwitchSetting | null {
  return underFileLock(() => setSwitchLocked(name, project, enabled, changedBy, now), null);
}

function setSwitchLocked(name: ProjectSwitchName, project: string, enabled: boolean, changedBy: string, now: string): ProjectSwitchSetting | null {
  const key = canonicalProject(project.trim());
  if (!key) return null;
  const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
  const current = projects[key]?.[name];
  if (current && current.enabled === enabled) return { ...current };
  projects[key] = { ...projects[key], [name]: { enabled, changedAt: now, changedBy } };
  return writeProjects(projects) ? { enabled, changedAt: now, changedBy } : null;
}

/**
 * Turn the setting on or off for one project, under its canonical key. A
 * write that changes nothing keeps the earlier `changedAt`, because that
 * instant decides which lanes the setting covers. Null on a failed write.
 */
export function setMergeOnReview(project: string, enabled: boolean, changedBy: string, now: string = new Date().toISOString()): MergeOnReviewSetting | null {
  return setSwitch("mergeOnReview", project, enabled, changedBy, now);
}

/** Turn the project's bridge reports on or off (#2146). Null on a failed write. */
export function setBridgeReports(project: string, enabled: boolean, changedBy: string, now: string = new Date().toISOString()): BridgeReportsSetting | null {
  return setSwitch("bridgeReports", project, enabled, changedBy, now);
}

/** What the operator chose for the project's reports: a chat, "Log only"
    (`chat: null`), or null when they never chose. */
export function reportTelegramChoice(project: string): ReportTelegramChoice | null {
  const projects = readProjects();
  const key = project.trim();
  const stored = projects[canonicalProject(key)]?.reportTelegram ?? projects[key]?.reportTelegram;
  return stored ? { ...stored } : null;
}

/** The chat the operator chose for the project's reports, null for none. */
export function reportTelegram(project: string): ReportTelegramSetting | null {
  const choice = reportTelegramChoice(project);
  return choice && choice.chat !== null ? choice : null;
}

/**
 * Where the project's reports go besides the bridge: the chat the operator
 * chose for it, and nothing else. "Log only" and a project that never chose
 * both answer null, however many chats the bot may post in: reports reach a
 * Telegram chat only from a project the operator marked for it.
 */
export function effectiveReportTelegram(project: string): EffectiveReportTelegram | null {
  const choice = reportTelegram(project);
  return choice ? { chat: choice.chat, name: choice.name, ...(choice.topicId ? { topicId: choice.topicId } : {}), source: "chosen" } : null;
}

/**
 * Set the project's Telegram report destination; null stores "Log only". The
 * caller has already checked the operator's authority and the chat against
 * the bot's allowlist; this only stores. False on a failed write.
 */
export function setReportTelegram(
  project: string,
  value: { chat: string; name: string; topicId?: number } | null,
  changedBy: string,
  now: string = new Date().toISOString(),
): ReportTelegramChoice | false {
  return underFileLock((): ReportTelegramChoice | false => {
  const key = canonicalProject(project.trim());
  if (!key) return false;
  const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
  const entry = { ...projects[key] };
  if (value) {
    entry.reportTelegram = { chat: value.chat.trim(), name: value.name.trim().slice(0, REPORT_NAME_MAX_CHARS), ...(value.topicId ? { topicId: value.topicId } : {}), changedAt: now, changedBy };
  } else {
    entry.reportTelegram = { chat: null, changedAt: now, changedBy };
  }
  projects[key] = entry;
  if (!writeProjects(projects)) return false;
  return { ...entry.reportTelegram };
  }, false);
}

/** The GitHub repository's name, capitalised, when the project has a GitHub
    remote: "Delegatus" for `<owner>/delegatus`. */
export function repositoryReportName(project: string): string | null {
  const repository = githubRepositoryOfRemote(recordedProjectRemote(canonicalProject(project.trim())));
  const name = repository?.split("/")[1]?.trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/**
 * The name a report header carries (docs/design/orchestrator-reports.md §5.6):
 * the name the operator set with the Telegram destination; else the GitHub
 * repository's name capitalised; else the project's display name. The last can
 * be a local folder name, which only the bridge log carries: the setup step
 * asks for a name whenever a chat is chosen, and only a chosen chat is posted
 * to. An internal key (`dir-<hash>`, `repo-<hash>`) is never a name: a project
 * with nothing readable is called "Unnamed project" in the operator's language.
 */
export function reportHeaderName(project: string, locale: Locale = "en"): string {
  const key = canonicalProject(project.trim());
  const set = reportTelegram(key)?.name?.trim();
  if (set && !isOpaqueProjectKey(set)) return set;
  const repository = repositoryReportName(key);
  if (repository) return repository;
  let displayName: string | undefined;
  try {
    displayName = projectAliasSnapshot().displayNames[key];
  } catch {
    displayName = undefined;
  }
  const name = projectDisplayName(key, displayName);
  return isOpaqueProjectKey(name) ? translate(locale, "dash.projectUnnamed") : name;
}

export function resetProjectSettingsForTests(): void {
  cache.invalidate();
}

/** Null inherits the installation cap. Writes use the canonical project key. */
export function projectAgentMemoryMax(project: string): number | null {
  const projects = readProjects();
  return (projects[canonicalProject(project.trim())] ?? projects[project.trim()])?.agentMemoryMaxBytes ?? null;
}

export function setProjectAgentMemoryMax(project: string, value: number | null): boolean {
  assertAgentMemoryMax(value);
  return underFileLock(() => {
    const key = canonicalProject(project.trim());
    if (!key) return false;
    const projects: Record<string, ProjectSettingsEntry> = Object.assign(Object.create(null), readProjects());
    projects[key] = { ...projects[key], agentMemoryMaxBytes: value };
    return writeProjects(projects);
  }, false);
}
