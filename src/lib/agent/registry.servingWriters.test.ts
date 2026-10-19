import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { listCodexAccounts, codexSessionRoots } from "@/lib/accounts/codex";
import { loadTasks } from "@/lib/tasks/store";
import { createManagedClaudeAccount, activeClaudeAccountId, listClaudeAccounts } from "@/lib/accounts/claude";
import { selectAccount } from "@/lib/accounts/manager";
import { successorCapability } from "@/lib/accounts/migration/provider";
import { admitTranscriptConversationOffLoop } from "@/lib/conversation/transcriptAdmission";
import { newRound, reserveReviewerSpawnOffLoop } from "@/lib/flows/engine";
import type { Flow } from "@/lib/flows/types";
import { productionDeputyCommandPorts } from "@/lib/orchestrator/deputyCommandPorts";
import type { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import type { HostState } from "@/lib/runtime/engineHost";
import { bindCodexHostPersistence, demoteSkippedStructuredRegistryHosts, reconcileDeadStructuredRegistryHostOffLoop, reconcileDeadStructuredRegistryHostsOffLoop } from "@/lib/runtime/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { handOverHostForDemotion } from "@/lib/runtime/structuredDeliveryController";
import { interruptionObligationDirectory, interruptionObligationStore } from "@/lib/runtime/interruptionObligations";
import { writeStagedRecovery } from "@/lib/runtime/structuredSpawn";
import type { FileEntry } from "@/lib/types";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";

import { AgentRegistry, setAgentRegistryForTests } from "./registry";
import { registryLockHolder } from "./registryLockHolderFixture";
import { runIdentityWaveMigrationAtStartupOffLoop } from "./identityWaveStartup";
import { resolveSpawnLineageOffLoop } from "./spawnParent";
import { recordActualSpawnAccountOffLoop } from "./spawnCommand";
import { beginRegistryResumeOffLoop, reconcileObservedTranscriptHostsOffLoop } from "./transcriptHost";

const AT = "2026-10-19T00:00:00.000Z";
const SESSION = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const KEY = { engine: "codex" as const, sessionId: SESSION };
const roots: string[] = [];
afterEach(() => {
  setAgentRegistryForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(shared = false) {
  // Serving commands have already resolved their account and board catalogs.
  // Initialize those prerequisites in this private installation, before timing
  // the registry wait and its recovery; no measured registry operation is warmed.
  listClaudeAccounts(); listCodexAccounts(); loadTasks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-serving-"));
  roots.push(root);
  const sqliteFilename = shared ? path.join(process.env.LLV_STATE_DIR!, "state.sqlite") : path.join(root, "registry.sqlite");
  const registry = new AgentRegistry(path.join(root, "registry.json"), () => false, undefined, { sqliteMode: "sqlite", sqliteFilename });
  setAgentRegistryForTests(registry);
  const artifactPath = `/sessions/${SESSION}.jsonl`;
  const profile = emptyLaunchProfile({ cwd: "/repo", title: "Registry admission fixture" });
  const seed = () => registry.reconcileConversations([{
    engine: "codex", path: artifactPath, accountId: null, launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: AT,
  }]);
  return { root, registry, sqliteFilename, artifactPath, profile, seed };
}

/** The child releases independently, so a synchronous regression cannot deadlock
 * its own release timer. Include the timer after recovery in the measurement. */
async function held<T>(f: ReturnType<typeof fixture>, operation: () => Promise<T>, revoke?: () => void): Promise<T> {
  const holder = registryLockHolder(f.sqliteFilename);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setTimeout> | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined;
  resetBlockingWaitsForTests(() => {});
  try {
    await holder.hold(180);
    const start = performance.now();
    let previousTick = start;
    let maxGap = 0;
    pulse = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - previousTick);
      previousTick = now;
    }, 5);
    let finished = false;
    const progress = new Promise<{ elapsed: number; pending: boolean }>(resolve => {
      tick = setTimeout(() => resolve({ elapsed: performance.now() - start, pending: !finished }), 10);
    });
    if (revoke) timer = setTimeout(revoke, 5);
    const result = await operation().then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
    const sample = await progress;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    maxGap = Math.max(maxGap, performance.now() - previousTick);
    console.info(`[registry serving timer] first=${sample.elapsed.toFixed(2)} ms maxGap=${maxGap.toFixed(2)} ms`);
    expect(maxGap).toBeLessThan(50);
    if (!revoke) expect(sample.pending).toBe(true);
    expect(sample.elapsed).toBeLessThan(50);
    expect(blockingWaitDiagnostics().sites["registry-lock"]).toBeUndefined();
    expect(blockingWaitDiagnostics().sites["registry-revision-retry"]).toBeUndefined();
    if ("error" in result) throw result.error;
    return result.value;
  } finally {
    clearTimeout(timer); clearTimeout(tick); clearInterval(pulse);
    await holder.close();
  }
}

test("spawn lineage repeats transcript provenance after a child-held writer", async () => {
  const f = fixture();
  const transcript = path.join(codexSessionRoots()[0]!, `rollout-${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "{}\n");
  try {
    const lineage = await held(f, () => resolveSpawnLineageOffLoop({ parent: transcript }, f.registry));
    expect(lineage.parent?.artifactPath).toBe(transcript);
    const snapshot = f.registry.snapshot();
    const refused = await held(f, () => resolveSpawnLineageOffLoop({ parent: transcript }, f.registry), () => fs.unlinkSync(transcript));
    expect(refused.parent).toBeNull();
    expect(f.registry.snapshot()).toEqual(snapshot);
  } finally { fs.rmSync(transcript, { force: true }); f.registry.close(); }
});

test("transcript identity admission rereads foreign liveness after waiting", async () => {
  const f = fixture();
  const entry = { engine: "codex", path: f.artifactPath, cwd: "/repo", title: "Admission", proc: null } as FileEntry;
  let live = false;
  const dependencies = { readable: () => true, resolveAccount: () => null, liveOwnership: () => live ? "session" as const : null, now: () => AT };
  try {
    const result = await held(f, () => admitTranscriptConversationOffLoop(f.registry, entry, dependencies));
    expect(result.ok).toBe(true);
    const refused = await held(f, () => admitTranscriptConversationOffLoop(f.registry, entry, dependencies), () => { live = true; });
    expect(refused).toMatchObject({ ok: false, blocking: true });
  } finally { f.registry.close(); }
});

test("transcript observation and resume rerun their admitted guards", async () => {
  const f = fixture();
  f.seed();
  let current = true;
  const guard = () => { if (!current) throw new Error("observation replaced"); };
  try {
    await held(f, () => reconcileObservedTranscriptHostsOffLoop([], f.registry, guard));
    await expect(held(f, () => reconcileObservedTranscriptHostsOffLoop([], f.registry, guard), () => { current = false; })).rejects.toThrow("observation replaced");
    current = true;
    const entry = { engine: "codex", path: f.artifactPath } as FileEntry;
    const spec = { engine: "codex", cwd: "/repo", windowName: "Resume" } as Parameters<typeof beginRegistryResumeOffLoop>[1];
    const result = await held(f, () => beginRegistryResumeOffLoop(entry, spec, guard, f.registry));
    expect(result?.receipt.purpose).toBe("resume-successor");
    await expect(held(f, () => beginRegistryResumeOffLoop(entry, spec, guard, f.registry), () => { current = false; })).rejects.toThrow("observation replaced");
  } finally { f.registry.close(); }
});

test("deputy registration repeats seat authority inside admission", async () => {
  const f = fixture();
  let current = true;
  const ports = productionDeputyCommandPorts({ registry: f.registry });
  const register = () => Promise.resolve(ports.registerConversation({ artifactPath: `/sessions/${SESSION}.jsonl`, accountId: null,
    launchProfile: f.profile, assertCurrent: () => { if (!current) throw new Error("seat replaced"); } }));
  try {
    const id = await held(f, register);
    expect(f.registry.conversation(id as `conversation_${string}`)).not.toBeNull();
    await expect(held(f, register, () => { current = false; })).rejects.toThrow("seat replaced");
  } finally { f.registry.close(); }
});

for (const shared of [false, true]) test(`flow reservation rechecks its revision after registry and account admission (shared=${shared})`, async () => {
  const f = fixture(shared); f.seed();
  const owner = f.registry.conversationForPath(f.artifactPath)!;
  const flow = { id: shared ? "admitted-flow-shared" : "admitted-flow-isolated", project: "fixture", cwd: "/repo", implementerPath: f.artifactPath,
    implementerConversationId: owner.id, roles: { reviewer: { engine: "codex", model: null, effort: "high" } }, rounds: [] } as unknown as Flow;
  const round = newRound(flow, "button", null); round.reviewerBindingId = "fixed-reviewer-binding";
  let current = true;
  const reserve = () => reserveReviewerSpawnOffLoop(flow, round, flow.roles.reviewer, null, f.registry, () => current);
  try {
    expect((await held(f, reserve))?.kind).toBe("created");
    const revision = f.registry.storageDiagnostics().revision;
    expect(await held(f, reserve, () => { current = false; })).toBeNull();
    expect(f.registry.storageDiagnostics().revision).toBe(revision);
  } finally { f.registry.close(); }
});

for (const shared of [false, true]) test(`account selection keeps catalog and routing aligned through a child-held writer (shared=${shared})`, async () => {
  const f = fixture(shared);
  const account = createManagedClaudeAccount("Registry selection fixture");
  fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
  try {
    await held(f, () => selectAccount("claude", account.id, f.registry));
    expect(activeClaudeAccountId()).toBe(account.id);
    expect(f.registry.engineRouting("claude").activeAccountId).toBe(account.id);
    const before = f.registry.engineRouting("claude");
    await expect(held(f, () => selectAccount("claude", account.id, f.registry), () => {
      fs.unlinkSync(path.join(account.home, ".credentials.json"));
    })).rejects.toThrow();
    expect(f.registry.engineRouting("claude")).toEqual(before);
  } finally { f.registry.close(); }
});

for (const family of ["flow", "resume"] as const) for (const phase of ["reservation", "task", "recorded"] as const) {
  test(`${family} revocation after ${phase} admission durably retires its unactuated receipt`, async () => {
    const f = fixture(); f.seed();
    let revoked = false;
    const current = () => {
      const receipt = Object.values(f.registry.snapshot().receipts)[0];
      if (!receipt) return true;
      const taskAdmitted = loadTasks().some(task => task.assignments.some(row => row.launchId === receipt.launchId));
      if (phase === "reservation" || (phase === "task" && taskAdmitted) || (phase === "recorded" && receipt.membershipAdmitted === true)) revoked = true;
      return !revoked;
    };
    try {
      if (family === "resume") {
        const entry = { engine: "codex", path: f.artifactPath } as FileEntry;
        const spec = { engine: "codex", cwd: "/repo", windowName: "Resume" } as Parameters<typeof beginRegistryResumeOffLoop>[1];
        await expect(beginRegistryResumeOffLoop(entry, spec, () => {
          if (!current()) throw new Error("resume authority replaced");
        }, f.registry)).rejects.toThrow("resume authority replaced");
      } else {
        const flow = { id: `phase-${phase}`, project: "fixture", cwd: "/repo", implementerPath: f.artifactPath,
          implementerConversationId: f.registry.conversationForPath(f.artifactPath)!.id,
          roles: { reviewer: { engine: "codex", model: null, effort: "high" } }, rounds: [] } as unknown as Flow;
        const round = newRound(flow, "button", null); round.reviewerBindingId = "phase-reviewer-binding";
        expect(await reserveReviewerSpawnOffLoop(flow, round, flow.roles.reviewer, null, f.registry, current)).toBeNull();
        expect(round.launchId).toBeNull();
      }
      expect(revoked).toBe(true);
      const receipt = Object.values(f.registry.snapshot().receipts)[0]!;
      expect(receipt.state).toBe("failed");
      expect(receipt.admissionOwner).toBeNull();
      f.registry.close();
      const reopened = new AgentRegistry(path.join(f.root, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
      try { expect(reopened.spawnRecoverySnapshot([receipt.launchId]).receipts[receipt.launchId]?.state).toBe("failed"); }
      finally { reopened.close(); }
    } finally { f.registry.close(); }
  });
}

test("actual launch account reconciliation waits and rereads the materialized receipt", async () => {
  const f = fixture();
  const begun = f.registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", launchProfile: f.profile });
  const settled = f.registry.settleSpawn(begun.receipt.launchId, { key: KEY, artifactPath: f.artifactPath, cwd: "/repo", accountId: null,
    status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  if (settled.kind === "conflict") throw Error(settled.code);
  try {
    await held(f, () => recordActualSpawnAccountOffLoop(f.registry, settled.receipt, "default", f.artifactPath));
    expect(f.registry.conversationForPath(f.artifactPath)?.generations.at(-1)?.accountId).toBe("default");
    await held(f, () => recordActualSpawnAccountOffLoop(f.registry, settled.receipt, "other", "/sessions/unrelated.jsonl"));
    expect(f.registry.conversationForPath(f.artifactPath)?.generations.at(-1)?.accountId).toBe("default");
  } finally { f.registry.close(); }
});

test("successor capability staging and rollback each admit their operation", async () => {
  const f = fixture();
  const begun = f.registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", launchProfile: f.profile });
  f.registry.settleSpawn(begun.receipt.launchId, { key: KEY, artifactPath: f.artifactPath, cwd: "/repo", accountId: null,
    status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  const input = { registry: f.registry, conversationId: begun.receipt.conversationId, profile: f.profile,
    receipt: { operationId: "successor-operation", nativeId: SESSION, path: f.artifactPath }, target: {} } as Parameters<typeof successorCapability>[0];
  try {
    const capability = await held(f, () => successorCapability(input, "codex"));
    expect(capability.capability).not.toBeNull();
    await held(f, capability.restore);
    expect(f.registry.snapshot().receipts[begun.receipt.launchId]?.pendingSpawnCapability).toBeNull();
    await capability.restore();
  } finally { f.registry.close(); }
});

test("staged recovery persists its next wake asynchronously and keeps a newer outcome", async () => {
  const f = fixture();
  const begun = f.registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", launchProfile: f.profile });
  const recovery = { phase: "unpublished" as const, startedAt: Date.parse(AT), checks: 1, nextTryAt: Date.parse(AT) + 1000, reason: "fixture" };
  try {
    expect(await held(f, () => writeStagedRecovery(f.registry, begun.receipt.launchId, recovery))).toBe(true);
    expect(f.registry.spawnRecoverySnapshot([begun.receipt.launchId]).receipts[begun.receipt.launchId]?.error).toContain('"checks":1');
    expect(await held(f, () => writeStagedRecovery(f.registry, begun.receipt.launchId, recovery, () => false))).toBe(false);
  } finally { f.registry.close(); }
});

test("identity migration retries after serving through asynchronous account admission", async () => {
  const f = fixture(); f.seed();
  try {
    const result = await held(f, () => runIdentityWaveMigrationAtStartupOffLoop({ registry: f.registry, env: {}, seats: () => [], now: () => AT,
      transcriptTitle: () => "Fixture", sharedPath: () => null, commitExternalPathRekeys: () => {}, log: () => {} }));
    expect(result.alreadyCompleted).toBe(false);
    expect((await runIdentityWaveMigrationAtStartupOffLoop({ registry: f.registry, env: {}, seats: () => [], log: () => {} })).alreadyCompleted).toBe(true);
  } finally { f.registry.close(); }
});

function seedHost(f: ReturnType<typeof fixture>) {
  f.seed();
  const state: HostState = { status: "idle", sessionKey: SESSION, endpoint: "stdio:fixture", pid: 424242, processStartIdentity: "fixture-process",
    eventCursor: 0, protocolVersion: "1", activeTurnRef: null, pendingAttention: [], activeFlags: [], account: null };
  f.registry.upsert({ key: KEY, artifactPath: f.artifactPath, cwd: "/repo", accountId: null, status: "idle", host: null, claimEpoch: 7, claimOwner: "fixture-owner",
    pendingAction: null, structuredHost: { kind: "codex-app-server", endpoint: state.endpoint, process: { pid: state.pid!, startIdentity: state.processStartIdentity, bootEpoch: "fixture-boot" },
      eventCursor: 0, protocolVersion: "1", writerClaimEpoch: 7, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  return state;
}

test("host initial, cursor, material, terminal and release checkpoints leave the serving loop free", async () => {
  const f = fixture(); const state = seedHost(f);
  let listener: ((state: HostState) => void) | null = null;
  const host = { health: async () => state, release: async () => {}, setWriterFence: () => {},
    onStateChange: (next: (state: HostState) => void) => { listener = next; return () => { listener = null; }; } } as unknown as CodexAppServerHost;
  try {
    const stop = await held(f, () => bindCodexHostPersistence(f.registry, KEY, host, "fixture-owner", 7, "unhosted", { cursorDebounceMs: 0 }));
    for (const [cursor, status] of [[1, "idle"], [2, "active"], [3, "attention"], [4, "unhosted"]] as const) {
      await held(f, async () => {
        listener?.({ ...state, eventCursor: cursor, status });
        await stop.flush();
      });
      expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.structuredHost?.eventCursor).toBe(cursor);
    }
    await stop();
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.claimOwner).toBeNull();
  } finally { f.registry.close(); }
});

test("host capture waits for durable admission and a stale checkpoint preserves a replacement claim", async () => {
  const f = fixture(); const state = seedHost(f);
  let listener: ((state: HostState) => void) | null = null;
  let capture: ((pid: number, tree: readonly { pid: number; startIdentity: string; bootEpoch: string }[]) => boolean | Promise<boolean>) | null = null;
  const host = { health: async () => state, release: async () => {}, setWriterFence: () => {},
    setTerminationCapture: (next: typeof capture) => { capture = next; },
    onStateChange: (next: (state: HostState) => void) => { listener = next; return () => { listener = null; }; } } as unknown as CodexAppServerHost;
  try {
    const stop = await bindCodexHostPersistence(f.registry, KEY, host, "fixture-owner", 7);
    // Initial persistence derives columns from health, so restore a complete root identity.
    const current = f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]!;
    f.registry.upsert({ ...current, structuredHost: { ...current.structuredHost!, process: { pid: 424242, startIdentity: "fixture-process", bootEpoch: "fixture-boot" } } });
    const tree = [{ pid: 424243, startIdentity: "fixture-child", bootEpoch: "fixture-boot" }];
    expect(await held(f, () => Promise.resolve(capture!(424242, tree)))).toBe(true);
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.structuredTerminationSurvivors).toEqual(tree);
    // Release is qualified by the original owner/epoch, even after a replacement.
    const captured = f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]!;
    f.registry.upsert({ ...captured, structuredTerminationSurvivors: [], claimOwner: "replacement", claimEpoch: 8,
      structuredHost: { ...captured.structuredHost!, writerClaimEpoch: 8 } });
    await held(f, async () => { listener?.({ ...state, status: "active", activeTurnRef: "old-turn" }); await stop.flush(); });
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]).toMatchObject({ claimOwner: "replacement", claimEpoch: 8 });
    await stop();
  } finally { f.registry.close(); }
});

test("dead host and startup demotion callbacks take admission on each pass", async () => {
  const f = fixture(); seedHost(f);
  try {
    await held(f, () => demoteSkippedStructuredRegistryHosts(f.registry, () => false));
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.status).toBe("dead");
    seedHost(f);
    f.registry.reconcileConversations([{ engine: "codex", path: f.artifactPath, accountId: null, launchProfile: f.profile,
      turn: { state: "terminal", source: "lifecycle", terminalAt: AT }, observedAt: AT }]);
    await held(f, () => reconcileDeadStructuredRegistryHostsOffLoop(f.registry));
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.status).toBe("dead");
  } finally { f.registry.close(); }
});

for (const noOwedTurn of [false, true]) test(`demotion handoff admits its marker and obligation (noOwedTurn=${noOwedTurn})`, async () => {
  const f = fixture();
  const state = { ...seedHost(f), status: "active" as const, activeTurnRef: noOwedTurn ? null : "fixed-turn" };
  const entry = f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]!;
  f.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!,
    process: captureProcessIdentity(state.pid!, undefined, state.processStartIdentity) } });
  try {
    expect(await held(f, () => handOverHostForDemotion(f.registry, KEY, state, { seats: () => [] }, async () => state))).toBe(true);
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]?.pendingAction).toBe("handoff");
    expect(interruptionObligationStore(interruptionObligationDirectory(f.registry.filename)).list()).toHaveLength(noOwedTurn ? 0 : 1);
  } finally { f.registry.close(); }
});

for (const pass of [false, true]) test(`dead-host reconciliation preserves custody replaced during admission (pass=${pass})`, async () => {
  const f = fixture(); seedHost(f);
  const conversation = f.registry.conversationForPath(f.artifactPath)!;
  f.registry.reconcileConversations([{ engine: "codex", path: f.artifactPath, accountId: null, launchProfile: f.profile,
    turn: { state: "terminal", source: "lifecycle", terminalAt: AT }, observedAt: AT }]);
  const entry = f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]!;
  const replace = () => f.registry.upsert({ ...entry, claimOwner: "replacement", claimEpoch: 8,
    structuredHost: { ...entry.structuredHost!, writerClaimEpoch: 8 } });
  try {
    await held(f, async () => {
      if (pass) await reconcileDeadStructuredRegistryHostsOffLoop(f.registry, () => false, replace);
      else await reconcileDeadStructuredRegistryHostOffLoop(f.registry, conversation.id, KEY, replace);
    });
    expect(f.registry.readOnlySnapshot().entries[`codex:${SESSION}`]).toMatchObject({ claimOwner: "replacement", claimEpoch: 8 });
  } finally { f.registry.close(); }
});
