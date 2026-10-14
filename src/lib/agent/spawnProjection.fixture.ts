import path from "node:path";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { statePath } from "@/lib/configDir";
import { FileRuntimeEventStore } from "@/lib/runtime/eventStore";
import type { FileEntry } from "@/lib/types";
import { AgentRegistry } from "./registry";
import { beginLegacySpawnFixture } from "./registryTestFixtures";
import { projectLaunchConversations } from "./spawnProjection";
import { livenessProbe } from "./accountLiveness";

/** A retained stage reservation whose host died before its first transcript. */
export function staleWorkingFixture(directory: string, now: number, stopped = false) {
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/repo", transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Dead launch", model: "gpt-6.1-sol" }) });
  if (begun.kind !== "created") throw new Error("fixture launch refused");
  const key = { engine: "codex" as const, sessionId: "dead-reservation" };
  registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: path.join(directory, "absent.jsonl"),
    cwd: "/repo", accountId: null, status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  const snapshot = registry.snapshot();
  const receipt = snapshot.receipts[begun.receipt.launchId]!;
  snapshot.conversations[receipt.conversationId]!.projectOwnership = { project: "atlas", source: "operator", setAt: receipt.createdAt, operationId: receipt.launchId };
  receipt.createdAt = new Date(now - 58 * 60 * 60_000).toISOString();
  receipt.state = "path-pending";
  receipt.artifactLifecycle = "pending";
  receipt.error = JSON.stringify({ phase: "unpublished", checks: 0, reason: "runtime host request timed out", ...(stopped ? { stopped: true } : {}) });
  const probe = livenessProbe({ now: () => now, pidAlive: () => false, processIdentity: () => null });
  const live: FileEntry = { path: "/repo/live.jsonl", root: "codex-sessions", name: "live.jsonl", project: "atlas",
    title: "Live agent", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: now / 1000 - 20,
    size: 100, activity: "live", proc: "running", pid: 4401, model: "gpt-6.1-sol", pendingQuestion: null, waitingInput: null,
    conversationId: "conversation_live", lastTurn: { startedAt: now - 60_000, endedAt: null },
    agentActivity: { lastRecordAt: now - 1000, checking: false, check: null } };
  return { snapshot, receipt, probe, live };
}


/** Server-generated response for both existing rendered-evidence drivers: a
    launch whose live host completed its turn, a launch whose host died over an
    open turn, and a live transcript. */
export function staleWorkingResponse(directory: string, now: number) {
  const registry = new AgentRegistry(path.join(directory, "agent-registry.sqlite"), undefined, undefined, { sqliteMode: "sqlite" });
  const events = new FileRuntimeEventStore(statePath("structured-host-events"));
  const launch = (title: string, sessionId: string, pid: number, status: "idle" | "live", activeTurnRef: string | null) => {
    const begun = registry.beginSpawnRequest({
      engine: "codex", cwd: "/repo", transport: "structured", accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", title, model: "gpt-6.1-sol" }),
    });
    if (begun.kind !== "created") throw new Error("fixture launch refused");
    registry.stageStructuredSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId }, artifactPath: path.join(directory, `${sessionId}.jsonl`), cwd: "/repo",
      accountId: "work", launchProfile: emptyLaunchProfile({ cwd: "/repo", title, model: "gpt-6.1-sol" }),
      status, host: null,
      structuredHost: {
        kind: "codex-app-server", endpoint: "fixture", process: { pid, startIdentity: `${pid}:1` },
        eventCursor: activeTurnRef ? 1 : 2, protocolVersion: "test", writerClaimEpoch: 0, activeTurnRef,
        pendingAttention: [], activeFlags: [],
      },
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    return begun.receipt.launchId;
  };
  /* Host ledgers live in the process's state directory, so each response
     names its own sessions. */
  const sessions = { quiet: `idle-completed-${path.basename(directory)}`, dead: `dead-mid-turn-${path.basename(directory)}` };
  const completedLaunch = launch("Completed launch", sessions.quiet, 4402, "idle", null);
  const deadLaunch = launch("Dead mid-turn", sessions.dead, 4403, "live", "turn-open");
  const snapshot = registry.snapshot();
  for (const launchId of [completedLaunch, deadLaunch]) {
    const receipt = snapshot.receipts[launchId]!;
    snapshot.conversations[receipt.conversationId]!.projectOwnership = {
      project: "atlas", source: "operator", setAt: receipt.createdAt, operationId: receipt.launchId,
    };
    receipt.createdAt = new Date(now - 30 * 60_000).toISOString();
    snapshot.entries[`${receipt.key!.engine}:${receipt.key!.sessionId}`]!.updatedAt = receipt.createdAt;
    receipt.error = "structured launch recovery: " + JSON.stringify({
      phase: "delivered", startedAt: now - 60_000, checks: 1, nextTryAt: now + 60_000, reason: "transcript pending",
    });
  }
  events.append(sessions.quiet, { kind: "turn-started", turnId: "turn-complete", seq: 1 });
  events.append(sessions.quiet, { kind: "turn-ended", turnId: "turn-complete", status: "completed", seq: 2 });
  events.append(sessions.dead, { kind: "turn-started", turnId: "turn-open", seq: 1 });
  // Only the completed launch's host is still running.
  const probe = livenessProbe({ now: () => now, pidAlive: (pid) => pid === 4402, processIdentity: (pid) => pid === 4402 ? "4402:1" : null });
  const live = staleWorkingFixture(directory, now).live;
  // Keep the quiet rows inside the board placement horizon so every row renders.
  const project = () => {
    const cards = projectLaunchConversations([], snapshot, now, () => false, undefined, probe).cards;
    const byLaunch = (launchId: string) => cards.find((card) => card.path === `spawn:${launchId}`)!;
    return { quiet: byLaunch(completedLaunch), dead: byLaunch(deadLaunch) };
  };
  const { quiet, dead } = project();
  const files = [quiet, dead, live];
  const at = new Date(now - 60_000).toISOString();
  const task = { id: "stale-working", project: "atlas", status: "done", placement: "unplaced", board: "shown",
    text: "Перевірити стан агентів", createdAt: at, updatedAt: at,
    assignments: files.map(file => ({ path: file.path, conversationId: file.conversationId, engine: file.engine,
      panePid: null, state: "delivered", error: null, at })) };
  return { quiet, dead, live, sessions, events, project, body: { files, tasks: [task], projectCatalog: [{ project: "atlas", conversations: 3, smt: now / 1000 }],
    workflows: [], flows: [], pipelines: [], systemHealth: { tmux: { status: "healthy" } } } };
}
