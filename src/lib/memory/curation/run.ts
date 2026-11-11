import { engineReadiness, type EngineName } from "@/lib/accounts/engineConnection";
import { defaultModelFor } from "@/lib/agent/models";
import { loadRoleDefinitions } from "@/lib/roles/store";
import type { RoleConfig } from "@/lib/roles/types";
import { launchAutonomousConversation, observeSpawnedTurn, type SpawnedTurnObservation } from "@/lib/agent/autonomousConversation";
import { repoDirForProject, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { SeatTickCheckInput } from "@/lib/monitor/types";
import type { ReportSpawnResult } from "@/lib/telegram/reportSpawn";
import { effectiveCurationSetting } from "@/lib/monitor/seatTickSettings";
import { canonicalProject } from "@/lib/projects/aliases";
import { roleMemoryEnabled } from "../settings";
import { curatableImportId } from "../importSync";
import { selectImportBatch } from "../importCuration";
import { withSystemRunTask } from "@/lib/tasks/systemRun";
import { curatorBrief } from "./brief";
import { admissionHeld, hostAdmission, settle, curationTimedOut, type CurationAdmissionPorts } from "./admission";
import { claimPass, curationStatusCooperatively, currentPassAuthority, machinePassAuthority, patchPass, readPassAuthority, passIsLive, type CuratorPass } from "./store";
import { outsideSeatTickWork } from "@/lib/monitor/seatTickWork";

const LAUNCH_GRACE_MS = 15 * 60_000;
export interface CurationController {
  reconcile(project: string, sweepIsCurrent?: () => boolean): Promise<string | null>;
  launchIfDue(input: SeatTickCheckInput): Promise<string | null>;
  /** Internal sweep coordination; production controllers add these methods. */
  finishProject?(project: string): void;
  fresh?(project: string): CurationController;
}
export interface CurationPorts extends CurationAdmissionPorts {
  sources: SeatTickSources;
  engineReadiness?: typeof engineReadiness;
  launch?: (body: Record<string, unknown>, authorize: () => void) => Promise<ReportSpawnResult>;
  observe?: (pass: CuratorPass) => Promise<SpawnedTurnObservation>;
  launchTimeoutMs?: number;
}

/** One ephemeral owner per seat sweep. It waits for every project's refreshed
 * wake state before making one machine-wide choice. A new sweep reads all
 * authority again; shared recovery and launch outlive individual project
 * checks and retain admission and release-generation fences. */
export function curationForSweep(controller: CurationController, projects: readonly string[] = [], sweepIsCurrent: () => boolean = () => true): CurationController {
  let reconcile: Promise<string | null> | undefined;
  const expected = new Set(projects);
  const ready = new Set<string>();
  const inputs: SeatTickCheckInput[] = [];
  let resolveReady!: () => void;
  const allReady = new Promise<void>(resolve => { resolveReady = resolve; });
  const markReady = (project: string) => {
    if (!expected.has(project)) return;
    ready.add(project);
    if (ready.size === expected.size) resolveReady();
  };
  let launch: Promise<string | null> | undefined;
  return {
    reconcile: project => reconcile ??= outsideSeatTickWork(() =>
      sweepIsCurrent() ? controller.reconcile(project, sweepIsCurrent) : Promise.resolve(null)),
    finishProject: markReady,
    fresh: project => curationForSweep(controller, [project], sweepIsCurrent),
    // Each check publishes its fully updated wake state before the single
    // machine-wide scan. A failed check releases its place in the barrier from
    // finishProject, so it cannot strand the other projects.
    launchIfDue: input => {
      if (expected.size) {
        inputs.push(input);
        markReady(input.project);
        return launch ??= allReady.then(() => {
          const eligible = inputs.find(candidate => candidate.settings.enabled);
          return eligible ? outsideSeatTickWork(() => controller.launchIfDue({ ...eligible, sweepIsCurrent })) : "curation: paused, wakes off";
        });
      }
      if (!input.settings.enabled) return Promise.resolve("curation: paused, wakes off");
      return launch ??= controller.launchIfDue(input);
    },
  };
}
async function launch(pass: CuratorPass, ports: CurationPorts, sweepIsCurrent: () => boolean = () => true): Promise<string | null> {
  if (!sweepIsCurrent()) return null;
  const host = await hostAdmission(pass.project, ports, pass);
  if (!sweepIsCurrent()) return null;
  if (host.held !== null) return settle(pass, ports, `abandoned: ${host.held}`);
  const held = admissionHeld(pass.project, ports, pass); if (held) return held;
  if (!pass.repoDir) return settle(pass, ports, "no-repository");
  if (!pass.launchBody) {
    const readiness = ports.engineReadiness ?? engineReadiness;
    const connected = (["claude", "codex"] as const).filter(engine => readiness(engine, pass.project) === "connected");
    const engine: EngineName | undefined = connected.length === 1 ? connected[0] : undefined;
    const runtime: Partial<RoleConfig> = engine && loadRoleDefinitions().find(role => role.id === "curator")?.config.engine !== engine
      ? { engine, model: defaultModelFor(engine), effort: "high" } : {};
    // Freeze the fallback with the attempt so recovery keeps its launch identity.
    pass = patchPass(pass.id, { state: "launching", admittedHost: host.custody, launchBody: {
      role: "curator", roleParams: {}, ...runtime, prompt: curatorBrief(pass.project),
      project: pass.project, cwd: pass.repoDir, title: "Role memory curation", clientAttemptId: pass.id,
      mcpServers: ["viewer"], notifyLauncher: false,
    } })!;
  }
  const fresh = readPassAuthority(pass.id);
  if (!fresh || !passIsLive(fresh)) return null;
  const launchBody = await withSystemRunTask(pass.launchBody!, new Date(ports.sources.now()).toISOString());
  if (!sweepIsCurrent()) return null;
  const heldAgain = admissionHeld(pass.project, ports, pass); if (heldAgain) return heldAgain;
  if (!pass.launchedAt) pass = patchPass(pass.id, { launchedAt: new Date(ports.sources.now()).toISOString() })!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const authorize = () => {
    if (!sweepIsCurrent()) throw Error("curation sweep ended");
    const ineligible = host.guard();
    if (ineligible) { settle(pass, ports, `abandoned: ${ineligible}`); throw Error(`curation admission held: ${ineligible}`); }
    if (admissionHeld(pass.project, ports, pass)) throw Error("curation admission held");
    if (machinePassAuthority()?.id !== pass.id || !passIsLive(readPassAuthority(pass.id))) throw Error("curation pass ended");
  };
  const response = await Promise.race([
    (ports.launch ?? launchAutonomousConversation)(launchBody, authorize),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ports.launchTimeoutMs ?? LAUNCH_GRACE_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!sweepIsCurrent()) return null;
  const ineligibleAfterLaunch = host.guard();
  if (ineligibleAfterLaunch) return settle(pass, ports, `abandoned: ${ineligibleAfterLaunch}`);
  if (!passIsLive(readPassAuthority(pass.id))) return null;
  if (!response) return "curation: launch pending";
  if (response.body.code === "AUTO_UPDATE_DRAIN") {
    patchPass(pass.id, { launchedAt: null }); return "curation: held for the automatic update";
  }
  if (response.status < 200 || response.status >= 300) return settle(pass, ports, ["project_account_refused", "ENGINE_NOT_CONNECTED", "service_tier_unavailable"].includes(String(response.body.code)) ? "no-account" : "launch-refused");
  patchPass(pass.id, { state: response.body.state === "starting" ? "launching" : "running", launchId: typeof response.body.launchId === "string" ? response.body.launchId : null, conversationId: typeof response.body.conversationId === "string" ? response.body.conversationId : null, transcriptPath: typeof response.body.path === "string" ? response.body.path : null });
  return `curation: launched ${pass.id}`;
}
export async function reconcileCuration(project: string, ports: CurationPorts, sweepIsCurrent: () => boolean = () => true): Promise<string | null> {
  if (!sweepIsCurrent()) return null;
  // Every sweep checks the incumbent's own host project before recovery.
  let pass = machinePassAuthority() ?? currentPassAuthority(project);
  if (!pass || !passIsLive(pass)) return null;
  const host = await hostAdmission(pass.project, ports, pass);
  if (!sweepIsCurrent()) return null;
  if (host.held !== null) return settle(pass, ports, `abandoned: ${host.held}`);
  if (pass.state === "claimed" || !pass.launchedAt) return launch(pass, ports, sweepIsCurrent);
  const observed = await (ports.observe ?? (p => observeSpawnedTurn(p, ports.sources, undefined, LAUNCH_GRACE_MS)))(pass);
  if (!sweepIsCurrent()) return null;
  const ineligibleAfterObserve = host.guard();
  if (ineligibleAfterObserve) return settle(pass, ports, `abandoned: ${ineligibleAfterObserve}`);
  if (observed.conversationId) pass = patchPass(pass.id, { conversationId: observed.conversationId, launchId: observed.launchId ?? pass.launchId, transcriptPath: observed.path ?? pass.transcriptPath })!;
  if (observed.state === "failed") return settle(pass, ports, observed.failure?.kind ?? "launch-failed");
  if (observed.state === "ended") return settle(pass, ports, observed.turnError ? "turn-error" : null, observed.finalText);
  if (curationTimedOut(pass, ports.sources.now())) return settle(pass, ports, "timed-out");
  if (pass.state === "launching" && !pass.conversationId) return launch(pass, ports, sweepIsCurrent);
  return null;
}
export async function launchCurationIfDue(input: SeatTickCheckInput, ports: CurationPorts): Promise<string | null> {
  const sweepIsCurrent = input.sweepIsCurrent ?? (() => true);
  if (!sweepIsCurrent()) return null;
  // The engines position admits import passes of the synced import only (§4.9).
  const importOnly = !roleMemoryEnabled();
  if (importOnly && !curatableImportId()) return "curation: paused, memory off";
  if (!input.settings.enabled) return "curation: paused, wakes off";
  const eligible: { project: string; wakeAt: number; batch: ReturnType<typeof selectImportBatch> }[] = [];
  let reason = "no designated seat", quietEligible = false, nothingToImport = false;
  // Read every designated project's own delivery stamp before choosing a machine host.
  for (const project of [...new Set([...ports.sources.activeSeats(), input.project].map(canonicalProject))].sort()) {
    if (!sweepIsCurrent()) return null;
    const host = await hostAdmission(project, ports);
    if (!sweepIsCurrent()) return null;
    if (host.held !== null) { if (project === canonicalProject(input.project)) reason = host.held; continue; }
    const status = await curationStatusCooperatively(project, ports.sources.now(), effectiveCurationSetting(ports.sources.settings(project)));
    if (!sweepIsCurrent()) return null;
    if (!status.active) continue;
    // The engines position hosts only a project with a pending import batch, so a
    // project due for ordinary curation never stands in front of one (§4.9).
    const batch = importOnly ? selectImportBatch(project) : null;
    if (importOnly && !batch) { nothingToImport = true; continue; }
    if (!status.due) { quietEligible = true; continue; }
    eligible.push({ project, wakeAt: host.wakeAt, batch });
  }
  eligible.sort((a, b) => b.wakeAt - a.wakeAt || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  const project = eligible[0]?.project, batch = eligible[0]?.batch ?? null;
  if (!project) return quietEligible ? null : nothingToImport ? "curation: paused, memory off" : `curation: paused, no eligible project: ${reason}`;
  const held = admissionHeld(project, ports, batch ? { importBatch: batch } : null); if (held) return held;
  if (!sweepIsCurrent()) return null;
  const seat = ports.sources.seatFor(project).active;
  const conversation = seat?.conversationId ? ports.sources.registry().conversation(seat.conversationId as `conversation_${string}`) : null;
  const repoDir = repoDirForProject(project, ports.sources) ?? conversation?.generations.at(-1)?.launchProfile.cwd ?? null;
  const pass = claimPass({ project, repoDir, now: ports.sources.now(), setting: effectiveCurationSetting(ports.sources.settings(project)), importOnly });
  return pass ? launch(pass, ports, sweepIsCurrent) : null;
}
export function productionCurationController(sources: SeatTickSources, overrides: Omit<CurationPorts, "sources"> = {}): CurationController {
  const ports = { sources, ...overrides };
  return { reconcile: (project, sweepIsCurrent) => reconcileCuration(project, ports, sweepIsCurrent), launchIfDue: input => launchCurationIfDue(input, ports) };
}
