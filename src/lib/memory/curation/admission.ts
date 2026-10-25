import { defaultSeatTickAdmissionSources, type SeatTickAdmissionSources } from "@/lib/monitor/seatTickAdmissionSources";
import { archiveConversationPaths } from "@/lib/board/archivePlacement";
import { applyBoardCommand } from "@/lib/board/command";
import { boardFor } from "@/lib/board/store";
import { effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { SEAT_TICK_WAKE_INTERVAL_MS } from "@/lib/monitor/seatTick";
import { peekSeatTickState } from "@/lib/monitor/seatTickState";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { identityAlive, livenessProbe } from "@/lib/agent/accountLiveness";
import { entryOwners, ownerProcessAlive } from "@/lib/lifecycle/owners";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";
import { roleMemoryEnabled } from "../settings";
import { machinePassAuthority, patchPass, readPass, readPassAuthority, passIsLive, type CuratorPass } from "./store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { curatorCallerOf } from "./guard";
import { importBatchAccountingGap } from "../importCuration";
import { syncCurationOpen } from "../importSync";

/** Shared launch and recovery admission, also loaded by the scanner worker. */
export interface CurationAdmissionPorts {
  sources: SeatTickAdmissionSources;
  archive?: (pass: CuratorPass) => void;
}
/** In the engines position only an import pass of the synced import is admitted (memory-source-switch.md §4.9). */
export function admissionHeld(project: string, ports: CurationAdmissionPorts, pass?: Pick<CuratorPass, "importBatch"> | null): string | null {
  if (!roleMemoryEnabled() && !syncCurationOpen(pass?.importBatch?.importId)) return "curation: paused, memory off";
  const settings = effectiveSeatTickSettings(ports.sources.settings(project), ports.sources.now(), SEAT_TICK_WAKE_INTERVAL_MS);
  if (!settings.enabled) return "curation: paused, wakes off";
  if (settings.curation?.enabled === false) return "curation: paused, curator off";
  if (activeDrain()) return "curation: held for the automatic update";
  const deployment = ports.sources.latestDeployment();
  if (deployment.state === "ok" && deployment.value && !deployment.value.terminal) return "curation: waits, a deployment is running";
  return null;
}
function hostEvidence(project: string, ports: CurationAdmissionPorts) {
  const now = ports.sources.now();
  const settings = effectiveSeatTickSettings(ports.sources.settings(project), now, SEAT_TICK_WAKE_INTERVAL_MS);
  if (settings.curation?.enabled === false) return { held: "curator off" } as const;
  if (!settings.enabled) return { held: "seat wakes off" } as const;
  const seat = ports.sources.seatFor(project).active;
  if (!seat?.conversationId) return { held: "no designated seat" } as const;
  const conversation = ports.sources.registry().conversation(seat.conversationId as `conversation_${string}`);
  if (!conversation || conversation.supersededBy) return { held: "designated seat missing or retired" } as const;
  // The tick stamps this only on confirmed delivery and retains it across rotations.
  // Epoch and designation prevent a predecessor's delivery from admitting a successor.
  const tick = peekSeatTickState(project);
  const wakeAt = Date.parse(tick.lastWakeAt ?? "");
  if (tick.accounting?.gap || tick.seatEpoch !== seat.seatEpoch || !Number.isFinite(wakeAt)
    || seat.designatedAt && wakeAt < Date.parse(seat.designatedAt)
    || wakeAt > now || now - wakeAt > 2 * settings.wakeIntervalMs) return { held: "no delivered seat wake within two intervals" } as const;
  return { held: null, seat, wakeAt } as const;
}

/** Synchronous admission evidence for memory writers. Probe only this seat's
 * recorded processes; a setting or an unproven launch cannot host a curator. */
export function curationAvailable(project: string, sources = defaultSeatTickAdmissionSources()): boolean {
  const ports = { sources };
  if (admissionHeld(project, ports)) return false;
  const evidence = hostEvidence(project, ports);
  if (evidence.held !== null) return false;
  const snapshot = sources.registry().livenessConversationSnapshot(evidence.seat.conversationId!);
  const probe = livenessProbe();
  return Object.values(snapshot.entries).some(entry =>
    entryOwners(entry, probe).owners.some(owner => ownerProcessAlive(owner, probe)));
}

export async function hostAdmission(project: string, ports: CurationAdmissionPorts) {
  const evidence = hostEvidence(project, ports);
  if (evidence.held !== null) return evidence;
  const { seat } = evidence;
  const records = await ports.sources.liveness({ conversationId: seat.conversationId!, stallAfterMs: 30 * 60_000, limit: 1 }).catch(() => []);
  const record = records.find(row => row.conversationId === seat.conversationId);
  if (!record || record.host.state !== "alive" || record.lifecycle === "gone" || !record.host.pid) return { held: "designated seat host is not live" } as const;
  // Use the shared liveness probe again at synchronous spawn fences, including deferred work.
  const probe = livenessProbe();
  const identity = { pid: record.host.pid, startIdentity: probe.processIdentity(record.host.pid) };
  const guard = () => {
    const fresh = hostEvidence(project, ports);
    if (fresh.held !== null) return fresh.held;
    if (fresh.seat.conversationId !== seat.conversationId || fresh.seat.seatEpoch !== seat.seatEpoch) return "designated seat changed";
    return identityAlive(identity, probe) ? null : "designated seat host is not live";
  };
  const held = guard();
  return held ? { held } as const : { held: null, wakeAt: evidence.wakeAt, guard } as const;
}

/** Admission shared by ordinary message/resume recovery for curator conversations. */
export async function curatorRecoveryGuard(conversationId: string, sources = defaultSeatTickAdmissionSources()): Promise<() => void> {
  const snapshot = withViewerOperation("memory.curation-admission", () => sources.registry().curatorConversationSnapshot(conversationId));
  const pass = curatorCallerOf(conversationId, snapshot);
  const ports: CurationAdmissionPorts = { sources };
  const host = await hostAdmission(pass.project, ports);
  if (host.held !== null) {
    settle(pass, ports, `abandoned: ${host.held}`);
    throw new DeliveryAdmissionRefusedError(`curation pass abandoned: ${host.held}`);
  }
  const assert = () => {
    const current = readPassAuthority(pass.id);
    if (!current || !passIsLive(current) || machinePassAuthority()?.id !== pass.id || current.project !== pass.project) {
      throw new DeliveryAdmissionRefusedError("curation pass is no longer live on its admitted host");
    }
    const currentHostFailure = host.guard();
    if (currentHostFailure) {
      settle(current, ports, `abandoned: ${currentHostFailure}`);
      throw new DeliveryAdmissionRefusedError(`curation pass abandoned: ${currentHostFailure}`);
    }
    const held = admissionHeld(pass.project, ports, current);
    if (held) throw new DeliveryAdmissionRefusedError(held);
    curatorCallerOf(conversationId, withViewerOperation("memory.curation-admission", () => sources.registry().curatorConversationSnapshot(conversationId)));
  };
  assert();
  return assert;
}

function archive(pass: CuratorPass, sources: SeatTickAdmissionSources) {
  if (!pass.conversationId && !pass.transcriptPath) return;
  const snapshot = pass.conversationId ? sources.registry().curatorConversationSnapshot(pass.conversationId) : sources.registry().conversationDeliverySnapshot({ path: pass.transcriptPath ?? "" });
  const conversation = pass.conversationId ? snapshot.conversations[pass.conversationId as `conversation_${string}`] : null;
  const paths = [...new Set([...(conversation?.generations.map(g => g.path) ?? []), ...(pass.transcriptPath ? [pass.transcriptPath] : []), ...(pass.launchId ? [`spawn:${pass.launchId}`] : [])])];
  if (paths.length) archiveConversationPaths(pass.project, "archive", paths, snapshot, { boardFor, applyBoardCommand: (input, record) => applyBoardCommand(input, { registrySnapshot: () => record }) });
}
export function settle(pass: CuratorPass, ports: CurationAdmissionPorts, failure: string | null, finalText?: string | null) {
  const current = readPassAuthority(pass.id);
  if (!current || !passIsLive(current)) return current?.failure?.startsWith("abandoned:") ? `curation: failed, ${current.failure}` : null;
  const accountingGap = !failure ? importBatchAccountingGap(current) : null;
  const settledFailure = failure ?? (accountingGap ? `import-accounting: ${accountingGap}` : null);
  // Final state releases the machine claim even if archive placement is unavailable.
  const next = patchPass(pass.id, { state: settledFailure ? "failed" : "succeeded", failure: settledFailure, endedAt: new Date(ports.sources.now()).toISOString(), ...(finalText ? { finalText } : {}) })!;
  const counts = readPass(next.id)?.counts ?? next.counts;
  const detail = `curation: ${next.state === "failed" ? `failed, ${next.failure}` : `settled ${pass.id}, ${counts.calls} calls, ${counts.changed} rules changed`}`;
  try { (ports.archive ?? (p => archive(p, ports.sources)))(next); }
  catch { return `${detail}; archive placement pending`; }
  return detail;
}
