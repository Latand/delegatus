import fs from "node:fs";
import asyncFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { loadTasks } from "@/lib/tasks/store";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { ORPHANED_HOST_IN_FLIGHT_GRACE_MS, orphanedHostFirstObservedAt } from "./orphanedHost";
import { ORPHAN_FOLLOW_UP_DELAYS_MS, raiseOrphanedHostAlarm, surfaceOrphanedHosts } from "./orphanedHostAlarm";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { startupRowRetries, type StartupRowRetry } from "./startupRowRetries";

/* A release replaced the Viewer that owned these hosts' stdio. An engine that
   was busy, or waiting on background shells, kept running with its recorded
   owner gone. Startup passed over such rows without a word: the Claude adopter
   leaves lost stdio alone and the eligibility filter skips idle ones, so the
   seat learned nothing until a send failed. Every process here is a child this
   test started, and only those are stopped. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-orphan-alarm-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const child = () => ownFixtureTree(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));
async function ended(): Promise<ProcessIdentity> {
  const process = child();
  const identity = captureProcessIdentity(process.pid!);
  await stopFixtureTree(process);
  return identity;
}

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    readSession: async (identity) => journal.readSession(identity),
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function fixture(name: string, sessionId: string, options: {
  engine: ProcessIdentity; owner: ProcessIdentity; activeTurnRef?: string | null;
  kind?: "claude" | "codex"; endpoint?: string;
}) {
  const kind = options.kind ?? "claude";
  const directory = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const conversation = registry.ensureConversation(kind, artifactPath, "default");
  const key = { engine: kind, sessionId };
  registry.upsert({
    key, artifactPath, cwd: directory, accountId: "default", launchProfile: emptyLaunchProfile({ cwd: directory }),
    status: options.activeTurnRef ? "live" : "idle", host: null, claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(options.owner)}`, pendingAction: null,
    structuredHost: {
      kind: kind === "claude" ? "claude-broker" : "codex-app-server", endpoint: options.endpoint ?? "stdio:orphaned", process: options.engine, eventCursor: 5, protocolVersion: "fixture",
      writerClaimEpoch: 1, activeTurnRef: options.activeTurnRef ?? null, pendingAttention: [], activeFlags: [],
    },
  });
  const scheduled: { callback: () => void | Promise<void>; delay: number }[] = [];
  const dependencies: StructuredStartupDependencies = {
    registry, client: runtimeJournalClient(journal), orchestratorSeats: () => [],
    refreshTranscriptState: async () => {},
    resolveCodexOwner: () => null, resolveClaudeOwner: () => null,
    /* The Claude adopter leaves a host with lost stdio alone. */
    adoptClaude: async () => [],
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} }; },
    pipelineEvidence: () => ({ settled: new Set(), deferred: new Set() }),
  };
  const cards = () => loadTasks(statePath("tasks.json")).filter(task => task.text.includes(`${kind}:${sessionId}`));
  const close = async () => {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close(); registry.close();
  };
  return { registry, conversation, key, dependencies, scheduled, cards, close };
}

test.each(["absent", "empty", "malformed"])("a scan reads the %s alarm file once for all claimed rows", async fileState => {
  const engine = child();
  const owner = child();
  const rows = fixture(`read-once-${fileState}`, "25300000\x2d0000\x2d0000\x2d0000\x2d000000000110", {
    engine: captureProcessIdentity(engine.pid!), owner: captureProcessIdentity(owner.pid!),
  });
  const entry = rows.registry.readOnlySnapshot().entries[`claude:${rows.key.sessionId}`]!;
  const keys = [rows.key];
  for (const suffix of ["111", "112"]) {
    const key = { ...rows.key, sessionId: rows.key.sessionId.slice(0, -3) + suffix };
    rows.registry.upsert({ ...entry, key }); keys.push(key);
  }
  const file = `${rows.registry.filename}.orphan-alarms.json`;
  if (fileState !== "absent") fs.writeFileSync(file, fileState === "empty" ? "{}" : "{");
  const read = spyOn(fs, "readFileSync");
  const asyncRead = spyOn(asyncFs, "readFile");
  try {
    expect(await surfaceOrphanedHosts({ registry: rows.registry, rows: keys.map(key => ({ key })),
      adopted: new Set(), retry: () => undefined, sweepAbsent: true, assertActive: () => {},
    })).toEqual(keys);
    expect(read.mock.calls.filter(([name]) => name === file).length
      + asyncRead.mock.calls.filter(([name]) => name === file).length).toBe(1);
    expect(rows.cards()).toEqual([]);
  } finally {
    read.mockRestore();
    asyncRead.mockRestore();
    await rows.close();
    await Promise.all([stopFixtureTree(engine), stopFixtureTree(owner)]);
  }
});

test("an unreadable alarm file refuses the scan without replacing it", async () => {
  const engine = child();
  const rows = fixture("read-refused", "25300000\x2d0000\x2d0000\x2d0000\x2d000000000113", {
    engine: captureProcessIdentity(engine.pid!), owner: await ended(),
  });
  const file = `${rows.registry.filename}.orphan-alarms.json`;
  fs.mkdirSync(file);
  try {
    await expect(surfaceOrphanedHosts({ registry: rows.registry, rows: [{ key: rows.key }],
      adopted: new Set(), retry: () => undefined, sweepAbsent: true, assertActive: () => {},
    })).rejects.toThrow();
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(rows.cards()).toEqual([]);
    fs.rmdirSync(file);
    await surfaceOrphanedHosts({ registry: rows.registry, rows: [{ key: rows.key }],
      adopted: new Set(), retry: () => undefined, sweepAbsent: true, assertActive: () => {},
    });
    expect(rows.cards().map(card => card.status)).toEqual(["assigned"]);
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

test("an alarm raised during a scan preserves both rows' records", async () => {
  const engine = child();
  const rows = fixture("scan-race", "25300000\x2d0000\x2d0000\x2d0000\x2d000000000114", {
    engine: captureProcessIdentity(engine.pid!), owner: await ended(),
  });
  const entry = rows.registry.readOnlySnapshot().entries[`claude:${rows.key.sessionId}`]!;
  const other = { ...rows.key, sessionId: rows.key.sessionId.slice(0, -3) + "115" };
  rows.registry.upsert({ ...entry, key: other });
  let raised: Promise<void> | undefined;
  let checks = 0;
  try {
    await surfaceOrphanedHosts({ registry: rows.registry, rows: [{ key: rows.key }],
      adopted: new Set(), retry: () => undefined, sweepAbsent: true,
      assertActive: () => {
        if (++checks === 2) raised = raiseOrphanedHostAlarm(rows.registry, other, "fixture stop refused");
      },
    });
    expect(raised).toBeDefined();
    await raised;
    const recorded = JSON.parse(fs.readFileSync(`${rows.registry.filename}.orphan-alarms.json`, "utf8"));
    expect(Object.keys(recorded).sort()).toEqual([`claude:${rows.key.sessionId}`, `claude:${other.sessionId}`]);
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

test("an orphan startup passes over raises one assigned card naming its conversation", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const rows = fixture("passed-over", "25300000-0000-0000-0000-000000000091",
    { engine: engineIdentity, owner: await ended(), activeTurnRef: "turn-cut-by-handover" });
  try {
    await adoptStructuredHostsAtStartup(rows.dependencies);
    const cards = rows.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("assigned");
    expect(cards[0]!.text).toContain(rows.conversation.id);
    // The alarm only reports; the engine with its open turn still runs.
    expect(processIdentityStatus(engineIdentity)).toBe("alive");
    expect(rows.registry.readOnlySnapshot().entries[`claude:${rows.key.sessionId}`]?.structuredHost?.process).toEqual(engineIdentity);
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

test("a quarantined orphan whose card was published before it was an orphan is lifted to an assigned alarm", async () => {
  const engine = child();
  const rows = fixture("quarantined", "25300000-0000-0000-0000-000000000092",
    { engine: captureProcessIdentity(engine.pid!), owner: await ended() });
  const id = `claude:${rows.key.sessionId}`;
  /* Quarantined on an earlier boot, its inbox card already published, and
     its next retry not yet due. */
  const directory = `${rows.registry.filename}.startup-retries`;
  fs.mkdirSync(directory, { recursive: true });
  const retry: StartupRowRetry = { key: id, attempts: 3, reason: "incumbent-owned", nextAt: Date.now() + 10 * 60_000, quarantined: true, noticePending: false };
  const { createHash } = await import("node:crypto");
  fs.writeFileSync(path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`), JSON.stringify(retry));
  try {
    await adoptStructuredHostsAtStartup(rows.dependencies);
    const cards = rows.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("assigned");
    expect(cards[0]!.text).toContain(rows.conversation.id);
    expect(cards[0]!.text).toContain("incumbent-owned");
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

test("a row whose owner still runs raises nothing, and its owner's later exit raises the alarm", async () => {
  const engine = child();
  const owner = child();
  const rows = fixture("live-owner", "25300000-0000-0000-0000-000000000093",
    { engine: captureProcessIdentity(engine.pid!), owner: captureProcessIdentity(owner.pid!) });
  try {
    await adoptStructuredHostsAtStartup(rows.dependencies);
    expect(rows.cards()).toHaveLength(0);
    const followUp = rows.scheduled.find(item => item.delay === ORPHAN_FOLLOW_UP_DELAYS_MS[0]);
    expect(followUp).toBeDefined();

    // Still owned when the follow-up runs: nothing, and one more look later.
    rows.scheduled.splice(rows.scheduled.indexOf(followUp!), 1);
    await followUp!.callback();
    expect(rows.cards()).toHaveLength(0);
    const second = rows.scheduled.find(item => item.delay === ORPHAN_FOLLOW_UP_DELAYS_MS[1]);
    expect(second).toBeDefined();

    // The predecessor exits after the successor's pass.
    await stopFixtureTree(owner);
    rows.scheduled.splice(rows.scheduled.indexOf(second!), 1);
    await second!.callback();
    const cards = rows.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("assigned");
    expect(cards[0]!.text).toContain(rows.conversation.id);
    // A proven orphan needs no further look.
    expect(rows.scheduled.some(item => (ORPHAN_FOLLOW_UP_DELAYS_MS as readonly number[]).includes(item.delay))).toBe(false);
  } finally {
    await rows.close();
    await Promise.all([stopFixtureTree(engine), stopFixtureTree(owner)]);
  }
});

test("the alarm is idempotent across scans and closes once the row is no orphan", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const rows = fixture("closing", "25300000-0000-0000-0000-000000000094", { engine: engineIdentity, owner: await ended() });
  const scan = () => surfaceOrphanedHosts({
    registry: rows.registry, rows: [{ key: rows.key }], adopted: new Set(),
    retry: key => startupRowRetries(rows.registry).get(key), sweepAbsent: true, assertActive: () => {},
  });
  try {
    await scan();
    await scan();
    const cards = rows.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("assigned");
    const revision = cards[0]!.updatedAt;
    await scan();
    expect(rows.cards()[0]!.updatedAt).toBe(revision);

    const id = `claude:${rows.key.sessionId}`;
    for (const kind of ["grace", "stop-refused"] as const) {
      expect(await orphanedHostFirstObservedAt(rows.registry.filename, id, engineIdentity, 100, kind)).toBe(100);
      expect(fs.readdirSync(`${rows.registry.filename}.orphan-${kind}`)).toHaveLength(1);
    }

    await stopFixtureTree(engine);
    expect(processIdentityStatus(engineIdentity)).toBe("dead");
    await scan();
    expect(rows.cards().map(card => card.status)).toEqual(["done"]);
    for (const kind of ["grace", "stop-refused"] as const) {
      expect(fs.readdirSync(`${rows.registry.filename}.orphan-${kind}`)).toEqual([]);
    }
    await scan();
    expect(rows.cards().map(card => card.status)).toEqual(["done"]);
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

test("a recorded alarm whose row left the registry is closed by a full scan", async () => {
  const engine = child();
  const rows = fixture("removed", "25300000-0000-0000-0000-000000000095", { engine: captureProcessIdentity(engine.pid!), owner: await ended() });
  const scan = (scope: { key: typeof rows.key }[]) => surfaceOrphanedHosts({
    registry: rows.registry, rows: scope, adopted: new Set(),
    retry: () => undefined, sweepAbsent: true, assertActive: () => {},
  });
  try {
    await scan([{ key: rows.key }]);
    expect(rows.cards().map(card => card.status)).toEqual(["assigned"]);
    const entry = rows.registry.readOnlySnapshot().entries[`claude:${rows.key.sessionId}`]!;
    rows.registry.upsert({ ...entry, structuredHost: null });
    await scan([]);
    expect(rows.cards().map(card => card.status)).toEqual(["done"]);
  } finally {
    await rows.close();
    await stopFixtureTree(engine);
  }
});

/* A Codex app server listens on its own socket, which outlives the Viewer
   that started it. A send reconnects to a socket that still verifies, so such
   an orphan is reachable and needs no alarm; after one release nine idle ones
   would each have woken the seat with a card saying re-adoption failed. Only a
   Codex orphan whose socket cannot be verified is unreachable. */
test.each([
  ["verifies", 0],
  ["cannot be verified", 1],
] as const)("an idle Codex orphan whose socket %s raises %d assigned cards", async (socketState, expected) => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  // A short directory: a Unix socket path is limited to about a hundred bytes.
  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oa-"));
  const socketFile = path.join(socketDirectory, "rpc.sock");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketFile, resolve); });
  fs.chmodSync(socketFile, 0o600);
  const rows = fixture(`codex-socket-${expected}`, `25300000-0000-0000-0000-00000000009${6 + expected}`, {
    engine: engineIdentity, owner: await ended(), kind: "codex",
    endpoint: socketState === "verifies" ? `codex-unix:${socketFile}` : "stdio:orphaned",
  });
  try {
    await adoptStructuredHostsAtStartup(rows.dependencies);
    expect(rows.cards().filter(card => card.status === "assigned")).toHaveLength(expected);
    if (expected) expect(rows.cards()[0]!.text).toContain(rows.conversation.id);
    // Neither case stops the engine.
    expect(processIdentityStatus(engineIdentity)).toBe("alive");
    expect(rows.registry.readOnlySnapshot().entries[`codex:${rows.key.sessionId}`]?.structuredHost?.process).toEqual(engineIdentity);
  } finally {
    await rows.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(socketDirectory, { recursive: true, force: true });
    await stopFixtureTree(engine);
  }
});

test("a recorded alarm closes once the Codex orphan's socket verifies again", async () => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "oa-"));
  const socketFile = path.join(socketDirectory, "rpc.sock");
  const rows = fixture("codex-socket-returns", "25300000-0000-0000-0000-000000000098", {
    engine: engineIdentity, owner: await ended(), kind: "codex", endpoint: `codex-unix:${socketFile}`,
  });
  const scan = () => surfaceOrphanedHosts({
    registry: rows.registry, rows: [{ key: rows.key }], adopted: new Set(),
    retry: key => startupRowRetries(rows.registry).get(key), sweepAbsent: true, assertActive: () => {},
  });
  const server = net.createServer();
  try {
    // No socket on disk yet: nothing can reach the engine.
    await scan();
    expect(rows.cards().map(card => card.status)).toEqual(["assigned"]);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketFile, resolve); });
    fs.chmodSync(socketFile, 0o600);
    await scan();
    expect(rows.cards().map(card => card.status)).toEqual(["done"]);
    expect(processIdentityStatus(engineIdentity)).toBe("alive");
  } finally {
    await rows.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(socketDirectory, { recursive: true, force: true });
    await stopFixtureTree(engine);
  }
});

/* Tonight's shape end to end: a busy Claude engine outlived its Viewer, and
   the successor's startup pass ran the production Claude adopter over it.
   Startup counted the row contested whatever its owner, so the controller kept
   the conversation deferred and an accepted send waited behind the startup
   fence for as long as the engine lived; recovery was never asked. A proven
   orphan has no predecessor to wait for: the send is held for the grace, then
   the orphan is stopped and resumed, also when an earlier boot quarantined
   it as incumbent-owned and that retry is not yet due. A row whose owner
   still runs stays deferred and its engine is left alone. */
test.each([
  ["dead", "01"],
  ["dead, quarantined by an earlier boot", "02"],
  ["live", "03"],
] as const)("a busy orphan's send after startup with its owner %s", async (ownerState, suffix) => {
  const engine = child();
  const engineIdentity = captureProcessIdentity(engine.pid!);
  const owner = ownerState === "live" ? child() : null;
  const rows = fixture(`startup-deferral-${suffix}`, `25300000-0000-0000-0000-0000000001${suffix}`, {
    engine: engineIdentity, owner: owner ? captureProcessIdentity(owner.pid!) : await ended(), activeTurnRef: "turn-cut-by-handover",
  });
  if (ownerState !== "dead" && ownerState !== "live") {
    const id = `claude:${rows.key.sessionId}`;
    const directory = `${rows.registry.filename}.startup-retries`;
    fs.mkdirSync(directory, { recursive: true });
    const retry: StartupRowRetry = { key: id, attempts: 3, reason: "incumbent-owned",
      nextAt: Date.parse("2026-11-17T05:20:00.000Z"), quarantined: true, noticePending: false };
    const { createHash } = await import("node:crypto");
    fs.writeFileSync(path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`), JSON.stringify(retry));
  }
  const journal = new RuntimeJournal(path.join(path.dirname(rows.registry.filename), "delivery.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  let spawns = 0;
  const recoveries: string[] = [];
  const ledger = createFakeDeliveryLedger();
  const resumed = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {}, setWriterFence: () => {} });
  const admittedAt = Date.parse("2026-11-17T05:05:00.000Z");
  setSystemTime(new Date(admittedAt));
  try {
    await bindStructuredDeliveryQueue([], {
      registry: rows.registry, client, deferStartupWork: true, watchdogIntervalMs: 0, settlementSweepMs: 0, hostlessSettleIntervalMs: 0,
      recover: async (request, dependencies) => {
        recoveries.push(request.conversationId ?? request.path);
        const recovered = await recoverDeadStructuredConversation(request, {
          ...dependencies, transportAvailable: () => true, park: () => null,
          orphanStop: { graceMs: 200, deadlineMs: 3_000 },
          resolveAccount: () => ({ engine: "claude", accountId: "default", kind: "legacy", home: sandbox, transcriptRoot: sandbox, env: { NODE_ENV: "test" } }),
          spawn: async input => {
            spawns += 1;
            return { ok: true, target: null, path: request.path, launchId: input.receipt.launchId, conversationId: rows.conversation.id,
              launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
          },
        });
        /* The resumed host, as a real spawn would publish it. */
        if (recovered?.spawned) {
          rows.registry.setStructuredHost(rows.key, { kind: "claude-broker", endpoint: "fixture:resumed", process: null, eventCursor: 0,
            protocolVersion: "fixture", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] }, "idle");
          await publishStructuredDeliveryHost({ key: rows.key, host: resumed });
        }
        return recovered;
      },
    });
    /* Before the release the predecessor hosted the session in the runtime
       host's journal, which outlives Viewers, and a send queued behind the
       busy turn. */
    journal.append({ scope: `session:${rows.conversation.id}`, kind: "session-status", payload: {
      conversationId: rows.conversation.id, sessionKey: { engine: "claude", sessionId: rows.key.sessionId },
      hostKind: "claude-broker", host: "hosted", turn: "running" } });
    const operationId = `orphan-send-${suffix}`;
    const admitted = journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId,
      conversationId: rows.conversation.id, text: "the merge gate finished", policy: "queue" });
    expect(admitted.receipt.status).toBe("queued");

    /* The production Claude adopter runs, and leaves the lost stdio alone. */
    await adoptStructuredHostsAtStartup({ ...rows.dependencies, client, adoptClaude: undefined });
    expect(processIdentityStatus(engineIdentity)).toBe("alive");
    const quarantine = startupRowRetries(rows.registry).get(`claude:${rows.key.sessionId}`);
    // Only the earlier boot's record names it incumbent-owned; this pass adds none.
    expect(quarantine?.reason === "incumbent-owned").toBe(ownerState !== "dead");
    const recoveriesDuringStartup = recoveries.length;

    const status = () => journal.operationResult(operationId)?.receipt.status;
    await kickStructuredDeliveryQueue();
    // Inside the grace nothing is stopped and the send stays accepted.
    expect(spawns).toBe(0);
    expect(processIdentityStatus(engineIdentity)).toBe("alive");
    expect(status()).toBe("queued");

    setSystemTime(new Date(admittedAt + ORPHANED_HOST_IN_FLIGHT_GRACE_MS + 60_000));
    await kickStructuredDeliveryQueue();
    if (ownerState !== "live") {
      expect(recoveries.length).toBeGreaterThan(recoveriesDuringStartup + 1);
      expect(spawns).toBe(1);
      expect(processIdentityStatus(engineIdentity)).toBe("dead");
      // The send reached the resumed host.
      expect(ledger.writes).toHaveLength(1);
      expect(status()).not.toBe("failed");
    } else {
      // Deferred behind its live owner: not recovered again, never signalled.
      expect(recoveries).toHaveLength(recoveriesDuringStartup);
      expect(spawns).toBe(0);
      expect(processIdentityStatus(engineIdentity)).toBe("alive");
      expect(status()).toBe("queued");
      expect(ledger.writes).toEqual([]);
      expect(rows.registry.readOnlySnapshot().entries[`claude:${rows.key.sessionId}`]?.structuredHost?.process).toEqual(engineIdentity);
    }
  } finally {
    setSystemTime();
    await rows.close();
    journal.close();
    await Promise.all([stopFixtureTree(engine), ...(owner ? [stopFixtureTree(owner)] : [])]);
  }
});
