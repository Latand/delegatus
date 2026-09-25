import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";

/*
 * Per-project settings (#2187 §4.1, docs/design/merge-policy-and-task-finishing.md).
 * One setting today: "merge when the review passes". Its own file, because the
 * other per-project stores each own something else (`project-curation.json`
 * crowns and manual projects, `seat-tick-settings.json` the monitor). Same
 * shape as `curation.ts`: an mtime-cached read and an atomic write.
 *
 * Keyed by the canonical project key and read through `canonicalProject`, so a
 * folder whose key moved (AGENTS.md, succession) keeps its setting. An absent
 * entry reads as off, and no project is seeded.
 */

export interface MergeOnReviewSetting {
  enabled: boolean;
  /** Server clock, ISO. Null for a project that never had the setting written. */
  changedAt: string | null;
  changedBy: string | null;
}

interface ProjectSettingsEntry {
  mergeOnReview?: { enabled: boolean; changedAt: string; changedBy: string };
}

interface ProjectSettingsFile {
  schemaVersion: 1;
  projects: Record<string, ProjectSettingsEntry>;
}

const OFF: MergeOnReviewSetting = { enabled: false, changedAt: null, changedBy: null };

type SettingsCache = { file: string; mtimeMs: number; size: number; projects: Record<string, ProjectSettingsEntry> };

let cache: SettingsCache | null = null;

function settingsFile(): string {
  return statePath("project-settings.json");
}

function entryOf(value: unknown): ProjectSettingsEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const merge = (value as Record<string, unknown>).mergeOnReview;
  if (merge === undefined) return {};
  if (!merge || typeof merge !== "object" || Array.isArray(merge)) return null;
  const record = merge as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.changedAt !== "string" || typeof record.changedBy !== "string") return null;
  return { mergeOnReview: { enabled: record.enabled, changedAt: record.changedAt, changedBy: record.changedBy } };
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

/** The setting as stored for this project, off when absent. */
export function mergeOnReviewSetting(project: string): MergeOnReviewSetting {
  const projects = readProjects();
  const key = project.trim();
  const stored = projects[canonicalProject(key)]?.mergeOnReview ?? projects[key]?.mergeOnReview;
  return stored ? { ...stored } : { ...OFF };
}

export function mergeOnReviewEnabled(project: string): boolean {
  return mergeOnReviewSetting(project).enabled;
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

/**
 * Turn the setting on or off for one project, under its canonical key. A
 * write that changes nothing keeps the earlier `changedAt`, because that
 * instant decides which lanes the setting covers. Null on a failed write.
 */
export function setMergeOnReview(project: string, enabled: boolean, changedBy: string, now: string = new Date().toISOString()): MergeOnReviewSetting | null {
  const key = canonicalProject(project.trim());
  if (!key) return null;
  const projects = { ...readProjects() };
  const current = projects[key]?.mergeOnReview;
  if (current && current.enabled === enabled) return { ...current };
  projects[key] = { ...projects[key], mergeOnReview: { enabled, changedAt: now, changedBy } };
  return writeProjects(projects) ? { enabled, changedAt: now, changedBy } : null;
}

export function resetProjectSettingsForTests(): void {
  cache = null;
}
