import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, RegistryWriterBusyError, type AgentRegistryEntry, type ProcessIdentity, type RegistryFile, type StructuredHostColumns } from "@/lib/agent/registry";

import type { ClaudeStreamBrokerHost } from "./claudeStreamBrokerHost";
import type { CodexAppServerHost } from "./codexAppServerHost";
import type { HostState } from "./engineHost";
import { bindClaudeHostPersistence, bindCodexHostPersistence, DEFAULT_CURSOR_DEBOUNCE_MS, type StructuredHostPersistenceOptions, type StructuredHostPersistenceStop } from "./registry";
import { beginLegacySpawnReceiptFixture } from "@/lib/agent/registryTestFixtures";

const KEY = { engine: "codex" as const, sessionId: "coalesced-host" };

function hostState(overrides: Partial<HostState> = {}): HostState {
  return {
    status: "idle",
    sessionKey: KEY.sessionId,
    endpoint: "stdio:4242",
    pid: 4242,
    processStartIdentity: "4242:100",
    eventCursor: 0,
    protocolVersion: "1.0.0",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
    ...overrides,
  };
}

class RecordingRegistry {
  checkpointError: Error | null = null;
  releaseError: Error | null = null;
  readonly checkpointTimes: number[] = [];
  private completedCheckpoints = 0;
  private readonly checkpointWaiters = new Map<number, () => void>();
  waitForCheckpoint(count: number): Promise<void> {
    if (this.completedCheckpoints >= count) return Promise.resolve();
    return new Promise(resolve => { this.checkpointWaiters.set(count, resolve); });
  }
  private nextWrite: { enter(): void; released: Promise<void> } | null = null;
  pauseNextWrite() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.nextWrite = { enter, released };
    return { entered, release };
  }
  async deliveryWriteOrBusy<T>(correlation: { label: string }, write: () => T): Promise<T> {
    const checkpoint = correlation.label === "registry.host-checkpoint";
    if (checkpoint) this.checkpointTimes.push(performance.now());
    const gate = this.nextWrite;
    this.nextWrite = null;
    if (gate) { gate.enter(); await gate.released; }
    try {
      if (checkpoint && this.checkpointError) throw this.checkpointError;
      if (correlation.label === "registry.host-release" && this.releaseError) throw this.releaseError;
      return write();
    } finally {
      if (checkpoint) {
        this.completedCheckpoints += 1;
        this.checkpointWaiters.get(this.completedCheckpoints)?.();
        this.checkpointWaiters.delete(this.completedCheckpoints);
      }
    }
  }

  readonly writes: Array<{ columns: StructuredHostColumns; status: string; releaseClaim: boolean }> = [];
  readonly releases: number[] = [];
  acceptWrites = true;
  /** A refused write whose row is held by a captured termination tree. */
  heldByTermination = false;

  ownsStructuredHostClaim(): boolean { return true; }
  structuredHostWriteHeldByTermination(): boolean { return this.heldByTermination; }

  setStructuredHostClaimed(
    _key: unknown,
    columns: StructuredHostColumns,
    status: string,
    _claimOwner: string,
    writerClaimEpoch: number,
    releaseClaim = false,
  ): AgentRegistryEntry | null {
    this.writes.push({ columns: structuredClone(columns), status, releaseClaim });
    if (!this.acceptWrites) return null;
    return { structuredHost: columns, status, claimEpoch: writerClaimEpoch } as AgentRegistryEntry;
  }

  releaseStructuredHostClaim(_key: unknown, _owner: string, epoch: number): void {
    this.releases.push(epoch);
  }
}

class RecordingHost {
  private readonly listeners = new Set<(state: HostState) => void>();
  private state = hostState();
  releaseCalls = 0;
  subscribeState: Partial<HostState> | null = null;
  terminationCapture: ((root: number, tree: readonly ProcessIdentity[]) => boolean | Promise<boolean>) | null = null;
  setTerminationCapture(listener: RecordingHost["terminationCapture"]): void { this.terminationCapture = listener; }

  setWriterFence(): void {}
  async health(): Promise<HostState> { return structuredClone(this.state); }
  onStateChange(listener: (state: HostState) => void): () => void {
    this.listeners.add(listener);
    if (this.subscribeState) this.emit(this.subscribeState);
    return () => this.listeners.delete(listener);
  }
  async release(): Promise<void> { this.releaseCalls += 1; }

  emit(overrides: Partial<HostState>): void {
    this.state = hostState({ ...this.state, ...overrides });
    for (const listener of this.listeners) listener(structuredClone(this.state));
  }
}

type Binder = (
  registry: AgentRegistry,
  host: RecordingHost,
  options?: StructuredHostPersistenceOptions,
) => Promise<StructuredHostPersistenceStop>;

const binders: Array<[string, Binder]> = [
  ["Codex", (registry, host, options) => bindCodexHostPersistence(
    registry,
    KEY,
    host as unknown as CodexAppServerHost,
    "writer",
    7,
    "unhosted",
    options,
  )],
  ["Claude", (registry, host, options) => bindClaudeHostPersistence(
    registry,
    { ...KEY, engine: "claude" },
    host as unknown as ClaudeStreamBrokerHost,
    "writer",
    7,
    "unhosted",
    options,
  )],
];

const drainCheckpoints = () => new Promise<void>(resolve => setImmediate(resolve));

for (const [engine, bind] of binders) {
  test(`${engine} orders the initial checkpoint before the synchronous subscription state`, async () => {
    const registry = new RecordingRegistry();
    const host = new RecordingHost();
    host.subscribeState = { eventCursor: 2, status: "active", activeTurnRef: "subscription-turn" };
    const stop = await bind(registry as unknown as AgentRegistry, host);
    try {
      await stop.flush();
      expect(registry.writes.map(write => write.columns.eventCursor)).toEqual([0, 2]);
      expect(host.releaseCalls).toBe(0);
    } finally { await stop(); }
  });

  test(`${engine} an actual SQLite checkpoint deadline keeps the active host and later commits`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-checkpoint-contention-"));
    const filename = path.join(directory, "registry.json");
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteWriterDeadlineMs: 20 });
    const host = new RecordingHost();
    const key = { ...KEY, engine: engine === "Codex" ? "codex" as const : "claude" as const };
    let peer: Database | undefined;
    let locked = false;
    let stop: StructuredHostPersistenceStop | undefined;
    let committed!: () => void;
    const checkpoint = new Promise<void>(resolve => { committed = resolve; });
    const setClaimed = registry.setStructuredHostClaimed.bind(registry);
    const writes = spyOn(registry, "setStructuredHostClaimed").mockImplementation((...args) => {
      const result = setClaimed(...args);
      if (result) committed();
      return result;
    });
    try {
      registry.upsert({ key, artifactPath: "/sessions/checkpoint-contention.jsonl", cwd: "/repo", accountId: null,
        status: "live", host: null, claimOwner: "writer", claimEpoch: 7, pendingAction: null,
        structuredHost: { kind: engine === "Codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:4242", process: null,
          eventCursor: 0, writerClaimEpoch: 7, protocolVersion: "1", activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
      host.emit({ eventCursor: 8, status: "active", activeTurnRef: "turn-live" });
      peer = new Database(path.join(directory, "registry.sqlite"));
      peer.exec("BEGIN IMMEDIATE");
      locked = true;
      stop = await bind(registry, host, { checkpointRetryMs: 20 });
      expect(host.releaseCalls).toBe(0);
      expect(registry.readOnlySnapshot().entries[`${key.engine}:${key.sessionId}`]?.claimOwner).toBe("writer");
      expect(writes).not.toHaveBeenCalled();
      peer.exec("ROLLBACK");
      locked = false;
      await checkpoint;
      await drainCheckpoints();
      expect(host.releaseCalls).toBe(0);
      await stop();
      registry.close();
      const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
      try {
        expect(reopened.readOnlySnapshot().entries[`${key.engine}:${key.sessionId}`]?.structuredHost)
          .toMatchObject({ eventCursor: 8, activeTurnRef: "turn-live" });
      } finally { reopened.close(); }
    } finally {
      if (locked) peer?.exec("ROLLBACK");
      await stop?.();
      writes.mockRestore();
      peer?.close();
      registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const trigger of ["initial", "cursor", "material", "terminal"] as const) {
    for (const error of [new RegistryWriterBusyError("registry.host-checkpoint"), new Error("checkpoint write timed out")]) {
      test(`${engine} retries a ${trigger} checkpoint after ${error.name}: ${error.message}`, async () => {
        const registry = new RecordingRegistry();
        const host = new RecordingHost();
        const options = { cursorDebounceMs: 1, checkpointRetryMs: 20 };
        let stop: StructuredHostPersistenceStop | undefined;
        try {
          if (trigger === "initial") registry.checkpointError = error;
          stop = await bind(registry as unknown as AgentRegistry, host, options);
          const prior = trigger === "initial" ? 0 : 1;
          if (trigger !== "initial") {
            registry.checkpointError = error;
            host.emit(trigger === "cursor" ? { eventCursor: 1 }
              : trigger === "material" ? { eventCursor: 1, status: "active", activeTurnRef: "turn-live" }
              : { eventCursor: 1, status: "unhosted", pid: null, processStartIdentity: null });
          }
          await registry.waitForCheckpoint(prior + 1);
          await drainCheckpoints();
          expect(host.releaseCalls).toBe(0);
          expect(registry.releases).toEqual([]);
          await registry.waitForCheckpoint(prior + 2);
          await drainCheckpoints();
          expect(host.releaseCalls).toBe(0);
          expect(registry.releases).toEqual([]);
          expect(registry.checkpointTimes[prior + 1]! - registry.checkpointTimes[prior]!).toBeGreaterThanOrEqual(18);
          registry.checkpointError = null;
          await registry.waitForCheckpoint(prior + 3);
          await drainCheckpoints();
          expect(registry.writes.at(-1)).toMatchObject({
            columns: { eventCursor: trigger === "initial" ? 0 : 1 },
            releaseClaim: trigger === "terminal",
          });
          expect(host.releaseCalls).toBe(0);
        } finally {
          registry.checkpointError = null;
          await stop?.();
        }
      });
    }
  }

  for (const trigger of ["initial", "cursor", "material", "terminal"] as const) {
    test(`${engine} releases on a proven lost claim during ${trigger} admission even if claim cleanup is busy`, async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const options = { cursorDebounceMs: 1, checkpointRetryMs: 20 };
      let stop: StructuredHostPersistenceStop | undefined;
      if (trigger !== "initial") stop = await bind(registry as unknown as AgentRegistry, host, options);
      const gate = registry.pauseNextWrite();
      const initial = trigger === "initial" ? bind(registry as unknown as AgentRegistry, host, options) : null;
      if (!initial) host.emit(trigger === "cursor" ? { eventCursor: 1 }
        : trigger === "material" ? { eventCursor: 1, status: "active", activeTurnRef: "turn-live" }
        : { eventCursor: 1, status: "unhosted", pid: null, processStartIdentity: null });
      try {
        await gate.entered;
        registry.acceptWrites = false;
        registry.releaseError = new RegistryWriterBusyError("registry.host-release");
        gate.release();
        if (initial) await expect(initial).rejects.toThrow("writer claim is stale");
        else {
          await registry.waitForCheckpoint(2);
          await drainCheckpoints();
        }
        expect(host.releaseCalls).toBe(1);
        const count = registry.checkpointTimes.length;
        host.emit({ eventCursor: 2 });
        await stop?.flush();
        expect(registry.checkpointTimes).toHaveLength(count);
      } finally {
        gate.release();
        registry.releaseError = null;
        await stop?.();
      }
    });
  }

  for (const operation of ["flush", "stop"] as const) {
    test(`${engine} a busy explicit ${operation} keeps the claim and retries its pending checkpoint`, async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 30_000, checkpointRetryMs: 20 });
      try {
        registry.checkpointError = new RegistryWriterBusyError("registry.host-checkpoint");
        host.emit({ eventCursor: 4 });
        await expect(operation === "flush" ? stop.flush() : stop()).rejects.toThrow("write lock");
        expect(host.releaseCalls).toBe(0);
        expect(registry.releases).toEqual([]);
        registry.checkpointError = null;
        await registry.waitForCheckpoint(3);
        await drainCheckpoints();
        expect(registry.writes.at(-1)?.columns.eventCursor).toBe(4);
      } finally {
        registry.checkpointError = null;
        await stop();
      }
    });
  }

  test(`${engine} stopping a binding drops its held checkpoint and later flushes stay inert`, async () => {
    const registry = new RecordingRegistry();
    const host = new RecordingHost();
    const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 30_000 });
    registry.acceptWrites = false;
    registry.heldByTermination = true;
    host.emit({ eventCursor: 4 });
    await stop();
    expect(registry.releases).toEqual([7]);
    const count = registry.checkpointTimes.length;
    await stop.flush();
    expect(registry.checkpointTimes).toHaveLength(count);
    expect(host.releaseCalls).toBe(0);
  });

  test(`${engine} a busy terminal checkpoint encountered during stop retains its own termination capture`, async () => {
    const registry = new RecordingRegistry();
    const host = new RecordingHost();
    const key = { ...KEY, engine: engine === "Codex" ? "codex" as const : "claude" as const };
    const root = { pid: 4242, startIdentity: "4242:100", bootEpoch: "fixture-boot" };
    let captureSettling = false;
    Object.assign(registry, {
      startupHostSnapshot: () => {
        if (captureSettling) throw new Error("captured tree settlement is temporarily unavailable");
        return { entries: { [`${key.engine}:${key.sessionId}`]: {
          claimOwner: "writer", claimEpoch: 7, structuredHost: { process: root, writerClaimEpoch: 7 },
        } } } as unknown as RegistryFile;
      },
      captureStructuredTerminationSurvivors: () => ({ added: [root] }),
    });
    const stop = await bind(registry as unknown as AgentRegistry, host, { checkpointRetryMs: 30_000, terminationRetryMs: 20 });
    try {
      expect(await host.terminationCapture!(4242, [root])).toBe(true);
      registry.checkpointError = new RegistryWriterBusyError("registry.host-checkpoint");
      host.emit({ eventCursor: 5, status: "unhosted", pid: null, processStartIdentity: null });
      await registry.waitForCheckpoint(2);
      await drainCheckpoints();
      registry.checkpointError = null;
      registry.acceptWrites = false;
      registry.heldByTermination = true;
      captureSettling = true;
      await stop();
      expect(registry.releases).toEqual([]);
      expect(host.releaseCalls).toBe(0);
    } finally {
      registry.checkpointError = null;
      registry.acceptWrites = true;
      registry.heldByTermination = false;
      captureSettling = false;
      await registry.waitForCheckpoint(4);
      await drainCheckpoints();
      await stop();
    }
    expect(registry.writes.at(-1)).toMatchObject({ columns: { eventCursor: 5 }, releaseClaim: true });
    expect(registry.releases).toEqual([]);
  });

  for (const older of ["initial", "material", "cursor"] as const) {
    test(`${engine} a busy ${older} write cannot retry over a newer material state`, async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const options = { cursorDebounceMs: 1, checkpointRetryMs: 20 };
      let stop: StructuredHostPersistenceStop | undefined;
      if (older !== "initial") stop = await bind(registry as unknown as AgentRegistry, host, options);
      const gate = registry.pauseNextWrite();
      try {
        registry.checkpointError = new RegistryWriterBusyError("registry.host-checkpoint");
        const initial = older === "initial" ? bind(registry as unknown as AgentRegistry, host, options) : null;
        if (!initial) host.emit(older === "cursor" ? { eventCursor: 1 } : { eventCursor: 1, status: "active", activeTurnRef: "turn-old" });
        await gate.entered;
        host.emit({ eventCursor: 2, status: "attention", pendingAttention: ["latest"] });
        gate.release();
        if (initial) stop = await initial;
        const prior = older === "initial" ? 0 : 1;
        await registry.waitForCheckpoint(prior + 2);
        await drainCheckpoints();
        registry.checkpointError = null;
        await registry.waitForCheckpoint(prior + 3);
        await drainCheckpoints();
        expect(registry.writes.map(write => write.columns.eventCursor)).toEqual(older === "initial" ? [2] : [0, 2]);
        expect(registry.writes.at(-1)?.columns.pendingAttention).toEqual(["latest"]);
        expect(host.releaseCalls).toBe(0);
      } finally {
        gate.release();
        registry.checkpointError = null;
        await stop?.();
      }
    });
  }
}

for (const [engine, bind] of binders) for (const older of ["material", "cursor"] as const) {
  test(`${engine} a held ${older} checkpoint does not revive state superseded during admission`, async () => {
    const registry = new RecordingRegistry();
    const host = new RecordingHost();
    const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: older === "cursor" ? 1 : 10_000 });
    const gate = registry.pauseNextWrite();
    registry.acceptWrites = false;
    registry.heldByTermination = true;
    try {
      host.emit(older === "cursor" ? { eventCursor: 1 } : { eventCursor: 1, status: "active", activeTurnRef: "turn-1" });
      await gate.entered;
      host.emit({ eventCursor: 2, status: "attention", pendingAttention: ["newest-approval"] });
      gate.release();
      // The admitted jobs have no I/O after this barrier is released. Drain
      // their microtasks before allowing the retained checkpoint to commit.
      await new Promise<void>(resolve => setImmediate(resolve));
      registry.acceptWrites = true;
      registry.heldByTermination = false;
      await stop.flush();
      expect(registry.writes.at(-1)?.columns).toMatchObject({ eventCursor: 2, pendingAttention: ["newest-approval"] });
      expect(host.releaseCalls).toBe(0);
    } finally {
      gate.release();
      registry.acceptWrites = true;
      registry.heldByTermination = false;
      await stop();
    }
  });
}

test("production cursor checkpoints stay bounded to two writes per minute", () => {
  expect(DEFAULT_CURSOR_DEBOUNCE_MS).toBe(30_000);
});

for (const [engine, bind] of binders) {
  describe(`${engine} structured host persistence`, () => {
    test("bounds registry mutations across ten streaming lanes", async () => {
      const lanes = await Promise.all(Array.from({ length: 10 }, async () => {
        const registry = new RecordingRegistry();
        const host = new RecordingHost();
        const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 20 });
        return { registry, host, stop };
      }));

      for (let eventCursor = 1; eventCursor <= 100; eventCursor += 1) {
        for (const lane of lanes) lane.host.emit({ eventCursor });
      }

      expect(lanes.reduce((sum, lane) => sum + lane.registry.writes.length, 0)).toBe(10);
      await Bun.sleep(35);
      expect(lanes.reduce((sum, lane) => sum + lane.registry.writes.length, 0)).toBe(20);
      expect(lanes.every((lane) => lane.registry.writes.at(-1)?.columns.eventCursor === 100)).toBeTrue();
      for (const lane of lanes) await lane.stop();
    });

    test("coalesces cursor-only events into one trailing registry mutation", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 20 });

      for (let eventCursor = 1; eventCursor <= 20; eventCursor += 1) host.emit({ eventCursor });

      expect(registry.writes).toHaveLength(1);
      await Bun.sleep(35);
      expect(registry.writes).toHaveLength(2);
      expect(registry.writes.at(-1)?.columns.eventCursor).toBe(20);
      await stop();
    });

    test("persists material and terminal changes immediately with the latest cursor", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 100 });

      host.emit({ eventCursor: 1 });
      host.emit({ eventCursor: 2, status: "active", activeTurnRef: "turn-1" });
      await stop.flush();
      expect(registry.writes).toHaveLength(2);
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 2, activeTurnRef: "turn-1" },
        status: "live",
      });

      host.emit({ eventCursor: 3, status: "attention", pendingAttention: ["approval-1"] });
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 3, pendingAttention: ["approval-1"] },
        status: "live",
      });
      host.emit({ eventCursor: 4, status: "active", pendingAttention: [], activeFlags: ["waiting"] });
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 4, activeFlags: ["waiting"] },
        status: "live",
      });
      host.emit({ eventCursor: 5 });
      host.emit({
        eventCursor: 6,
        status: "unhosted",
        endpoint: "stdio:released",
        /* The wrapper may still be alive when it releases ownership. The
           terminal registry projection must sever that stale process pointer. */
        pid: 4242,
        processStartIdentity: "4242:100",
        activeTurnRef: null,
      });
      await stop.flush();
      expect(registry.writes).toHaveLength(5);
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({
        columns: { eventCursor: 6, process: null },
        status: "unhosted",
        releaseClaim: true,
      });
      await Bun.sleep(120);
      await stop.flush();
      expect(registry.writes).toHaveLength(5);
    });

    test("flushes the newest cursor before an explicit persistence stop", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 100 });

      host.emit({ eventCursor: 8 });
      host.emit({ eventCursor: 9 });
      await stop();

      expect(registry.writes.map((write) => write.columns.eventCursor)).toEqual([0, 9]);
      expect(registry.releases).toEqual([7]);
      await Bun.sleep(120);
      expect(registry.writes).toHaveLength(2);
    });

    test("releases the host when a trailing write loses its claim", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 10 });

      registry.acceptWrites = false;
      host.emit({ eventCursor: 1 });
      await Bun.sleep(25);

      expect(host.releaseCalls).toBe(1);
      expect(registry.releases).toEqual([7]);
    });

    test("keeps the host when a captured termination tree refuses its checkpoint, and lands it once the row is free", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 10 });

      registry.acceptWrites = false;
      registry.heldByTermination = true;
      host.emit({ eventCursor: 1 });
      await Bun.sleep(45);
      // Refused every period, and each refusal waits for the next one.
      expect(registry.writes.length).toBeGreaterThanOrEqual(3);
      expect(host.releaseCalls).toBe(0);
      expect(registry.releases).toEqual([]);

      // A material change is held the same way: the turn it opens is not lost with the host.
      host.emit({ eventCursor: 2, status: "active", activeTurnRef: "turn-1" });
      expect(host.releaseCalls).toBe(0);

      registry.acceptWrites = true;
      registry.heldByTermination = false;
      await Bun.sleep(25);
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({ columns: { eventCursor: 2, activeTurnRef: "turn-1" }, status: "live" });
      expect(host.releaseCalls).toBe(0);
      await stop();
      expect(registry.releases).toEqual([7]);
    });

    test("a terminal write refused under a captured tree still ends the binding", async () => {
      const registry = new RecordingRegistry();
      const host = new RecordingHost();
      const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 10 });

      registry.acceptWrites = false;
      registry.heldByTermination = true;
      host.emit({ eventCursor: 3, status: "unhosted", endpoint: "stdio:released", pid: null, processStartIdentity: null });

      // The guard keeps the row's process and survivors; the writer gives up its claim as before.
      await stop.flush();
      expect(registry.writes.at(-1)).toMatchObject({ status: "unhosted", releaseClaim: true });
      expect(registry.releases).toEqual([7]);
      expect(host.releaseCalls).toBe(1);
    });
  });
}

test("production-sized ten-lane persistence coalesces cursors and orders material transitions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-persistence-production-"));
  const filename = path.join(directory, "agent-registry.json");
  const seed = new AgentRegistry(filename);
  const template = beginLegacySpawnReceiptFixture(seed, "codex", "/production-seed");
  const production = seed.snapshot();
  for (let index = 1; index < 18_000; index += 1) {
    const launchId = `production-persistence-${String(index).padStart(5, "0")}`;
    production.receipts[launchId] = { ...structuredClone(template), launchId };
  }
  const payload = JSON.stringify(production);
  expect(Buffer.byteLength(payload)).toBeGreaterThanOrEqual(14_660_822);
  fs.writeFileSync(filename, payload);
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const lanes = await Promise.all(Array.from({ length: 10 }, async (_, lane) => {
    const engine = lane % 2 === 0 ? "codex" as const : "claude" as const;
    const key = { engine, sessionId: `production-lane-${lane}` };
    const claimOwner = `production-owner-${lane}`;
    const claimEpoch = 7;
    registry.upsert({
      key,
      artifactPath: `/sessions/production-lane-${lane}.jsonl`,
      cwd: "/repo",
      accountId: "work",
      status: "live",
      host: null,
      structuredHost: {
        kind: engine === "codex" ? "codex-app-server" : "claude-broker",
        endpoint: `stdio:${lane}`,
        process: { pid: 4_000 + lane, startIdentity: `${4_000 + lane}:fixture` },
        eventCursor: 0,
        protocolVersion: "1",
        writerClaimEpoch: claimEpoch,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch,
      claimOwner,
      pendingAction: null,
    });
    const host = new RecordingHost();
    const stop = engine === "codex"
      ? await bindCodexHostPersistence(registry, key, host as unknown as CodexAppServerHost, claimOwner, claimEpoch, "unhosted", { cursorDebounceMs: 20 })
      : await bindClaudeHostPersistence(registry, key, host as unknown as ClaudeStreamBrokerHost, claimOwner, claimEpoch, "unhosted", { cursorDebounceMs: 20 });
    return { key, host, stop };
  }));
  const revisionBeforeEvents = registry.storageDiagnostics().revision!;

  for (let cursor = 1; cursor <= 100; cursor += 1) {
    for (const lane of lanes) lane.host.emit({ eventCursor: cursor });
  }
  await Bun.sleep(35);
  for (const lane of lanes) lane.host.emit({ eventCursor: 101, status: "active", activeTurnRef: "turn-live" });
  for (const lane of lanes) lane.host.emit({ eventCursor: 102, status: "attention", pendingAttention: ["approval"] });
  for (const lane of lanes) lane.host.emit({
    eventCursor: 103,
    status: "unhosted",
    endpoint: "stdio:released",
    pid: null,
    processStartIdentity: null,
    activeTurnRef: null,
    pendingAttention: [],
  });

  await Promise.all(lanes.map(lane => lane.stop.flush()));
  expect(registry.storageDiagnostics().revision! - revisionBeforeEvents).toBe(40);
  for (const lane of lanes) {
    expect(registry.snapshot().entries[`${lane.key.engine}:${lane.key.sessionId}`]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { eventCursor: 103, activeTurnRef: null, pendingAttention: [] },
    });
    await lane.stop();
  }
}, 30_000);

for (const [engine, bind] of binders) test(`${engine} persists memory kills immediately and keeps fatal evidence on death`, async () => {
  const registry = new RecordingRegistry();
  const host = new RecordingHost();
  const stop = await bind(registry as unknown as AgentRegistry, host, { cursorDebounceMs: 30_000 });
  const memory: NonNullable<HostState["memory"]> = { mechanism: "scope", unit: "delegatus-agent-test-row.scope", limitBytes: 15 * 2 ** 30, kills: 1,
    lastKill: { at: new Date().toISOString(), limitBytes: 15 * 2 ** 30, limit: "agent", fatal: false, process: null } };
  host.emit({ memory });
  await stop.flush();
  expect(registry.writes.at(-1)?.columns.memory?.kills).toBe(1);
  host.emit({ status: "dead", memory: { ...memory, lastKill: { ...memory.lastKill!, fatal: true } } });
  await stop.flush();
  expect(registry.writes.at(-1)?.columns.memory?.lastKill?.fatal).toBe(true);
  await stop();
});

test("memory evidence round-trips through the durable registry and malformed shapes are dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-registry-"));
  const filename = path.join(dir, "registry.json");
  const registry = new AgentRegistry(filename);
  try {
    registry.upsert({ key: KEY, artifactPath: "/sessions/memory.jsonl", cwd: "/repo", accountId: null, status: "dead", host: null, claimOwner: null, claimEpoch: 0, pendingAction: null });
    const memory: NonNullable<HostState["memory"]> = { mechanism: "scope", unit: "delegatus-agent-test-row.scope", limitBytes: 15 * 2 ** 30, kills: 1,
      lastKill: { at: new Date().toISOString(), limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null } };
    const columns = { kind: "codex-app-server" as const, endpoint: "stdio:memory", process: null, eventCursor: 0, protocolVersion: "1", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [], memory };
    registry.setStructuredHost(KEY, columns, "dead");
    expect(new AgentRegistry(filename).readOnlySnapshot().entries[`${KEY.engine}:${KEY.sessionId}`]!.structuredHost?.memory).toEqual(memory);
    registry.setStructuredHost(KEY, { ...columns, memory: { ...memory, kills: -1 } }, "dead");
    expect(registry.readOnlySnapshot().entries[`${KEY.engine}:${KEY.sessionId}`]!.structuredHost?.memory).toBeUndefined();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("durable registry hydration drops malformed memory timestamps and preserves sibling rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-timestamps-"));
  const registry = new AgentRegistry(path.join(dir, "seed.json"));
  try {
    registry.upsert({ key: KEY, artifactPath: "/sessions/memory.jsonl", cwd: "/repo", accountId: null, status: "dead", host: null, claimOwner: null, claimEpoch: 0, pendingAction: null });
    const sibling = { engine: "codex" as const, sessionId: "healthy-memory-row" };
    registry.upsert({ key: sibling, artifactPath: "/sessions/healthy.jsonl", cwd: "/repo", accountId: null, status: "idle", host: null, claimOwner: null, claimEpoch: 0, pendingAction: null });
    const memory: NonNullable<HostState["memory"]> = { mechanism: "watchdog", unit: null, limitBytes: 1024, kills: 1,
      lastKill: { at: new Date().toISOString(), limitBytes: 1024, limit: "agent", fatal: true, process: null } };
    registry.setStructuredHost(KEY, { kind: "codex-app-server", endpoint: "stdio:memory", process: null, eventCursor: 0,
      protocolVersion: "1", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [], memory }, "dead");
    for (const [index, timestamp] of [{ toString: null }, {}, [], 0, true, null, "invalid"].entries()) {
      const persisted = registry.snapshot();
      persisted.entries[`${KEY.engine}:${KEY.sessionId}`]!.structuredHost!.memory!.lastKill!.at = timestamp as unknown as string;
      const filename = path.join(dir, `malformed-${index}.json`);
      fs.writeFileSync(filename, JSON.stringify(persisted));
      const hydrated = new AgentRegistry(filename).readOnlySnapshot();
      expect(hydrated.entries[`${KEY.engine}:${KEY.sessionId}`]!.structuredHost?.memory).toBeUndefined();
      expect(hydrated.entries[`${sibling.engine}:${sibling.sessionId}`]!.status).toBe("idle");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// This case also runs, unchanged, on the pre-admission implementation as the red control.
test("a child-held writer leaves the initial host checkpoint loop below 50 ms", async () => {
  const { registryLockHolder } = await import("@/lib/agent/registryLockHolderFixture");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-checkpoint-measurement-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  const state = hostState();
  registry.upsert({ key: KEY, artifactPath: "/sessions/checkpoint.jsonl", cwd: "/repo", accountId: null,
    status: "idle", host: null, claimEpoch: 1, claimOwner: "checkpoint-owner", pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: state.endpoint,
      process: { pid: state.pid!, startIdentity: state.processStartIdentity }, eventCursor: 0,
      protocolVersion: "1", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  const holder = registryLockHolder(path.join(directory, "registry.sqlite"));
  let pulse: ReturnType<typeof setInterval> | undefined;
  try {
    await holder.hold(180);
    const start = performance.now();
    let last = start;
    let maxGap = 0;
    pulse = setInterval(() => { const at = performance.now(); maxGap = Math.max(maxGap, at - last); last = at; }, 5);
    const stop = await bindCodexHostPersistence(registry, KEY, new RecordingHost() as unknown as CodexAppServerHost, "checkpoint-owner", 1);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    maxGap = Math.max(maxGap, performance.now() - last);
    clearInterval(pulse);
    await stop();
    console.info(`[host checkpoint measurement] hold=180 ms maxGap=${maxGap.toFixed(2)} ms`);
    expect(maxGap).toBeLessThan(50);
  } finally { clearInterval(pulse); await holder.close(); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
