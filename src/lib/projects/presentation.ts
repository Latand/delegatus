import path from "node:path";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { cachedJsonFile } from "@/lib/state/cachedJsonFile";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { canonicalProject, projectAliasKeys, projectAliasResolver, projectAliasSnapshot } from "./aliases";

type Setting<T> = { value: T; changedAt: string; changedBy: string };
export interface ProjectPresentation {
  name?: Setting<string | null> & { folderName?: string };
  archived?: Setting<boolean>;
}
type Document = Record<string, ProjectPresentation>;

export function validProjectName(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80);
}

function decode(raw: string | null): Document {
  if (raw === null) {
    // The shared cache supplies null for a failed read as well as absence.
    // Only absence permits an empty writable document.
    try { fs.accessSync(file()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
      throw error;
    }
    throw new Error("Project presentation settings could not be read");
  }
  const parsed = JSON.parse(raw);
  if (parsed?.schemaVersion !== 1 || !parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) {
    throw new Error("Project presentation settings are unreadable");
  }
  const projects: Document = Object.create(null);
  for (const [key, value] of Object.entries(parsed.projects)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project presentation setting is unreadable");
    const entry = value as ProjectPresentation;
    for (const setting of [entry.name, entry.archived]) {
      if (setting && (typeof setting.changedAt !== "string" || typeof setting.changedBy !== "string")) throw new Error("Project presentation attribution is unreadable");
    }
    if (entry.name && (!validProjectName(entry.name.value) || (entry.name.folderName !== undefined && typeof entry.name.folderName !== "string"))) throw new Error("Project name is unreadable");
    if (entry.archived && typeof entry.archived.value !== "boolean") throw new Error("Project archive setting is unreadable");
    projects[key] = entry;
  }
  return projects;
}

const cache = cachedJsonFile(decode);
const file = () => statePath("project-presentation.json");

/** Presentation stays separate from the scanner's identity labels. Canonical
 * rows win per field, including explicit resets, after a key succession. */
export function projectPresentationSnapshot(): Document {
  const resolve = projectAliasResolver(projectAliasSnapshot());
  const stored = cache.read(file());
  const result: Document = Object.create(null);
  for (const [key, entry] of Object.entries(stored).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const target = resolve(key);
    if (target !== key) result[target] = { ...result[target], ...structuredClone(entry) };
  }
  for (const [key, entry] of Object.entries(stored)) {
    if (resolve(key) === key) result[key] = { ...result[key], ...structuredClone(entry) };
  }
  return result;
}

export function projectPresentation(project: string): ProjectPresentation {
  const stored = cache.read(file());
  const [canonical, ...ancestors] = projectAliasKeys(project);
  let result: ProjectPresentation = {};
  for (const key of [...ancestors.sort(), canonical!]) result = { ...result, ...stored[key] };
  return structuredClone(result);
}

export function presentationName(entry: ProjectPresentation | undefined, fallback: string, root?: string | null): string {
  if (!entry?.name) return fallback;
  return entry.name.value ?? (root ? path.basename(root.replace(/\\/g, "/")) : entry.name.folderName) ?? fallback;
}

export async function setProjectPresentation(
  project: string,
  patch: { name?: string | null; archived?: boolean; folderName?: string },
  changedBy: string,
  admit: () => void = () => {},
  now = new Date().toISOString(),
): Promise<void> {
  if ((patch.name !== undefined && !validProjectName(patch.name)) || (patch.archived !== undefined && typeof patch.archived !== "boolean")) throw new Error("Invalid project presentation setting");
  await withFileTransaction(file(), "Project presentation settings are busy", () => {
    admit();
    cache.invalidate();
    const key = canonicalProject(project.trim());
    if (!key) throw new Error("Project is required");
    const projects = cache.read(file());
    const entry = { ...projects[key] };
    if (patch.name !== undefined) entry.name = { value: typeof patch.name === "string" ? patch.name.trim() : null, changedAt: now, changedBy,
      ...(patch.name === null && patch.folderName ? { folderName: patch.folderName } : {}) };
    if (patch.archived !== undefined) entry.archived = { value: patch.archived, changedAt: now, changedBy };
    writeJsonDurably(file(), { schemaVersion: 1, projects: { ...projects, [key]: entry } });
    cache.invalidate();
  });
}
