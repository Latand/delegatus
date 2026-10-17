import { launchAutonomousConversation, observeSpawnedTurn, type SpawnedTurnObservation } from "@/lib/agent/autonomousConversation";
import { repoDirForProject, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import type { ReportSpawnResult } from "@/lib/telegram/reportSpawn";
import { canonicalProject } from "@/lib/projects/aliases";
import { roleMemoryEnabled } from "../settings";
import { curatorBrief } from "./brief";
import { admissionHeld, hostAdmission, settle, type CurationAdmissionPorts } from "./admission";
import { claimPass, curationStatus, currentPass, machinePass, patchPass, readPass, passIsLive, type CuratorPass } from "./store";

const LAUNCH_GRACE_MS = 15 * 60_000;
const TURN_LIMIT_MS = 60 * 60_000;
export interface CurationController {
  reconcile(project: string): Promise<string | null>;
  launchIfDue(input: SeatTickCheckInput): Promise<string | null>;
}
export interface CurationPorts extends CurationAdmissionPorts {
  sources: SeatTickSources;
  launch?: (body: Record<string, unknown>, authorize: () => void) => Promise<ReportSpawnResult>;
  observe?: (pass: CuratorPass) => Promise<SpawnedTurnObservation>;
  launchTimeoutMs?: number;
}
async function launch(pass: CuratorPass, ports: CurationPorts): Promise<string | null> {
  const host = await hostAdmission(pass.project, ports);
  if (host.held !== null) return settle(pass, ports, `abandoned: ${host.held}`);
  const held = admissionHeld(pass.project, ports); if (held) return held;
  if (!pass.repoDir) return settle(pass, ports, "no-repository");
  if (!pass.launchBody) pass = patchPass(pass.id, { state: "launching", launchBody: { role: "curator", roleParams: {}, project: pass.project, cwd: pass.repoDir, prompt: curatorBrief(pass.project), title: "Role memory curation", clientAttemptId: pass.id, mcpServers: ["viewer"], notifyLauncher: false } })!;
  const fresh = readPass(pass.id);
  if (!fresh || !passIsLive(fresh)) return null;
  const heldAgain = admissionHeld(pass.project, ports); if (heldAgain) return heldAgain;
  if (!pass.launchedAt) pass = patchPass(pass.id, { launchedAt: new Date(ports.sources.now()).toISOString() })!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const authorize = () => {
    const ineligible = host.guard();
    if (ineligible) { settle(pass, ports, `abandoned: ${ineligible}`); throw Error(`curation admission held: ${ineligible}`); }
    if (admissionHeld(pass.project, ports)) throw Error("curation admission held");
    if (machinePass()?.id !== pass.id || !passIsLive(readPass(pass.id))) throw Error("curation pass ended");
  };
  const response = await Promise.race([
    (ports.launch ?? launchAutonomousConversation)(pass.launchBody!, authorize),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ports.launchTimeoutMs ?? LAUNCH_GRACE_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  const ineligibleAfterLaunch = host.guard();
  if (ineligibleAfterLaunch) return settle(pass, ports, `abandoned: ${ineligibleAfterLaunch}`);
  if (!passIsLive(readPass(pass.id))) return null;
  if (!response) return "curation: launch pending";
  if (response.body.code === "AUTO_UPDATE_DRAIN") {
    patchPass(pass.id, { launchedAt: null }); return "curation: held for the automatic update";
  }
  if (response.status < 200 || response.status >= 300) return settle(pass, ports, ["project_account_refused", "ENGINE_NOT_CONNECTED", "service_tier_unavailable"].includes(String(response.body.code)) ? "no-account" : "launch-refused");
  patchPass(pass.id, { state: response.body.state === "starting" ? "launching" : "running", launchId: typeof response.body.launchId === "string" ? response.body.launchId : null, conversationId: typeof response.body.conversationId === "string" ? response.body.conversationId : null, transcriptPath: typeof response.body.path === "string" ? response.body.path : null });
  return `curation: launched ${pass.id}`;
}
export async function reconcileCuration(project: string, ports: CurationPorts): Promise<string | null> {
  // Every sweep checks the incumbent's own host project before recovery.
  let pass = machinePass() ?? currentPass(project);
  if (!pass || !passIsLive(pass)) return null;
  const host = await hostAdmission(pass.project, ports);
  if (host.held !== null) return settle(pass, ports, `abandoned: ${host.held}`);
  if (pass.state === "claimed" || !pass.launchedAt) return launch(pass, ports);
  const observed = await (ports.observe ?? (p => observeSpawnedTurn(p, ports.sources, undefined, LAUNCH_GRACE_MS)))(pass);
  const ineligibleAfterObserve = host.guard();
  if (ineligibleAfterObserve) return settle(pass, ports, `abandoned: ${ineligibleAfterObserve}`);
  if (observed.conversationId) pass = patchPass(pass.id, { conversationId: observed.conversationId, launchId: observed.launchId ?? pass.launchId, transcriptPath: observed.path ?? pass.transcriptPath })!;
  if (observed.state === "failed") return settle(pass, ports, observed.failure?.kind ?? "launch-failed");
  if (observed.state === "ended") return settle(pass, ports, observed.turnError ? "turn-error" : null, observed.finalText);
  if (ports.sources.now() - Date.parse(pass.launchedAt ?? pass.claimedAt) >= TURN_LIMIT_MS) return settle(pass, ports, "timed-out");
  if (pass.state === "launching" && !pass.conversationId) return launch(pass, ports);
  return null;
}
export async function launchCurationIfDue(input: SeatTickCheckInput, ports: CurationPorts): Promise<string | null> {
  if (!roleMemoryEnabled()) return "curation: paused, memory off";
  if (!input.settings.enabled) return "curation: paused, wakes off";
  const eligible: { project: string; wakeAt: number }[] = [];
  let reason = "no designated seat", quietEligible = false;
  // Read every designated project's own delivery stamp before choosing a machine host.
  for (const project of [...new Set([...ports.sources.activeSeats(), input.project].map(canonicalProject))].sort()) {
    const host = await hostAdmission(project, ports);
    if (host.held !== null) { if (project === canonicalProject(input.project)) reason = host.held; continue; }
    const status = curationStatus(project, ports.sources.now());
    if (!status.active) continue;
    if (!status.due) { quietEligible = true; continue; }
    eligible.push({ project, wakeAt: host.wakeAt });
  }
  eligible.sort((a, b) => b.wakeAt - a.wakeAt || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  const project = eligible[0]?.project;
  if (!project) return quietEligible ? null : `curation: paused, no eligible project: ${reason}`;
  const held = admissionHeld(project, ports); if (held) return held;
  const seat = ports.sources.seatFor(project).active;
  const conversation = seat?.conversationId ? ports.sources.registry().conversation(seat.conversationId as `conversation_${string}`) : null;
  const repoDir = repoDirForProject(project, ports.sources) ?? conversation?.generations.at(-1)?.launchProfile.cwd ?? null;
  const pass = claimPass({ project, repoDir, now: ports.sources.now() });
  return pass ? launch(pass, ports) : null;
}
export function productionCurationController(sources: SeatTickSources, overrides: Omit<CurationPorts, "sources"> = {}): CurationController {
  const ports = { sources, ...overrides };
  return { reconcile: project => reconcileCuration(project, ports), launchIfDue: input => launchCurationIfDue(input, ports) };
}
