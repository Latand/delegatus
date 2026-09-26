import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { projectDisplayName } from "@/lib/displayNames";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { canonicalProject, projectAliasSnapshot, recordedProjectRemote } from "@/lib/projects/aliases";

/*
 * Per-project settings (#2187 §4.1, docs/design/merge-policy-and-task-finishing.md).
 * Two settings: "merge when the review passes", absent reading as off, and
 * "bridge reports" (#2146), absent reading as on. Their own file, because the
 * other per-project stores each own something else (`project-curation.json`
 * crowns and manual projects, `seat-tick-settings.json` the monitor). Same
 * shape as `curation.ts`: an mtime-cached read and an atomic write.
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
 * carry. Absent means bridge-only.
 */
export interface ReportTelegramSetting {
  /** The bot chat's alias. */
  chat: string;
  /** The project's name in report headers; never a local folder name. */
  name: string;
  changedAt: string;
  changedBy: string;
}

interface ProjectSettingsEntry {
  mergeOnReview?: StoredSwitch;
  /** #2146: whether the project's orchestrator files bridge reports and the
      voice relay delivers them. Absent reads as on. */
  bridgeReports?: StoredSwitch;
  reportTelegram?: ReportTelegramSetting;
}

type ProjectSwitchName = "mergeOnReview" | "bridgeReports";

export const REPORT_NAME_MAX_CHARS = 60;

interface ProjectSettingsFile {
  schemaVersion: 1;
  projects: Record<string, ProjectSettingsEntry>;
}

const DEFAULTS: Record<ProjectSwitchName, boolean> = { mergeOnReview: false, bridgeReports: true };

type SettingsCache = { file: string; mtimeMs: number; size: number; projects: Record<string, ProjectSettingsEntry> };

let cache: SettingsCache | null = null;

function settingsFile(): string {
  return statePath("project-settings.json");
}

function switchOf(value: unknown): StoredSwitch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
  return { enabled: record.enabled, changedAt: record.changedAt, changedBy: record.changedBy };
}

function reportTelegramOf(value: unknown): ReportTelegramSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.chat !== "string" || !record.chat.trim() || typeof record.name !== "string" || !record.name.trim()) return null;
  if (typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
  return { chat: record.chat, name: record.name, changedAt: record.changedAt, changedBy: record.changedBy };
}

/** A malformed setting reads as its default; the entry's other setting keeps its value. */
function entryOf(value: unknown): ProjectSettingsEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry: ProjectSettingsEntry = {};
  for (const name of Object.keys(DEFAULTS) as ProjectSwitchName[]) {
    const stored = switchOf((value as Record<string, unknown>)[name]);
    if (stored) entry[name] = stored;
  }
  const telegram = reportTelegramOf((value as Record<string, unknown>).reportTelegram);
  if (telegram) entry.reportTelegram = telegram;
  return entry;
}

function readProjects(): Record<string, ProjectSettingsEntry> {
  const file = settingsFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { file, mtimeMs: -1, size: -1, projects: {} };
    return cache.projects;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.projects;
  let projects: Record<string, ProjectSettingsEntry> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectSettingsFile>;
    if (parsed.schemaVersion === 1 && parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)) {
      /* A malformed entry reads as off for its project only; the others keep theirs. */
      for (const [project, value] of Object.entries(parsed.projects)) {
        const entry = entryOf(value);
        if (entry) projects[project] = entry;
      }
    }
  } catch {
    projects = {};
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, projects };
  return projects;
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

function writeProjects(projects: Record<string, ProjectSettingsEntry>): boolean {
  const file = settingsFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, projects } satisfies ProjectSettingsFile, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    cache = null;
    readProjects();
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The next toggle retries the write.
    }
    return false;
  }
}

function setSwitch(name: ProjectSwitchName, project: string, enabled: boolean, changedBy: string, now: string): ProjectSwitchSetting | null {
  const key = canonicalProject(project.trim());
  if (!key) return null;
  const projects = { ...readProjects() };
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

/** The project's Telegram report destination, or null for bridge-only. */
export function reportTelegram(project: string): ReportTelegramSetting | null {
  const projects = readProjects();
  const key = project.trim();
  const stored = projects[canonicalProject(key)]?.reportTelegram ?? projects[key]?.reportTelegram;
  return stored ? { ...stored } : null;
}

/**
 * Set or clear the project's Telegram report destination. The caller has
 * already checked the operator's authority and the chat against the bot's
 * allowlist; this only stores. Null on a failed write.
 */
export function setReportTelegram(
  project: string,
  value: { chat: string; name: string } | null,
  changedBy: string,
  now: string = new Date().toISOString(),
): ReportTelegramSetting | null | false {
  const key = canonicalProject(project.trim());
  if (!key) return false;
  const projects = { ...readProjects() };
  const entry = { ...projects[key] };
  if (value) {
    entry.reportTelegram = { chat: value.chat.trim(), name: value.name.trim().slice(0, REPORT_NAME_MAX_CHARS), changedAt: now, changedBy };
  } else {
    delete entry.reportTelegram;
  }
  projects[key] = entry;
  if (!writeProjects(projects)) return false;
  return entry.reportTelegram ? { ...entry.reportTelegram } : null;
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
 * be a local folder name, which is acceptable only because a project without a
 * Telegram destination posts nowhere but the bridge.
 */
export function reportHeaderName(project: string): string {
  const key = canonicalProject(project.trim());
  const set = reportTelegram(key)?.name?.trim();
  if (set) return set;
  const repository = repositoryReportName(key);
  if (repository) return repository;
  let displayName: string | undefined;
  try {
    displayName = projectAliasSnapshot().displayNames[key];
  } catch {
    displayName = undefined;
  }
  return projectDisplayName(key, displayName);
}

export function resetProjectSettingsForTests(): void {
  cache = null;
}
