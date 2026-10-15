import { createHash } from "node:crypto";
import { isOpaqueProjectKey } from "@/lib/displayNames";
import { reportHeaderName } from "@/lib/projects/settings";
import type { VoiceProject } from "./boardReads";

export const projectHandle = (project: string) => `p${createHash("sha256").update(project).digest("hex").slice(0, 8)}`;
export const voiceProjectName = (row: VoiceProject) => isOpaqueProjectKey(row.displayName) ? reportHeaderName(row.project) : row.displayName;
export function voiceProjectRows(projects: readonly VoiceProject[], current?: string | null, all = false) {
  const labels = new Map(projects.map(row => [row, voiceProjectName(row)]));
  const groups = new Map<string, VoiceProject[]>();
  for (const row of projects) {
    const name = labels.get(row)!.trim().toLowerCase();
    const group = groups.get(name) ?? []; group.push(row); groups.set(name, group);
  }
  return projects.filter(row => all || row.liveSeat).map(row => {
    const label = labels.get(row)!;
    const peers = groups.get(label.trim().toLowerCase())!;
    const suffix = peers.length > 1 ? !row.liveSeat ? "no orchestrator"
      : peers.filter(peer => peer.liveSeat).length > 1 ? row.folder || `orchestrator ${peers.indexOf(row) + 1}` : "" : "";
    return { name: `${label}${suffix ? ` (${suffix})` : ""}`, handle: projectHandle(row.project), inView: current === row.project,
      orchestrator: row.liveSeat, openTasks: row.openTaskCount };
  }).sort((a, b) => Number(b.inView) - Number(a.inView) || a.name.localeCompare(b.name));
}
