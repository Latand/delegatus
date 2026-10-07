import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { writeJsonDurably } from "@/lib/state/durableJson";
import metadata from "../../../package.json";

/** The operator opted this repository in; every other project starts closed. */
const ownProject = projectIdentityFromRemote(metadata.repository.url.replace(/^git\+/, ""), "/")?.project;
function settings(): Record<string, boolean> {
  try { const value = JSON.parse(fs.readFileSync(statePath("shared-memory-settings.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("shape");
    if (Object.values(value).some(v => typeof v !== "boolean")) throw Error("shape");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
/** Whether a project is this repository, which starts with memory switched on. */
export function isOwnProject(project: string): boolean {
  return Boolean(ownProject) && canonicalProject(project) === canonicalProject(ownProject!);
}
export function sharedMemoryEnabled(project: string): boolean {
  try { return settings()[canonicalProject(project)] ?? isOwnProject(project); }
  catch { return false; }
}
export function setSharedMemoryEnabled(project: string, enabled: boolean) {
  writeJsonDurably(statePath("shared-memory-settings.json"), { ...settings(), [canonicalProject(project)]: enabled });
}
