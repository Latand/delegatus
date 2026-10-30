import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { serveRuntimeHost } from "@/runtime-host/socket";
import { testEndpoint } from "@/runtime-host/fixtures/testEndpoint";
import { UnixRuntimeHostClient } from "./client";
import { DeliveryProgressStore } from "./deliveryProgress";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { STRUCTURED_DELIVERY_TIMING, type StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import type { EngineHost, HostState } from "./engineHost";
import { NativeCodexQueue, type NativeQueuedSubmission } from "./nativeCodexQueue";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import { NATIVE_QUEUE_CAPABILITY } from "./codexCapabilityFlags";

afterEach(() => setSystemTime());

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(work: Promise<T> | void, timeoutMs = 1500): Promise<T | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("fresh pass did not finish while the general pass was held")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Build through the production controller, using its actual port wiring,
    the socket client, runtime handler, SQLite journal and registry. Only the
    engine transport and the general-listing barrier are synthetic. */
async function fixture(native = false, passBudgetMs = STRUCTURED_DELIVERY_TIMING.passBudgetMs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-"));
  let now = Date.parse("2026-10-30T12:00:00Z");
  setSystemTime(now);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const progress = new DeliveryProgressStore(path.join(directory, "progress.sqlite"), () => now);
  const runtime = new RuntimeHost(journal);
  let generalBarrier: ReturnType<typeof barrier> | null = null;
  let generalEntered = barrier();
  let generalObserved = barrier();
  let generalReads = 0, keyedReads = 0;
  let keyedUnavailable = false;
  let generalUnavailable = false;
  let legacyReader = false;
  const admittedAt = new Map<string, number>();
  const delivered = barrier();
  const settle = progress.settle.bind(progress);
  progress.settle = (...args: Parameters<DeliveryProgressStore["settle"]>) => {
    const result = settle(...args);
    if (args[1] === "delivered") delivered.release();
    return result;
  };
  const endpoint = testEndpoint(directory, "runtime");
  const server = serveRuntimeHost(endpoint, { handle: async (request, options) => {
    if (request.method === "effect-batch") {
      if (request.params?.conversationId) {
        keyedReads++;
        if (keyedUnavailable) return { id: request.id, ok: false, error: "synthetic keyed journal outage" };
      }
      else {
        generalReads++;
        generalObserved.release();
        if (generalBarrier) { generalEntered.release(); await generalBarrier.promise; }
        if (generalUnavailable) return { id: request.id, ok: false, error: "runtime host request timed out" };
      }
    }
    const response = await runtime.handle(legacyReader && request.method === "effect-batch"
      ? { ...request, params: { ...request.params, conversationId: undefined } } : request, options);
    if (request.method === "command" && response.ok) {
      const command = request.params?.command as { operationId?: string } | undefined;
      if (command?.operationId) admittedAt.set(command.operationId, performance.now());
    }
    return response;
  } });
  const client = new UnixRuntimeHostClient(endpoint);
  const sessionId = ["00000005", "0000", "4000", "8000", "000000000001"].join("-");
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const key = { engine: "codex" as const, sessionId };
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: null,
    launchProfile: profile, turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: new Date(now).toISOString() }]);
  const conversationId = registry.conversationForPath(artifactPath)!.id;
  registry.upsert({ key, artifactPath, cwd: directory, accountId: null, launchProfile: profile, status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:fresh", process: null, eventCursor: 0,
      protocolVersion: "fake-v1", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 0, claimOwner: null, pendingAction: null });
  const fake = new FakeEngineHost();
  let state: HostState = { ...await fake.health(), sessionKey: key.sessionId,
    activeFlags: native ? [NATIVE_QUEUE_CAPABILITY] : [] };
  const sends: string[] = [];
  const sent = barrier();
  let sendBarrier: ReturnType<typeof barrier> | null = null;
  let onDispatch = () => {};
  const host = Object.assign(fake, {
    health: async () => ({ ...state }),
    onStateChange: () => () => {},
    send: async (entry: Parameters<FakeEngineHost["send"]>[0]) => {
      sends.push(entry.id); onDispatch(); sent.release();
      if (sendBarrier) await sendBarrier.promise;
      // Count every actuation before the fake's deduplication can hide one.
      return FakeEngineHost.prototype.send.call(fake, entry);
    },
  });
  let nativeReads = 0;
  if (native) {
    const items: NativeQueuedSubmission[] = [];
    const nativeQueue: NonNullable<EngineHost["nativeQueue"]> = {
      queue: new NativeCodexQueue({ rpc: async (method, params) => {
        if (method === "thread/queue/list") { nativeReads++; return { data: items, nextCursor: null }; }
        if (method !== "thread/queue/add") throw new Error(`unexpected native mutation: ${method}`);
        const item = { id: `native-${items.length}`, clientUserMessageId: params.clientUserMessageId as string,
          input: params.input as NativeQueuedSubmission["input"] };
        items.push(item); sends.push(item.clientUserMessageId); onDispatch(); sent.release();
        if (sendBarrier) await sendBarrier.promise;
        return { queuedSubmission: item };
      } }, key.sessionId),
      prepare: async (_entry, version) => [{ type: "text", text: version.text }],
      evidence: async () => { nativeReads++; return null; },
      sendWithdrawn: async () => { throw new Error("unexpected guarded native start"); },
    };
    Object.assign(host, { nativeQueue });
  }
  const cleanup = async () => {
    generalBarrier?.release(); generalBarrier = null;
    sendBarrier?.release(); sendBarrier = null;
    await bindStructuredDeliveryQueue([], { registry, client: null });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    progress.close(); journal.close(); registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
    setSystemTime();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    await bindStructuredDeliveryQueue([{ key, host }], { registry, client, progress,
      watchdogIntervalMs: 0, settlementSweepMs: 0, hostlessSettleIntervalMs: 0,
      queueTiming: { ...STRUCTURED_DELIVERY_TIMING, passBudgetMs, now: () => now } });
    await kickStructuredDeliveryQueue(true);
    expect(registry.conversation(conversationId)!.generations.at(-1)!.id).toBe(key.sessionId);
    const queue = (process as typeof process & { __llvStructuredDeliveryController: { activeQueue: StructuredDeliveryQueue } })
      .__llvStructuredDeliveryController.activeQueue;
    return { registry, journal, client, progress, queue, host, sends, sent, delivered, admittedAt, conversationId, endpoint, key, cleanup,
      reads: () => ({ general: generalReads, keyed: keyedReads }),
      nativeReads: () => nativeReads,
      unavailable(value: boolean) { keyedUnavailable = value; },
      unavailableGeneral(value: boolean) { generalUnavailable = value; },
      legacy() { legacyReader = true; },
      observeGeneral() { generalObserved = barrier(); return generalObserved.promise; },
      busy(value: boolean) { state = { ...state, status: value ? "active" : "idle", activeTurnRef: value ? "busy-turn" : null }; },
      advance(ms: number) { now += ms; },
      holdSend() { sendBarrier = barrier(); return sendBarrier; },
      onDispatch(callback: () => void) { onDispatch = callback; },
      async holdGeneral() {
        generalBarrier = barrier(); generalEntered = barrier();
        const run = kickStructuredDeliveryQueue();
        await generalEntered.promise;
        return { run, release: () => { generalBarrier?.release(); generalBarrier = null; } };
      },
      admit: (id: string, kick = true) => enqueueStructuredMessage({ path: artifactPath, conversationId,
        kind: "send", policy: "queue", turnId: null, operationId: id, clientMessageId: id,
        text: `instruction ${id}`, hasImages: false }, { enabled: () => true, client: () => client,
        registry: () => registry, progress, kick: kick ? kickStructuredDeliveryQueue : () => {} }),
    };
  } catch (error) { await cleanup(); throw error; }
}

test("fresh admission reaches an idle bound recipient while the general pass is held", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral();
    const before = f.reads();
    expect(await f.admit("fresh-idle")).toMatchObject({ ok: true, operationId: "fresh-idle" });
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends, JSON.stringify(f.journal.operationResult("fresh-idle"))).toEqual(["fresh-idle"]);
    expect(f.reads().general).toBe(before.general);
    expect(f.reads().keyed).toBeGreaterThan(before.keyed);
    expect(f.journal.operationResult("fresh-idle")?.receipt.status).toBe("delivered");
  } finally {
    general?.release(); await general?.run;
    if (!f.sends.length) console.error("fresh fixture refusal", JSON.stringify(f.journal.operationResult("fresh-idle")));
    await f.cleanup();
  }
}, 5000);

test("an idle fresh native send dispatches without starting a general native reconciliation", async () => {
  const f = await fixture(true);
  const reconcile = spyOn(NativeQueueExecutor.prototype, "reconcile");
  let reconcilesAtDispatch: number | null = null;
  try {
    f.onDispatch(() => { reconcilesAtDispatch = reconcile.mock.calls.length; });
    await f.admit("native-fresh");
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends).toEqual(["native-fresh"]);
    expect(reconcilesAtDispatch).toBe(0);
  } finally { reconcile.mockRestore(); await f.cleanup(); }
}, 5000);

test("fresh busy send stays queued, and an idle retry preserves recipient order", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral(); f.busy(true);
    await f.admit("busy-first");
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.reads().keyed).toBeGreaterThan(0);
    expect(f.sends).toEqual([]);
    expect(f.journal.operationResult("busy-first")?.receipt.status).toBe("queued");
    f.busy(false);
    await f.admit("idle-second");
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends).toEqual(["busy-first", "idle-second"]);
  } finally { general?.release(); await general?.run; await f.cleanup(); }
}, 5000);

test("a concurrent general pass and repeated fresh kicks actuate each journal send once", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  const sending = f.holdSend();
  try {
    general = await f.holdGeneral();
    await f.admit("racing-send");
    const fresh = kickStructuredDeliveryQueue(true, f.conversationId);
    await bounded(f.sent.promise);
    expect(f.sends).toEqual(["racing-send"]);
    general.release();
    await bounded(general.run);
    sending.release();
    await Promise.all([fresh, kickStructuredDeliveryQueue(true, f.conversationId), kickStructuredDeliveryQueue()]);
    expect(f.sends).toEqual(["racing-send"]);
    expect(f.journal.replay(0).events.filter(event => event.kind === "receipt"
      && event.payload.operationId === "racing-send" && event.payload.status === "delivering")).toHaveLength(1);
  } finally { sending.release(); general?.release(); await general?.run; await f.cleanup(); }
}, 5000);

test("the scoped socket reader pages only the recipient and retains its ordered controls", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 110; index++) f.journal.executeOperation({ kind: "send", operationId: `foreign-${index}`,
      conversationId: "conversation_foreign", idempotencyKey: `foreign-${index}`, text: "unrelated", policy: "queue" });
    await f.admit("scoped-earlier", false);
    f.journal.executeOperation({ kind: "interrupt", operationId: "scoped-control", conversationId: f.conversationId, idempotencyKey: "scoped-control" });
    const page = await f.client.effectBatch(undefined, 0, { conversationId: f.conversationId });
    expect(page.map(effect => effect.id)).toEqual(["effect:scoped-earlier", "effect:scoped-control"]);
    expect(await f.client.effectBatch(undefined, page[0]!.eventSeq, { conversationId: f.conversationId }))
      .toEqual([page[1]!]);
    await expect(f.client.effectBatch(undefined, 0, { conversationId: "" })).rejects.toThrow("conversation is invalid");
  } finally { await f.cleanup(); }
}, 5000);

test("a failed keyed read holds delivery and a due watchdog retry recovers the same operation", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral(); f.unavailable(true);
    await f.admit("keyed-outage", false);
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends).toEqual([]);
    expect(f.progress.get("keyed-outage")?.waitReason).toBe("evidence-unreadable");
    expect(f.journal.operationResult("keyed-outage")?.receipt.status).toBe("queued");
    f.unavailable(false); f.advance(10_000);
    await bounded(f.queue.tick());
    expect(f.sends).toEqual(["keyed-outage"]);
  } finally { general?.release(); await general?.run; await f.cleanup(); }
}, 5000);

test("a legacy listener cannot make foreign pages hide a fresh recipient or actuate another recipient", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  const foreign: string[] = [];
  try {
    general = await f.holdGeneral(); f.legacy();
    for (let index = 0; index < 110; index++) {
      const id = `legacy-foreign-${index}`;
      f.journal.executeOperation({ kind: "send", operationId: id,
        conversationId: "conversation_foreign", idempotencyKey: id, text: "unrelated", policy: "queue" });
      foreign.push(id);
    }
    await f.admit("legacy-fresh");
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends).toEqual(["legacy-fresh"]);
    expect(f.journal.operationResult("legacy-foreign-0")?.receipt.reason).toBeNull();
    expect(f.reads().keyed).toBeGreaterThanOrEqual(2);
  } finally {
    for (const id of foreign) f.journal.transitionOperation(id, "failed", { reason: "fixture cleanup" });
    general?.release(); await general?.run; await f.cleanup();
  }
}, 5000);

test("a successful keyed kick preserves the general retry already scheduled by a failed read", async () => {
  const f = await fixture();
  try {
    f.unavailable(true);
    await f.admit("retry-owner", false);
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    const general = f.observeGeneral();
    f.unavailable(false);
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    await bounded(general);
    expect(f.sends).toEqual(["retry-owner"]);
  } finally { await f.cleanup(); }
}, 5000);

test("a cached empty general listing cannot abandon an in-flight fresh dispatch", async () => {
  const f = await fixture(false, 5);
  const sending = f.holdSend();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral();
    await f.admit("cached-absence", false);
    const fresh = kickStructuredDeliveryQueue(true, f.conversationId);
    await bounded(f.sent.promise);
    // Exhaust the pass budget while its target lane still owns send().
    await bounded(fresh);
    f.advance(10_000); f.unavailableGeneral(true);
    general.release(); await bounded(general.run);
    // A later general pass also sees only the old cached empty body.
    await bounded(kickStructuredDeliveryQueue(true));
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.journal.operationResult("cached-absence")?.receipt.status).toBe("delivering");
    expect(f.sends).toEqual(["cached-absence"]);
    f.unavailableGeneral(false); sending.release();
    await bounded(f.delivered.promise);
    expect(f.journal.operationResult("cached-absence")?.receipt.status).toBe("delivered");
  } finally { sending.release(); general?.release(); await general?.run; await f.cleanup(); }
}, 5000);

test("a fresh executor in another process cannot dispatch a completed journal send again", async () => {
  const f = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await f.admit("restart-send");
    await bounded(kickStructuredDeliveryQueue(true, f.conversationId));
    expect(f.sends).toEqual(["restart-send"]);
    const script = `
      import { AgentRegistry } from ${JSON.stringify(import.meta.resolve("../agent/registry.ts"))};
      import { UnixRuntimeHostClient } from ${JSON.stringify(import.meta.resolve("./client.ts"))};
      import { FakeEngineHost } from ${JSON.stringify(import.meta.resolve("./fixtures/fakeEngineHost.ts"))};
      import { bindStructuredDeliveryQueue } from ${JSON.stringify(import.meta.resolve("./structuredDeliveryController.ts"))};
      import { kickStructuredDeliveryQueue } from ${JSON.stringify(import.meta.resolve("./structuredDeliverySignal.ts"))};
      const [filename, endpoint, conversationId, keyJson] = process.argv.slice(1);
      const key = JSON.parse(keyJson);
      const registry = new AgentRegistry(filename);
      const client = new UnixRuntimeHostClient(endpoint);
      const fake = new FakeEngineHost();
      const initial = await fake.health();
      const host = Object.assign(fake, { health: async () => ({ ...initial, sessionKey: key.sessionId }), onStateChange: () => () => {} });
      try {
        await bindStructuredDeliveryQueue([{ key, host }],
          { registry, client, watchdogIntervalMs: 0, settlementSweepMs: 0, hostlessSettleIntervalMs: 0 });
        await kickStructuredDeliveryQueue(true, conversationId);
        console.log(JSON.stringify({ writes: fake.ledger.writes.map(entry => entry.id) }));
      } finally { await bindStructuredDeliveryQueue([], { registry, client: null }); registry.close(); }
    `;
    const spawned = Bun.spawn([process.execPath, "-e", script, f.registry.filename, f.endpoint, f.conversationId, JSON.stringify(f.key)], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    child = spawned;
    const output = new Response(spawned.stdout).text();
    const errors = new Response(spawned.stderr).text();
    await bounded(spawned.exited, 10_000);
    expect(await spawned.exited, await errors).toBe(0);
    expect(JSON.parse((await output).trim())).toEqual({ writes: [] });
    expect(f.sends).toEqual(["restart-send"]);
  } finally {
    if (child?.exitCode === null) child.kill();
    await child?.exited;
    await f.cleanup();
  }
}, 15_000);

test.skipIf(process.env.LLV_FRESH_ADMISSION_MEASURE !== "1")("synthetic admission to dispatch measurement", async () => {
  const samples: number[] = [];
  const load = { logicalCpus: os.cpus().length, loadAverage: os.loadavg() };
  for (let run = 0; run < 20; run++) {
    const f = await fixture();
    let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      general = await f.holdGeneral();
      await f.admit("measured-send", false);
      const admitted = f.admittedAt.get("measured-send")!;
      const dispatched = f.sent.promise.then(() => performance.now() - admitted);
      // Identical synthetic general-pass occupancy on both revisions. This
      // timer is workload, never a correctness threshold or a production model.
      timer = setTimeout(general.release, 50);
      await kickStructuredDeliveryQueue(true, f.conversationId);
      samples.push(await dispatched);
    } finally { clearTimeout(timer); general?.release(); await general?.run; await f.cleanup(); }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(JSON.stringify({ measurement: "fresh-admission", n: samples.length, syntheticGeneralPassMs: 50,
    load, endLoadAverage: os.loadavg(), samplesMs: samples,
    p50: sorted[9], p95: sorted[18], max: sorted[19] }));
}, 60000);

test("the watchdog reschedules a lost fresh wake without waiting for the general pass", async () => {
  const f = await fixture();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral();
    await f.admit("lost-wake", false);
    f.progress.note("lost-wake", f.conversationId, { kind: "send", waitReason: "queued", nextWakeMs: 0 });
    f.advance(10_000);
    await bounded(f.queue.tick());
    expect(f.sends).toEqual(["lost-wake"]);
    expect(f.journal.operationResult("lost-wake")?.receipt.status).toBe("delivered");
  } finally { general?.release(); await general?.run; await f.cleanup(); }
}, 5000);

test("native reconciliation and a fresh native add retain exactly one dispatch claim", async () => {
  const f = await fixture(true);
  const sending = f.holdSend();
  let general: Awaited<ReturnType<typeof f.holdGeneral>> | undefined;
  try {
    general = await f.holdGeneral();
    await f.admit("native-race");
    const fresh = kickStructuredDeliveryQueue(true, f.conversationId);
    await bounded(f.sent.promise);
    general.release();
    await bounded(general.run);
    // Start another real native reconcile while queue/add's ACK is held.
    await bounded(kickStructuredDeliveryQueue());
    sending.release();
    await bounded(fresh);
    await kickStructuredDeliveryQueue(true, f.conversationId);
    expect(f.nativeReads()).toBeGreaterThan(0);
    expect(f.sends).toEqual(["native-race"]);
    expect(f.journal.nativeQueueRead(f.conversationId)[0]?.state).toBe("queued");
    expect(f.journal.replay(0).events.filter(event => event.kind === "receipt"
      && event.payload.operationId === "native-race" && event.payload.status === "delivering")).toHaveLength(1);
  } finally { sending.release(); general?.release(); await general?.run; await f.cleanup(); }
}, 5000);
