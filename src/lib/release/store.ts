import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { redactMonitorText } from "@/lib/monitor/redact";
import type { CreatePipelineRequest } from "@/lib/pipelines/types";
import type { ReleaseDecision, ReleaseOutcome } from "./policy";
import type { ReleaseSettingChange } from "./settings";
import type { SeatTickSettingsActor } from "@/lib/monitor/seatTickSettings";
export interface ReleaseRun {
  key: string; cut: string; lastTag: string; trigger: string; startedAt: number;
  requestedAt?: string | null;
  taskId: string | null; pipelineId: string | null; request: CreatePipelineRequest | null;
}
export interface ReleaseProject {
  live: ReleaseRun | null;
  history: (ReleaseRun & { outcome: ReleaseOutcome; at: number; reason?: string })[];
  request: { at: string; by: SeatTickSettingsActor; why: string | null; taskId?: string } | null;
  hold: { reason: string; at: string; by: SeatTickSettingsActor } | null;
  observation: (ReleaseDecision & { at: number; lastTag: string; nextEligibleAt: number }) | null;
  blocked: { kind: number; since: number; episode: string } | null;
}
const empty = (): ReleaseProject => ({ live: null, history: [], request: null, hold: null, observation: null, blocked: null });
function read(): Record<string, ReleaseProject> {
  try {
    const data = JSON.parse(fs.readFileSync(statePath("release-runs.json"), "utf8"));
    if (!data || data.version !== 1 || !data.projects || typeof data.projects !== "object") throw new Error("invalid release record");
    return data.projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export function readReleaseProject(project: string): ReleaseProject { return read()[project] ?? empty(); }
export function mutateReleaseProject(project: string, mutate: (row: ReleaseProject) => ReleaseProject): ReleaseProject {
  const file = statePath("release-runs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileTransactionSync(file, "release runs busy", () => {
    const projects = read(); const row = mutate(projects[project] ?? empty());
    const temporary = `${file}.${process.pid}.new`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, projects: { ...projects, [project]: row } }), { mode: 0o600 });
    fs.renameSync(temporary, file); return row;
  });
}
export function releaseControlChange(project: string, change: ReleaseSettingChange, actor: SeatTickSettingsActor, at: string): void {
  if (!change.requestNow && !Object.hasOwn(change, "hold")) return;
  mutateReleaseProject(project, row => ({ ...row,
    ...(change.requestNow ? { request: row.request ?? { at, by: actor, why: change.why ? redactMonitorText(change.why).slice(0, 500) : null, ...(change.taskId ? { taskId: change.taskId } : {}) } } : {}),
    ...(Object.hasOwn(change, "hold") ? { hold: change.hold ? { reason: redactMonitorText(change.hold).slice(0, 500), by: actor, at } : null } : {}),
  }));
}
