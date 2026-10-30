import fs from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { effectiveSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { emptySeatTickState } from "@/lib/monitor/types";
import { writeSeatTickState } from "@/lib/monitor/seatTickState";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { productionCurationController } from "./run";
import { machinePassAuthority } from "./store";

export const CUSTODY_PROJECT = "scheduled-custody-fixture";
export const CUSTODY_NOW = Date.parse("2026-10-20T12:00:00Z");
/** Native registry writers produce both the seat and scheduled curator receipts.
 * Only the engine invocation and seat liveness provider are fixture ports. */
export function scheduledCustodyFixture(root: string, existing?: { seatId: string; now: number }) {
  const registry = new AgentRegistry(path.join(root, "custody-registry.json"));
  let now = existing?.now ?? CUSTODY_NOW;
  let enabled = true, curatorEnabled = true, deployment = false, seatAlive = true;
  const register = (sessionId: string, role: "orchestrator" | "curator", attempt: string, pending = false) => {
    const artifactPath = path.join(root, `${sessionId}.jsonl`);
    fs.writeFileSync(artifactPath, "");
    const conversation = registry.ensureConversation("codex", artifactPath, null);
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: root, accountId: null, role,
      clientAttemptId: attempt, explicitProject: CUSTODY_PROJECT, transport: "structured", conversationId: conversation.id,
      launchProfile: { cwd: root, project: CUSTODY_PROJECT, role: "worker", title: "Scheduled custody fixture" } });
    if (begun.kind !== "created") throw Error("fixture receipt was not created");
    if (pending) return { conversationId: conversation.id, launchId: begun.receipt.launchId, path: artifactPath };
    const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId }, artifactPath, cwd: root,
      accountId: null, launchProfile: begun.receipt.launchProfile, status: "idle", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    if (settled.kind !== "settled") throw Error("fixture receipt was not settled");
    return { conversationId: conversation.id, launchId: begun.receipt.launchId, path: artifactPath };
  };
  const seatId = existing?.seatId ?? register("scheduled-seat", "orchestrator", "scheduled-seat-attempt").conversationId;
  const seat = { conversationId: seatId, seatEpoch: 1, designatedAt: new Date(CUSTODY_NOW - 60_000).toISOString(), path: null };
  if (!existing) writeSeatTickState(CUSTODY_PROJECT, { ...emptySeatTickState(), seatEpoch: seat.seatEpoch, lastWakeAt: new Date(now).toISOString() });
  const base = defaultSeatTickSources();
  const sources = { ...base, now: () => now, registry: () => registry,
    settings: (project: string) => ({ ...base.settings(project), enabled, wakeIntervalMinutes: 10, curation: { ...base.settings(project).curation!, enabled: curatorEnabled, intervalHours: 1, updatedAt: new Date(CUSTODY_NOW).toISOString(), setBy: { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null } } }),
    seatFor: () => ({ active: seat, pending: null, history: [] }) as never,
    activeSeats: () => [CUSTODY_PROJECT], pipelines: () => [{ project: CUSTODY_PROJECT, repoDir: root }] as never,
    liveness: async () => [{ conversationId: seatId, host: { state: seatAlive ? "alive" : "gone", pid: seatAlive ? process.pid : null, kind: "structured" }, lifecycle: seatAlive ? "working" : "gone" } as AgentLivenessRecord],
    latestDeployment: () => ({ state: "ok" as const, value: deployment ? { terminal: false } as never : null }),
  };
  let launches = 0, pendingLaunch = false;
  const ports = { archive: () => {}, observe: async () => ({ state: "running" as const }),
    launch: async (body: Record<string, unknown>, authorize: () => void) => {
      authorize(); launches++;
      return { status: 202, body: { state: pendingLaunch ? "starting" : "running", ...register("scheduled-curator", "curator", String(body.clientAttemptId), pendingLaunch) } };
    } };
  const controller = productionCurationController(sources, ports);
  const start = async (pending = false) => {
    pendingLaunch = pending;
    const settings = effectiveSeatTickSettings(sources.settings(CUSTODY_PROJECT), now, 600_000);
    await controller.launchIfDue({ project: CUSTODY_PROJECT, now, settings } as never);
    const pass = machinePassAuthority();
    if (!pass?.conversationId) throw Error("scheduled fixture did not launch");
    return { pass, capability: registry.rotateSpawnCapabilityForReceipt(pass.launchId!) };
  };
  return { registry, sources, controller, ports, seat, start, seatId,
    get launches() { return launches; },
    setNow: (value: number) => { now = value; },
    policy: (value: { enabled?: boolean; curatorEnabled?: boolean; deployment?: boolean; seatAlive?: boolean }) => {
      enabled = value.enabled ?? enabled; curatorEnabled = value.curatorEnabled ?? curatorEnabled;
      deployment = value.deployment ?? deployment; seatAlive = value.seatAlive ?? seatAlive;
    } };
}
