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
export function sharedMemoryEnabled(project: string): boolean {
  try { const key = canonicalProject(project); return settings()[key] ?? (Boolean(ownProject) && key === canonicalProject(ownProject!)); }
  catch { return false; }
}
export function setSharedMemoryEnabled(project: string, enabled: boolean) {
  writeJsonDurably(statePath("shared-memory-settings.json"), { ...settings(), [canonicalProject(project)]: enabled });
}

/** Role memory is always on (operator, 2026-10-07: no per-project switch). The
    one way to stop it, for safety, is the installation's own setting
    `LLV_ROLE_MEMORY=off`, which stops both the requests and the injection. */
export function roleMemoryEnabled(): boolean {
  return process.env.LLV_ROLE_MEMORY?.trim().toLowerCase() !== "off";
}
