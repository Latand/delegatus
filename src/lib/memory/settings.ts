import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import metadata from "../../../package.json";
import { memorySource } from "./source";

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
/** Read and written under the file's lock, which an install transfer holds
    while it writes the same file, so neither loses the other's value. */
export function setSharedMemoryEnabled(project: string, enabled: boolean) {
  const file = statePath("shared-memory-settings.json");
  withFileTransactionSync(file, "shared memory settings are busy", () => writeJsonDurably(file, { ...settings(), [canonicalProject(project)]: enabled }));
}

/** The text-free role selector remains durable while the engines are selected,
    so a later Delegatus launch can resume with the current rules. */
export function roleMemorySelectorEnabled(): boolean {
  return process.env.LLV_ROLE_MEMORY?.trim().toLowerCase() !== "off";
}

/** Installation choice and the emergency override stop requests and delivery
    together. Existing stores and launch selectors are retained. */
export function roleMemoryEnabled(): boolean {
  return roleMemorySelectorEnabled() && memorySource().choice !== "engines";
}
