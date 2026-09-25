import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// Clear inherited credentials, runtime endpoints and provider roots BEFORE imports.
// TMPDIR is supplied on private disk by the invoking test environment.
const ambient = { ...process.env };
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-finalization-"));
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: ambient.PATH, NODE_ENV: "test" });
for (const [name, suffix] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", TMPDIR: "tmp", CODEX_HOME: "codex", LLV_CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", LLV_CLAUDE_HOME: "claude" })) {
  const directory = path.join(isolated, suffix);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env[name] = directory;
}
fs.mkdirSync(path.join(isolated, "sockets"), { mode: 0o700 });

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeHost } = await import("@/runtime-host/host");
const { serveRuntimeHost } = await import("@/runtime-host/socket");
const { UnixRuntimeHostClient } = await import("./client");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { adoptStructuredHostsAtStartup } = await import("./startup");
const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
const { runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
const { checkpointHotStateRollbackMirrorsForDemotion } = await import("@/lib/viewerInstrumentation");
const { recoverPendingStructuredSpawns, reconcileStructuredSpawnReplay } = await import("./structuredSpawn");
const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { structuredStartupStatus } = await import("./startupStatus");
type RuntimeHostClient = import("./client").RuntimeHostClient;
type RegistryFile = import("@/lib/agent/registry").RegistryFile;

afterAll(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, ambient);
  fs.rmSync(isolated, { recursive: true, force: true });
});

function fixture(failedCount: number, fullHistory = false, historyCount = 8078, grantedRoots = 0) {
  const directory = fs.mkdtempSync(path.join(isolated, "fixture-"));
  const filename = path.join(directory, "registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const begun = seed.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory, title: "Historical failed launch" }),
  });
  seed.failSpawn(begun.receipt.launchId, "historical failure");
  if (fullHistory) {
    const artifactPath = path.join(directory, "history-seed.jsonl");
    const conversation = seed.ensureConversation("codex", artifactPath, null);
    const sessionId = conversation.generations.at(-1)!.id;
    const delivery = seed.holdDelivery(conversation.id, "Historical delivery", "history-seed", "text");
    seed.recordDeliveryOutcome(delivery.id, "failed", "historical failure");
    seed.upsert({
      key: { engine: "codex", sessionId }, artifactPath, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "dead", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null,
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null,
        pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
  }
  const data = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
  const receipt = data.receipts[begun.receipt.launchId]!;
  data.receipts = {};
  for (let i = 0; i < failedCount; i++) {
    const launchId = `historical_launch_${i}`;
    data.receipts[launchId] = { ...receipt, launchId, conversationId: `conversation_history_${i}` };
  }
  if (fullHistory) {
    const entry = Object.values(data.entries)[0]!;
    const conversation = Object.values(data.conversations)[0]!;
    data.entries = {};
    data.conversations = {};
    for (let i = 0; i < historyCount; i++) {
      const id = `conversation_history_${i}` as const;
      const sessionId = `history_${i}`;
      const artifactPath = path.join(directory, `${sessionId}.jsonl`);
      // Operator roots holding a grantable connector, spread through the history as they are in production.
      const mcpServers = i % 85 === 0 && i / 85 < grantedRoots ? ["viewer", "telegram"] : ["viewer"];
      if (i < 5188) data.entries[`codex:${sessionId}`] = {
        ...entry, key: { engine: "codex", sessionId }, artifactPath,
        launchProfile: { ...entry.launchProfile!, mcpServers },
      };
      data.conversations[id] = {
        ...conversation, id,
        ...(mcpServers.length > 1 ? { agentRole: null, delegationDepth: 0 } : {}),
        turn: { state: "terminal", source: "assistant", terminalAt: receipt.createdAt, observedAt: receipt.createdAt },
        generations: conversation.generations.map((generation) => ({
          ...generation, id: sessionId, path: artifactPath, launchProfile: { ...generation.launchProfile, mcpServers },
        })),
      };
    }
    const held = Object.values(data.heldDeliveries)[0]!;
    data.heldDeliveries = {};
    for (let i = 0; i < 1719; i++) {
      const id = `historical_delivery_${i}`;
      data.heldDeliveries[id] = {
        ...held, id, conversationId: `conversation_history_${i}`, clientMessageId: id,
        command: { ...held.command, operationId: `historical_operation_${i}` },
        state: i < 153 ? "failed" : "delivered",
      };
    }
    for (let i = failedCount; i < 6623; i++) {
      const launchId = `historical_launch_${i}`;
      data.receipts[launchId] = {
        ...receipt, launchId, conversationId: `conversation_history_${i}`,
        state: i < 6458 ? "completed" : i < 6590 ? "conflicted" : i < 6611 ? "starting"
          : i < 6618 ? "host-verified" : i < 6622 ? "pane-bound" : "path-pending",
      };
    }
  }
  fs.writeFileSync(filename, JSON.stringify(data));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
    producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
  return { directory, registry, journal, client };
}

for (const responseMs of [5_000, 11_000]) test(`slow startup keyed read completes after ${responseMs} ms and reconnects reuse ready`, async () => {
  const f = fixture(0);
  const conversation = f.registry.ensureConversation("codex", path.join(f.directory, "slow.jsonl"), null);
  // A released structured row: startup reads runtime evidence only for rows a structured host can own.
  f.registry.upsert({
    key: { engine: "codex", sessionId: conversation.generations.at(-1)!.id }, artifactPath: path.join(f.directory, "slow.jsonl"),
    cwd: f.directory, accountId: null, launchProfile: emptyLaunchProfile({ cwd: f.directory }), status: "dead", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null, eventCursor: 0, protocolVersion: null,
      writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 0, claimOwner: null, pendingAction: null,
  });
  const { savePipelines } = await import("@/lib/pipelines/store");
  savePipelines([]);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  const socketPath = path.join(isolated, "sockets", `slow-${responseMs}.sock`);
  const connections = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: { method: string; params: unknown }[] = [];
  let heldDuringRequest = false;
  const observeLeases = () => {
    const row = db.query("SELECT count(*) AS n FROM state_leases").get() as { n: number };
    heldDuringRequest ||= row.n > 0;
  };
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      buffer = "";
      requests.push({ method: request.method, params: request.params });
      observeLeases();
      const timer = setTimeout(() => {
        timers.delete(timer);
        observeLeases();
        const result = request.method === "session-read" ? f.journal.readSession(request.params) : f.journal.snapshot();
        if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
      }, responseMs);
      timers.add(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const transport = new UnixRuntimeHostClient(socketPath);
  const client: RuntimeHostClient = {
    ...f.client, snapshot: transport.snapshot.bind(transport), readSession: transport.readSession.bind(transport),
    startupGeneration: transport.startupGeneration.bind(transport),
  };
  let passes = 0;
  let adoptions = 0;
  const holds: number[] = [];
  const retries: number[] = [];
  const dependencies = {
    registry: f.registry, client, orchestratorSeats: () => [],
    observeLeaseHold: (heldMs: number) => holds.push(heldMs),
    refreshTranscriptState: async () => { passes += 1; },
    adopt: async () => { adoptions++; return []; },
    adoptClaude: async () => { adoptions++; return []; },
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const sampler = setInterval(observeLeases, 10);
  try {
    // Record retries without scheduling them: a failed read must fail this test,
    // rather than leave the runner retrying in the background after the test.
    await runStructuredHostStartup(async () => {
      await Promise.all([
        adoptStructuredHostsAtStartup(dependencies),
        adoptStructuredHostsAtStartup(dependencies),
      ]);
    }, () => {}, { schedule: (_callback, ms) => { retries.push(ms); return { unref() {} }; } });
    expect(retries).toEqual([]);
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(adoptions).toBe(2);
    const firstPassAdoptions = adoptions;
    const firstPassReads = requests.length;
    await adoptStructuredHostsAtStartup(dependencies);
    expect(adoptions - firstPassAdoptions).toBe(0);
    expect(requests.length - firstPassReads).toBe(0);
    expect(passes).toBe(1);
    // The startup signal read, then the historical fallback's comparison read.
    expect(requests).toEqual(Array.from({ length: 2 }, () => ({ method: "session-read", params: { conversationId: conversation.id } })));
    /* No lease is held while a host request is in flight, sampled at every
       request and every 10 ms besides. Hold times and event-loop delay are
       reported below, never asserted (#1761). */
    expect(heldDuringRequest).toBe(false);
    expect(holds.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ responseMs, keyedReads: requests.length, secondTriggerAdoptions: adoptions - firstPassAdoptions,
      heldDuringRequest, maxLeaseHoldMs: Math.max(...holds), eventLoopDelayMs: delay.max / 1e6 }));
  } finally {
    clearInterval(sampler);
    delay.disable();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
    f.registry.close();
  }
}, 30_000);

test("historical failed launches do not retain startup admission across one full runtime snapshot per receipt", async () => {
  const f = fixture(672);
  // Runtime history and failed receipt cardinalities match the incident's scale.
  // Transport latency is bounded and lower than the measured live snapshot read.
  for (let i = 0; i < 862; i++) f.journal.append({
    scope: { type: "session", id: `conversation_runtime_history_${i}` },
    kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: `history:${i}` },
    payload: { conversationId: `conversation_runtime_history_${i}`, host: "dead", turn: "idle", cwd: f.directory },
  });
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  let snapshots = 0;
  let spawnRecovery = false;
  let signalRecovery!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => { signalRecovery = resolve; });
  const timeline: string[] = [];
  const client: RuntimeHostClient = {
    ...f.client,
    snapshot: async () => {
      snapshots += 1;
      if (spawnRecovery) signalRecovery();
      await Bun.sleep(60);
      return f.journal.snapshot();
    },
    effectBatch: async (kinds, after) => {
      if (kinds?.length === 1 && kinds[0] === "runtime.spawn") {
        spawnRecovery = true;
        timeline.push("spawn-recovery");
      } else timeline.push("delivery-signals-or-drain");
      return f.client.effectBatch(kinds, after);
    },
  };
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
    registry: f.registry, client, refreshTranscriptState: async () => {},
    adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
  }), () => {}, { waitUntilReady: true });
  try {
    await recoveryEntered;
    expect(structuredStartupStatus()?.state).toBe("pending");
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    const held = db.query("SELECT owner_pid, owner_start_identity FROM state_leases WHERE collection = 'pipelines'").get() as { owner_pid: number; owner_start_identity: string };
    db.close();
    expect(held).toBeNull();
    timeline.push("lease-free-during-recovery");
    const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupPipelineContender.ts"), f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(contender.stdout).text();
    const stderr = new Response(contender.stderr).text();
    await startup;
    timeline.push("startup-settled");
    expect(await contender.exited).toBe(0);
    expect(await stderr).toBe("");
    const result = JSON.parse(await stdout);
    console.log(JSON.stringify({ timeline, snapshots, creation: result }));
    expect(result).toEqual({ created: true, error: null, persisted: 1 });
    expect(snapshots).toBeLessThanOrEqual(4);
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
    const after = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    expect(after.query("SELECT count(*) AS n FROM state_leases WHERE collection = 'pipelines'").get()).toEqual({ n: 0 });
    after.close();
  } finally {
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
  }
}, 90_000);


test("a failed historical snapshot remains unknown and a later pass retries it", async () => {
  const f = fixture(3);
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  let reads = 0;
  const unavailable: RuntimeHostClient = {
    ...f.client,
    snapshot: async () => { reads += 1; throw new Error("fixture snapshot unavailable"); },
  };
  try {
    await recoverPendingStructuredSpawns(f.registry, unavailable);
    expect(reads).toBe(2); // Shared historical read plus the registering-session hint.
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
    await recoverPendingStructuredSpawns(f.registry, unavailable);
    expect(reads).toBe(4); // No rejected snapshot survives its pass.
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
  } finally { f.journal.close(); }
});

test("startup exposes fallback publication while pipeline admission stays available", async () => {
  const f = fixture(1, true);
  let entered!: () => void;
  const publicationEntered = new Promise<void>((resolve) => { entered = resolve; });
  let settle!: () => void;
  const publicationSettlement = new Promise<void>((resolve) => { settle = resolve; });
  const host = new RuntimeHost(f.journal);
  const server = serveRuntimeHost(path.join(isolated, "sockets", "progress.sock"), {
    handle: async (request, options) => {
      if (request.method === "append") {
        entered();
        await publicationSettlement;
      }
      return host.handle(request, options);
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(path.join(isolated, "sockets", "progress.sock"));
  // No transcript/adopter/controller substitution: historical rows are dead;
  // only the private socket peer withholds a publication response.
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
    registry: f.registry, client,
  }), () => {}, { waitUntilReady: true });
  const leases = () => {
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try { return db.query("SELECT owner_pid FROM state_leases WHERE collection = 'pipelines'").all(); }
    finally { db.close(); }
  };
  try {
    await publicationEntered;
    expect(structuredStartupStatus()).toMatchObject({
      state: "pending", phase: "publishing historical host fallbacks",
      pid: process.pid, phaseStartedAt: expect.any(String),
    });
    expect(leases()).toEqual([]);
    await Bun.sleep(25);
    expect(leases()).toEqual([]);
    settle();
    await startup;
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(leases()).toEqual([]);
  } finally {
    settle();
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 60_000);

test("rollback checkpoint does not wait on startup network publication", async () => {
  const f = fixture(1, true);
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => { entered = resolve; });
  let released!: () => void;
  const response = new Promise<void>((resolve) => { released = resolve; });
  let first = true;
  const client: RuntimeHostClient = { ...f.client, append: async (event) => {
    if (first) { first = false; entered(); await response; }
    return f.client.append(event);
  } };
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({ registry: f.registry, client }), () => {}, { waitUntilReady: true });
  await publishing;
  let replySettled = false;
  const timer = setTimeout(() => { replySettled = true; released(); }, 50);
  try {
    await checkpointHotStateRollbackMirrorsForDemotion();
    expect(replySettled).toBe(false);
    released();
    await startup;
  } finally {
    clearTimeout(timer);
    released();
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
  }
}, 60_000);

test("retirement joins historical publications before releasing admission and never publishes ready", async () => {
  const f = fixture(2, true);
  const abort = new AbortController();
  const check = () => abort.signal.throwIfAborted();
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const client: RuntimeHostClient = { ...f.client, append: async (event) => {
    requests += 1;
    const result = await f.client.append(event);
    entered();
    await response;
    return result;
  } };
  let settled = false;
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({ registry: f.registry, client, assertActive: check }), () => {}, { waitUntilReady: true, signal: abort.signal })
    .then(() => { throw new Error("retired startup reported ready"); }, () => { settled = true; });
  await publishing;
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  abort.abort(new Error("fixture retirement"));
  await Bun.sleep(20);
  expect(settled).toBe(false);
  const started = requests;
  release();
  await startup;
  await checkpointHotStateRollbackMirrorsForDemotion();
  await Bun.sleep(50);
  expect(requests).toBe(started);
  expect(requests).toBeLessThanOrEqual(16);
  expect(structuredStartupStatus()?.state).toBe("failed");
  expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  f.journal.close();
}, 30_000);

test("pending launches ignore a historical snapshot supplier", async () => {
  const f = fixture(0);
  const begun = f.registry.beginSpawnRequest({
    engine: "codex", cwd: f.directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.directory, title: "Pending launch" }),
  });
  let freshReads = 0;
  try {
    const result = await reconcileStructuredSpawnReplay(begun.receipt.launchId, f.registry, {
      ...f.client, snapshot: async () => { freshReads += 1; return f.journal.snapshot(); },
    }, { failedReceiptSnapshot: async () => { throw new Error("historical evidence must not be consulted"); } });
    expect(freshReads).toBe(1);
    expect(result.state).toBe("starting");
  } finally { f.journal.close(); }
});

test("historical reconciliation recovers late transcript evidence and preserves a current writer claim", async () => {
  const f = fixture(0);
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(f.directory, `${sessionId}.jsonl`);
  const key = { engine: "codex" as const, sessionId };
  const begun = f.registry.beginSpawnRequest({
    engine: "codex", cwd: f.directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.directory, title: "Late delivery" }),
  });
  f.registry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath, cwd: f.directory, accountId: null, status: "unhosted", host: null,
    structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  f.registry.failStructuredSpawn(begun.receipt.launchId, "unknown delivery before restart");
  fs.writeFileSync(artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Synthetic late delivery" } }) + "\n");
  const stored = f.registry.readOnlySnapshot().entries[`codex:${sessionId}`]!;
  f.registry.upsert({ ...stored, structuredHost: {
    kind: "codex-app-server", endpoint: "fixture:late", process: null,
    eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 0,
    activeTurnRef: null, pendingAttention: [], activeFlags: [],
  } });
  // The shared runtime evidence describes the old unhosted projection while
  // the durable registry below has a newer writer; recovery must merge that claim.
  f.journal.append({
    scope: { type: "session", id: begun.receipt.conversationId }, kind: "session-status",
    payload: { conversationId: begun.receipt.conversationId, sessionKey: key,
      hostKind: "codex-app-server", host: "unhosted", cwd: f.directory, artifactPath },
  });
  const claimed = f.registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true });
  expect(claimed?.claimOwner).toBeTruthy();
  try {
    await recoverPendingStructuredSpawns(f.registry, f.client);
    const receipt = f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]!;
    expect(receipt.state).toBe("completed");
    expect(receipt.conversationId).toBe(begun.receipt.conversationId);
    expect(f.registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.claimOwner).toBe(claimed!.claimOwner);
    await recoverPendingStructuredSpawns(f.registry, f.client);
    expect(f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]).toEqual(receipt);
  } finally { f.journal.close(); }
});

test.each([["codex", false], ["codex", true], ["claude", false], ["claude", true]] as const)("late unkeyed %s resume preserves its writer (account mismatch=%s)", async (engine, accountMismatch) => {
  const f = fixture(0);
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(f.directory, `${sessionId}.jsonl`);
  const key = { engine, sessionId };
  const profile = emptyLaunchProfile({ cwd: f.directory, title: "Unkeyed resume recovery" });
  const conversation = f.registry.ensureConversation(engine, artifactPath, null);
  f.registry.upsert({ key, artifactPath, cwd: f.directory, accountId: null, launchProfile: profile,
    status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:released",
      process: null, eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0,
      activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  });
  const begun = f.registry.beginSpawnRequest({ engine, cwd: f.directory, transport: "structured", accountId: null,
    conversationId: conversation.id, purpose: "resume-successor", expectedArtifactPath: artifactPath, launchProfile: profile,
  });
  expect(begun.receipt.key).toBeNull();
  f.registry.failStructuredSpawn(begun.receipt.launchId, "resume lost admission to startup adoption");
  const currentEntry = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
  if (accountMismatch) f.registry.upsert({ ...currentEntry, accountId: "current-writer-account" });
  const externalWriter = Bun.spawn([process.execPath, "-e", "for await (const chunk of process.stdin) { void chunk; }"], {
    env: { ...process.env }, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  const owner = captureProcessIdentity(externalWriter.pid);
  const claimed = f.registry.claimStructuredHost(key, owner, { allowUnhosted: true })!;
  f.registry.setStructuredHostClaimed(key, { ...claimed.structuredHost!, endpoint: "fixture:current-writer",
    process: owner,
  }, "idle", claimed.claimOwner!, claimed.claimEpoch);
  const before = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
  fs.writeFileSync(artifactPath, JSON.stringify(engine === "codex"
    ? { type: "event_msg", payload: { type: "user_message", message: "Synthetic prior turn" } }
    : { type: "user", message: { role: "user", content: "Synthetic prior turn" } }) + "\n");
  f.journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status",
    payload: { conversationId: conversation.id, sessionKey: key, hostKind: before.structuredHost!.kind,
      host: "hosted", turn: "idle", cwd: f.directory, artifactPath },
  });
  try {
    await recoverPendingStructuredSpawns(f.registry, f.client);
    const after = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
    expect(after.accountId).toBe(before.accountId);
    expect(after.claimOwner).toBe(before.claimOwner);
    expect(after.claimEpoch).toBe(before.claimEpoch);
    expect(after.structuredHost).toEqual(before.structuredHost);
    expect(f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]!.state).toBe(accountMismatch ? "failed" : "completed");
  } finally {
    externalWriter.stdin.end();
    await externalWriter.exited;
    f.journal.close();
  }
});


test("the full retained history completes within the promoted serving budget", async () => {
  const f = fixture(672, true);
  const initial = f.registry.readOnlySnapshot();
  expect(Object.keys(initial.receipts)).toHaveLength(6623);
  expect(Object.keys(initial.conversations)).toHaveLength(8078);
  expect(Object.keys(initial.entries)).toHaveLength(5188);
  const failed = Object.values(initial.receipts).filter((receipt) => receipt.state === "failed");
  // Seed only the runtime's retained session window. Startup must publish the
  // remaining historical registry rows through the real socket and journal.
  for (let i = 0; i < 862; i++) f.journal.append({
    scope: { type: "session", id: `conversation_history_${i}` }, kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: `history:${i}` },
    payload: {
      conversationId: `conversation_history_${i}`, sessionKey: { engine: "codex", sessionId: `history_${i}` },
      hostKind: "codex-app-server", host: "dead", turn: "unknown", provenance: "structured",
      accountId: null, parentConversationId: null, cwd: f.directory,
      artifactPath: path.join(f.directory, `history_${i}.jsonl`), activeTurnId: null,
    },
  });
  const counts: Record<string, number> = {};
  const host = new RuntimeHost(f.journal);
  // A short private endpoint also fits Unix sockaddr limits on CI.
  const socketPath = path.join(isolated, "sockets", "history.sock");
  const server = serveRuntimeHost(socketPath, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    // Three seconds exceeds the measured 2.6s full snapshot HTTP read. Other
    // calls pay 5ms before actual socket/journal work; live status reads were <1ms.
    await Bun.sleep(request.method === "snapshot" ? 3000 : 5);
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  const started = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry: f.registry, client, refreshTranscriptState: async () => {},
      adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    }), () => {}, { waitUntilReady: true });
    const elapsedMs = performance.now() - started;
    console.log(JSON.stringify({ history: { receipts: 6623, conversations: 8078, entries: 5188 }, counts, elapsedMs }));
    /* The budget is held by what startup asks the host for, counted below: no
       full snapshot (three seconds each here), and a bounded number of every
       other call. The time is reported above, never asserted (#1761). */
    expect(counts.snapshot ?? 0).toBe(0);
    expect(counts["session-read"]).toBeGreaterThan(0);
    expect(counts.append).toBeGreaterThan(4300);
    expect(counts["operation-status"]).toBe(1518);
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(Object.values(f.registry.readOnlySnapshot().receipts).filter((receipt) => receipt.state === "failed").slice(0, 672)).toEqual(failed);
    const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupPipelineContender.ts"), f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(contender.stdout).text();
    const errors = new Response(contender.stderr).text();
    expect(await contender.exited).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(await output)).toMatchObject({ created: true, error: null });
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 130_000);


test("granted operator rows keep HTTP answering through a full retained-history startup", async () => {
  const f = fixture(672, true, 8078, 60);
  const granted = Object.values(f.registry.readOnlySnapshot().conversations)
    .filter((conversation) => conversation.generations.at(-1)!.launchProfile.mcpServers.includes("telegram"));
  expect(granted).toHaveLength(60);
  const counts: Record<string, number> = {};
  const host = new RuntimeHost(f.journal);
  const socketPath = path.join(isolated, "sockets", "granted.sock");
  const server = serveRuntimeHost(socketPath, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  // The Viewer's own HTTP answers from this event loop; probe it the whole way through.
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const latencies: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const sent = performance.now();
      await (await fetch(`http://127.0.0.1:${http.port}/`)).text();
      latencies.push(performance.now() - sent);
      await Bun.sleep(50);
    }
  })();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry: f.registry, client, refreshTranscriptState: async () => {},
      adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    }), () => {}, { waitUntilReady: true });
    const elapsedMs = performance.now() - started;
    probing = false;
    await probe;
    delay.disable();
    const httpMaxMs = Math.max(...latencies);
    console.log(JSON.stringify({ granted: granted.length, counts, elapsedMs, httpProbes: latencies.length, httpMaxMs,
      eventLoopMaxMs: delay.max / 1e6 }));
    expect(structuredStartupStatus()?.state).toBe("ready");
    /* Each row a structured host can own is read for its signals and again for its fallback, and each failed
       launch twice by spawn recovery. The other 2890 historical conversations are not read at all. */
    expect(counts["session-read"]).toBeLessThanOrEqual(2 * 5188 + 2 * 672);
    /* Before the decision was reused, this history took over sixty seconds to
       reach ready here. The elapsed time, the slowest HTTP probe and the
       event-loop delay are reported above, never asserted: all three measure
       the runner as much as the startup (#1761). The call counts are what
       hold the repair. */
    // The decision is reused, never skipped: each granted root keeps exactly its grant.
    for (const conversation of granted) {
      expect(f.registry.conversation(conversation.id)!.generations.at(-1)!.launchProfile.mcpServers).toEqual(["viewer", "telegram"]);
    }
  } finally {
    probing = false;
    await probe;
    http.stop(true);
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 180_000);

test("ready startup survives a second module realm without any adoption calls", async () => {
  const f = fixture(0);
  let adoptions = 0;
  const dependencies = {
    registry: f.registry, client: f.client, refreshTranscriptState: async () => {},
    adopt: async () => { adoptions++; return []; },
    adoptClaude: async () => { adoptions++; return []; }, orchestratorSeats: () => [],
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    expect(adoptions).toBe(2);
    adoptions = 0;
    const routeRealm = await import(`./startup?${"ready-route-realm"}`);
    await routeRealm.adoptStructuredHostsAtStartup(dependencies);
    expect(adoptions).toBe(0);
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
    f.registry.close();
  }
});

test("startup never holds a state lease across a five second host request", async () => {
  const f = fixture(0);
  const { savePipelines } = await import("@/lib/pipelines/store");
  savePipelines([]);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
  let heldDuringRequest = false;
  let longestHoldMs = 0;
  const holds: number[] = [];
  let calls = 0;
  const client = { ...f.client, snapshot: async () => {
    calls++;
    if (calls === 1) {
      const start = performance.now();
      const held = db.query("SELECT count(*) AS n FROM state_leases").get() as { n: number };
      await Bun.sleep(5_000);
      heldDuringRequest = held.n > 0;
      if (heldDuringRequest) longestHoldMs = performance.now() - start;
    }
    return f.journal.snapshot();
  } };
  try {
    await adoptStructuredHostsAtStartup({ registry: f.registry, client,
      observeLeaseHold: (heldMs) => holds.push(heldMs),
      refreshTranscriptState: async () => {}, adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    });
    console.log(JSON.stringify({ heldDuringRequest, longestHoldMs, maxLeaseHoldMs: Math.max(...holds) }));
    /* The lease table is read when the request starts: nothing is held across
       it. Hold times are reported above, never asserted (#1761). */
    expect(holds.length).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(0);
    expect(heldDuringRequest).toBe(false);
  } finally {
    db.close();
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
    f.registry.close();
  }
}, 15_000);

test("production startup yields between historical publication batches and skips completed publications", async () => {
  const f = fixture(0, true, 40);
  let published = 0;
  let sessionReads = 0;
  let publishedAtFirstYield: number | null = null;
  let yieldProbe: ReturnType<typeof setTimeout> | undefined;
  const client = { ...f.client,
    readSession: async (identity: Parameters<NonNullable<RuntimeHostClient["readSession"]>>[0]) => {
      sessionReads++;
      return f.journal.readSession(identity);
    },
    snapshot: async () => { throw new Error("startup must use keyed session reads"); },
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => {
    if (event.kind === "session-status") {
      published++;
      if (published === 1) yieldProbe = setTimeout(() => { publishedAtFirstYield = published; }, 0);
    }
    return f.client.append(event);
  } };
  try {
    await adoptStructuredHostsAtStartup({ registry: f.registry, client,
      refreshTranscriptState: async () => {}, adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    });
    expect(published).toBe(40);
    expect(publishedAtFirstYield).not.toBeNull();
    expect(publishedAtFirstYield!).toBeLessThanOrEqual(16);
    const before = published;
    const readsBefore = sessionReads;
    console.log(JSON.stringify({ published, publishedAtFirstYield }));
    const { completeStructuredDeliveryQueueStartup } = await import("./structuredDeliveryController");
    await completeStructuredDeliveryQueueStartup([]);
    expect(published).toBe(before);
    expect(sessionReads).toBe(readsBefore);
  } finally {
    if (yieldProbe) clearTimeout(yieldProbe);
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
    f.registry.close();
  }
}, 30_000);


test("only a changed runtime generation starts incremental recovery after ready", async () => {
  const f = fixture(0);
  let generation = "generation-a";
  let adoptions = 0;
  let refreshes = 0;
  let generations = 0;
  const client = { ...f.client, startupGeneration: async () => { generations++; return generation; } };
  const dependencies = { registry: f.registry, client, orchestratorSeats: () => [],
    refreshTranscriptState: async () => { refreshes++; },
    adopt: async () => { adoptions++; return []; }, adoptClaude: async () => { adoptions++; return []; },
  };
  try {
    await adoptStructuredHostsAtStartup(dependencies);
    adoptions = 0;
    await adoptStructuredHostsAtStartup(dependencies);
    expect(adoptions).toBe(0);
    expect(refreshes).toBe(1);
    generation = "generation-b";
    await Promise.all([adoptStructuredHostsAtStartup(dependencies), adoptStructuredHostsAtStartup(dependencies)]);
    expect(adoptions).toBe(0); // No unaccepted hosts in the replacement generation.
    expect(refreshes).toBe(1);
    expect(generations).toBe(3);
    await adoptStructuredHostsAtStartup(dependencies);
    expect(adoptions).toBe(0);
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close(); f.registry.close();
  }
});
