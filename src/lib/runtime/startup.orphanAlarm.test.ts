import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

import { afterAll, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { loadTasks } from "@/lib/tasks/store";
import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { ORPHAN_FOLLOW_UP_DELAYS_MS, surfaceOrphanedHosts } from "./orphanedHostAlarm";
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

    await stopFixtureTree(engine);
    expect(processIdentityStatus(engineIdentity)).toBe("dead");
    await scan();
    expect(rows.cards().map(card => card.status)).toEqual(["done"]);
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
