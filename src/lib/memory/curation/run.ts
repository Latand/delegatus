import { launchAutonomousConversation, observeSpawnedTurn, type SpawnedTurnObservation } from "@/lib/agent/autonomousConversation";
import { archiveConversationPaths } from "@/lib/board/archivePlacement";
import { applyBoardCommand } from "@/lib/board/command";
import { boardFor } from "@/lib/board/store";
import { repoDirForProject, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import { effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import { activeDrain } from "@/lib/selfUpdate/drain";
import type { ReportSpawnResult } from "@/lib/telegram/reportSpawn";
import { roleMemoryEnabled } from "../settings";
import { curatorBrief } from "./brief";
import { claimPass, currentPass, machinePass, patchPass, readPass, passIsLive, type CuratorPass } from "./store";

const LAUNCH_GRACE_MS = 15 * 60_000;
const TURN_LIMIT_MS = 60 * 60_000;
export interface CurationController {
  reconcile(project: string): Promise<string | null>;
  launchIfDue(input: SeatTickCheckInput): Promise<string | null>;
}
export interface CurationPorts {
  sources: SeatTickSources;
  launch?: (body: Record<string, unknown>) => Promise<ReportSpawnResult>;
  observe?: (pass: CuratorPass) => Promise<SpawnedTurnObservation>;
  archive?: (pass: CuratorPass) => void;
  launchTimeoutMs?: number;
}
function admissionHeld(project: string, ports: CurationPorts): string | null {
  if (!roleMemoryEnabled()) return "curation: paused, memory off";
  if (!effectiveSeatTickSettings(ports.sources.settings(project), ports.sources.now(), SEAT_TICK_WAKE_INTERVAL_MS).enabled) return "curation: paused, wakes off";
  if (activeDrain()) return "curation: held for the automatic update";
  const deployment = ports.sources.latestDeployment();
  if (deployment.state === "ok" && deployment.value && !deployment.value.terminal) return "curation: waits, a deployment is running";
  return null;
}
function archive(pass: CuratorPass, sources: SeatTickSources) {
  if (!pass.conversationId && !pass.transcriptPath) return;
  const snapshot = sources.registry().readOnlySnapshot();
  const conversation = pass.conversationId ? snapshot.conversations[pass.conversationId as `conversation_${string}`] : null;
  const paths = [...new Set([...(conversation?.generations.map(g => g.path) ?? []), ...(pass.transcriptPath ? [pass.transcriptPath] : []), ...(pass.launchId ? [`spawn:${pass.launchId}`] : [])])];
  if (paths.length) archiveConversationPaths(pass.project, "archive", paths, snapshot, { boardFor, applyBoardCommand: (input, record) => applyBoardCommand(input, { registrySnapshot: () => record }) });
}
function settle(pass: CuratorPass, ports: CurationPorts, failure: string | null, finalText?: string | null) {
  const current = readPass(pass.id);
  if (!current || !passIsLive(current)) return null;
  // Final state releases the machine claim even if archive placement is unavailable.
  const next = patchPass(pass.id, { state: failure ? "failed" : "succeeded", failure, endedAt: new Date(ports.sources.now()).toISOString(), ...(finalText ? { finalText } : {}) })!;
  try { (ports.archive ?? (p => archive(p, ports.sources)))(next); }
  catch { return `curation: settled ${pass.id}, ${next.counts.calls} calls, ${next.counts.changed} rules changed; archive placement pending`; }
  return `curation: ${failure ? `failed, ${failure}` : `settled ${pass.id}, ${next.counts.calls} calls, ${next.counts.changed} rules changed`}`;
}
async function launch(pass: CuratorPass, ports: CurationPorts): Promise<string | null> {
  const held = admissionHeld(pass.project, ports); if (held) return held;
  if (!pass.repoDir) return settle(pass, ports, "no-repository");
  if (!pass.launchBody) pass = patchPass(pass.id, { state: "launching", launchBody: { role: "curator", roleParams: {}, project: pass.project, cwd: pass.repoDir, prompt: curatorBrief(pass.project), title: "Role memory curation", clientAttemptId: pass.id, mcpServers: ["viewer"], notifyLauncher: false } })!;
  const fresh = readPass(pass.id);
  if (!fresh || !passIsLive(fresh)) return null;
  const heldAgain = admissionHeld(pass.project, ports); if (heldAgain) return heldAgain;
  if (!pass.launchedAt) pass = patchPass(pass.id, { launchedAt: new Date(ports.sources.now()).toISOString() })!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    (ports.launch ?? (body => launchAutonomousConversation(body, () => {
      if (admissionHeld(pass.project, ports)) throw Error("curation admission held");
      if (machinePass()?.id !== pass.id || !passIsLive(readPass(pass.id)!)) throw Error("curation pass ended");
    })))(pass.launchBody!),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ports.launchTimeoutMs ?? LAUNCH_GRACE_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!response) return "curation: launch pending";
  if (response.body.code === "AUTO_UPDATE_DRAIN") {
    patchPass(pass.id, { launchedAt: null }); return "curation: held for the automatic update";
  }
  if (response.status < 200 || response.status >= 300) return settle(pass, ports, ["project_account_refused", "ENGINE_NOT_CONNECTED", "service_tier_unavailable"].includes(String(response.body.code)) ? "no-account" : "launch-refused");
  patchPass(pass.id, { state: response.body.state === "starting" ? "launching" : "running", launchId: typeof response.body.launchId === "string" ? response.body.launchId : null, conversationId: typeof response.body.conversationId === "string" ? response.body.conversationId : null, transcriptPath: typeof response.body.path === "string" ? response.body.path : null });
  return `curation: launched ${pass.id}`;
}
export async function reconcileCuration(project: string, ports: CurationPorts): Promise<string | null> {
  // Any swept project can reconcile the machine's incumbent, even if its own seat went away.
  let pass = machinePass() ?? currentPass(project);
  if (!pass || !passIsLive(pass)) return null;
  if (pass.state === "claimed" || !pass.launchedAt) return launch(pass, ports);
  const observed = await (ports.observe ?? (p => observeSpawnedTurn(p, ports.sources, undefined, LAUNCH_GRACE_MS)))(pass);
  if (observed.conversationId) pass = patchPass(pass.id, { conversationId: observed.conversationId, launchId: observed.launchId ?? pass.launchId, transcriptPath: observed.path ?? pass.transcriptPath })!;
  if (observed.state === "failed") return settle(pass, ports, observed.failure?.kind ?? "launch-failed");
  if (observed.state === "ended") return settle(pass, ports, observed.turnError ? "turn-error" : null, observed.finalText);
  if (ports.sources.now() - Date.parse(pass.launchedAt ?? pass.claimedAt) >= TURN_LIMIT_MS) return settle(pass, ports, "timed-out");
  if (pass.state === "launching" && !pass.conversationId) return launch(pass, ports);
  return null;
}
export async function launchCurationIfDue(input: SeatTickCheckInput, ports: CurationPorts): Promise<string | null> {
  if (!roleMemoryEnabled() || !input.settings.enabled) return null;
  const held = admissionHeld(input.project, ports); if (held) return held;
  const conversation = input.seat ? ports.sources.registry().conversation(input.seat.conversationId as `conversation_${string}`) : null;
  const repoDir = repoDirForProject(input.project, ports.sources) ?? conversation?.generations.at(-1)?.launchProfile.cwd ?? null;
  const pass = claimPass({ project: input.project, repoDir, now: ports.sources.now() });
  return pass ? launch(pass, ports) : null;
}
export function productionCurationController(sources: SeatTickSources, overrides: Omit<CurationPorts, "sources"> = {}): CurationController {
  const ports = { sources, ...overrides };
  return { reconcile: project => reconcileCuration(project, ports), launchIfDue: input => launchCurationIfDue(input, ports) };
}
