import path from "node:path";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
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


/** Server-generated response for both existing rendered-evidence drivers. */
export function staleWorkingResponse(directory: string, now: number) {
  const { snapshot, receipt, probe, live } = staleWorkingFixture(directory, now);
  // Keep the dead row inside the board placement horizon so both rows render.
  receipt.createdAt = new Date(now - 30 * 60_000).toISOString();
  const dead = projectLaunchConversations([], snapshot, now, () => false, undefined, probe).cards[0]!;
  const files = [dead, live];
  const at = new Date(now - 60_000).toISOString();
  const task = { id: "stale-working", project: "atlas", status: "done", placement: "unplaced", board: "shown",
    text: "Перевірити стан агентів", createdAt: at, updatedAt: at,
    assignments: files.map(file => ({ path: file.path, conversationId: file.conversationId, engine: file.engine,
      panePid: null, state: "delivered", error: null, at })) };
  return { dead, live, body: { files, tasks: [task], projectCatalog: [{ project: "atlas", conversations: 2, smt: now / 1000 }],
    workflows: [], flows: [], pipelines: [], systemHealth: { tmux: { status: "healthy" } } } };
}
