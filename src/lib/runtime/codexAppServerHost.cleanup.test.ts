// destructive-code: head-only; fixture-owned paths and recording process doubles.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { CodexAppServerHost, redactCodexHostDiagnostic } from "./codexAppServerHost";
import type { HostState } from "./engineHost";
import { bindCodexHostPersistence, codexHostColumns, startCodexStructuredHost, structuredHostsEnabled } from "./registry";
import { installCodexHostFixture, MemoryEventStore, FailingEventStore, FakeAppServer, fakeSpawn, waitForCondition, controlHostTimeouts, ownedFakeProcess } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  test("release awaits TERM and escalates to KILL before resolving", async () => {
    const server = new FakeAppServer("reap-thread", "reap-thread", true);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    await host.release();
    expect(server.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "unhosted" });
    expect((await stream.next()).done).toBeTrue();
  });

  test("release escalates the process group after its leader exits during grace", async () => {
    const server = new FakeAppServer("group-reap-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => {
          alive = false;
          server.emit("close", 0, signal);
        });
      },
    });

    await host.release();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release cleans the detached process group after an unexpected leader exit", async () => {
    const server = new FakeAppServer("exited-group-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") throw new Error("group exited");
      },
    });

    alive = false;
    server.emit("close", 0, null);
    await host.release();
    await Bun.sleep(10);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(server.signals).toEqual([]);
  });

  test("a timed-out release converges after a late child reap and permits cleanup retry", async () => {
    const server = new FakeAppServer("late-reap-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      signalProcess: () => {},
      ...ownedFakeProcess,
    });
    const states: HostState[] = [];
    const reaped = Promise.withResolvers<void>();
    host.onStateChange((state) => { states.push(state); if (state.status === "unhosted") reaped.resolve(); });

    await expect(host.release()).rejects.toThrow("Codex app-server child could not be reaped");
    server.emit("close", 0, "SIGKILL");
    await reaped.promise;

    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
    expect(states.at(-1)).toMatchObject({ status: "unhosted", pid: null });
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("release converges when the owned child exits without a close event", async () => {
    const server = new FakeAppServer("missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => processIdentity !== null,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") processIdentity = null;
      },
    });

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
    expect(server.signals).toEqual([]);
  });

  test("release cleans the process group when TERM removes the leader without a close event", async () => {
    const server = new FakeAppServer("term-missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") alive = false;
      },
    });

    await expect(host.release()).resolves.toBeUndefined();
    await Bun.sleep(6);

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(server.signals).toEqual([]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
  });

  test("release never signals a recycled child pid", async () => {
    const server = new FakeAppServer("recycled-pid-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => true,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    });
    processIdentity = "4242:recycled";

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([]);
    expect(server.signals).toEqual([]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
  });

  test("an identity-bound release refuses a different authorized process", async () => {
    const server = new FakeAppServer("identity-bound-release-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });

    expect(await host.releaseIfOwned({ pid: server.pid, startIdentity: "4242:other" })).toBeFalse();
    expect(server.signals).toEqual([]);

    await host.release();
  });

  test("release preserves ownership when the initial identity lookup is unknown", async () => {
    const server = new FakeAppServer("initial-identity-unknown-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => null,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
    });

    await expect(host.release()).rejects.toThrow("Codex app-server child ownership is unknown");
    expect(signals).toEqual([]);
    expect(await host.health()).toMatchObject({ pid: 4242, processStartIdentity: null });

    alive = false;
    server.emit("close", 0, null);
    await Bun.sleep(0);
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("release preserves ownership during a transient identity lookup failure", async () => {
    const server = new FakeAppServer("later-identity-unknown-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") queueMicrotask(() => {
          alive = false;
          server.emit("close", 0, signal);
        });
      },
    });
    processIdentity = null;

    await expect(host.release()).rejects.toThrow("Codex app-server child ownership is unknown");
    expect(signals).toEqual([]);
    expect(await host.health()).toMatchObject({ pid: 4242, processStartIdentity: null });

    processIdentity = "4242:owned";
    await expect(host.release()).resolves.toBeUndefined();
    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release retries TERM when a transient identity lookup immediately recovers", async () => {
    const server = new FakeAppServer("immediate-identity-recovery-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let failNextIdentityRead = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => {
        if (!failNextIdentityRead) return "4242:owned";
        failNextIdentityRead = false;
        return null;
      },
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });
    failNextIdentityRead = true;

    await expect(host.release()).resolves.toBeUndefined();

    expect(signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
  });

  test("release skips group cleanup after the reaped leader pid is reused", async () => {
    const server = new FakeAppServer("reaped-recycled-pid-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity = "4242:owned";
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => processIdentity,
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") {
          processIdentity = "4242:recycled";
          queueMicrotask(() => server.emit("close", 0, signal));
        }
      },
    });

    await host.release();
    await Bun.sleep(6);

    expect(signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null });
  });

  test.each([5, 50])("protocol failure starts bounded TERM and KILL cleanup (%d ms grace)", async (shutdownGraceMs) => {
    const server = new FakeAppServer("failed-thread", "failed-thread", true);
    const cleanupFinished = Promise.withResolvers<void>();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      releaseCleanup: cleanupFinished.resolve,
      ...ownedFakeProcess,
    });
    try {
      const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
      server.stdout.write("malformed\n");
      await cleanupFinished.promise;
      expect(server.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect((await stream.next()).value).toMatchObject({ kind: "session-status", status: "dead" });
      expect((await stream.next()).done).toBeTrue();
      const terminal = await host.health();
      server.notify("turn/started", { threadId: "failed-thread", turn: { id: "late-turn" } });
      server.request("late-approval", "item/commandExecution/requestApproval", { command: "date" });
      server.notify("thread/status/changed", { threadId: "failed-thread", status: { type: "active", activeFlags: ["running"] } });
      expect(await host.health()).toMatchObject({
        status: "dead",
        eventCursor: terminal.eventCursor,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [expect.stringMatching(/^destructive-guard:nested:(on|off)$/), "native-inject", "native-turn-profile"],
      });
    } finally { await host.release(); }
  });

  test.each([2, 50])("protocol failure eventually retries TERM after an observed identity refusal (%d ms grace)", async (shutdownGraceMs) => {
    const server = new FakeAppServer("failed-transient-identity-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const cleanupFinished = Promise.withResolvers<void>();
    const terminationEvents: string[] = [];
    let refuseNextIdentity = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      releaseCleanup: cleanupFinished.resolve,
      processIdentity: () => {
        if (refuseNextIdentity) {
          refuseNextIdentity = false;
          terminationEvents.push("identity-unknown");
          return null;
        }
        return "4242:owned";
      },
      pidAlive: () => true,
      signalProcess: (pid, signal) => {
        terminationEvents.push(signal);
        signals.push({ pid, signal });
        if (signal === "SIGKILL") queueMicrotask(() => server.emit("close", 0, signal));
      },
    });
    // EOF arms exactly one unknown read at the ownership gate before TERM.
    const endStdin = server.stdin.end.bind(server.stdin);
    const end = spyOn(server.stdin, "end").mockImplementationOnce(() => {
      refuseNextIdentity = true;
      return endStdin();
    });
    const target = host as unknown as { startTermination(): boolean };
    const startTermination = target.startTermination.bind(host);
    const termination = spyOn(target, "startTermination").mockImplementation(() => {
      const started = startTermination();
      if (!started) terminationEvents.push("TERM-refused");
      return started;
    });
    try {
      server.stdout.write("malformed\n");
      await cleanupFinished.promise;

      // Either the immediate or scheduled retry may recover; the first attempt
      // must have refused termination before either signal was delivered.
      expect(terminationEvents).toEqual(["identity-unknown", "TERM-refused", "SIGTERM", "SIGKILL"]);
      expect(signals).toEqual([
        { pid: -4242, signal: "SIGTERM" },
        { pid: -4242, signal: "SIGKILL" },
      ]);
      expect(await host.health()).toMatchObject({ status: "dead", pid: null });
    } finally {
      end.mockRestore();
      termination.mockRestore();
      await host.release();
    }
  });

  test("protocol failure keeps retrying fenced cleanup until identity recovers", async () => {
    const server = new FakeAppServer("failed-delayed-identity-recovery-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processIdentity: string | null = "4242:owned";
    let alive = true;
    let unavailableIdentityRead = Promise.withResolvers<void>();
    const cleanupFinished = Promise.withResolvers<void>();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      processIdentity: () => {
        if (processIdentity === null) unavailableIdentityRead.resolve();
        return processIdentity;
      },
      pidAlive: () => alive,
      releaseCleanup: cleanupFinished.resolve,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") {
          alive = false;
          queueMicrotask(() => server.emit("close", 0, signal));
        }
      },
    });
    try {
      processIdentity = null;
      server.stdout.write("malformed\n");
      await unavailableIdentityRead.promise;
      // Each attempt reads identity synchronously. Rearm after it returns so
      // these observations require two later retries while the fence is shut.
      for (let retry = 0; retry < 2; retry++) {
        unavailableIdentityRead = Promise.withResolvers<void>();
        await unavailableIdentityRead.promise;
      }
      expect(signals).toEqual([]);
      expect(await host.health()).toMatchObject({ status: "dead", pid: 4242 });

      processIdentity = "4242:owned";
      await cleanupFinished.promise;

      expect(signals).toEqual([
        { pid: -4242, signal: "SIGTERM" },
        { pid: -4242, signal: "SIGKILL" },
      ]);
      expect(await host.health()).toMatchObject({ status: "dead", pid: null });
    } finally {
      processIdentity = "4242:owned";
      await host.release();
    }
  });

  test("an asynchronous stdin EPIPE fails and reaps the host", async () => {
    const server = new FakeAppServer("epipe-thread", "epipe-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 1_000,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });
    const pendingSend = host.send({ id: "epipe-send", text: "start" });
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    server.stdin.emit("error", error);
    await expect(pendingSend).rejects.toThrow("stdin failed: broken pipe");
    expect(await host.health()).toMatchObject({ status: "dead", activeTurnRef: null, pendingAttention: [] });
    await server.signalObserved("SIGTERM");
    expect(server.signals).toContain("SIGTERM");
    await host.release();
  });

  test("keeps an answer pending until the app-server confirms resolution", async () => {
    const server = new FakeAppServer("confirmed-answer-thread");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("confirmed-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const attentionId = (await host.health()).pendingAttention[0]!;
    let settled = false;
    const answer = host.answer(attentionId, { decision: "accept" }).finally(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect((await host.health()).pendingAttention).toEqual([attentionId]);
    expect(store.load("confirmed-answer-thread").some((event) => event.kind === "attention-resolved")).toBeFalse();
    server.notify("serverRequest/resolved", { threadId: "confirmed-answer-thread", requestId: "confirmed-answer" });
    await answer;
    expect((await host.health()).pendingAttention).toEqual([]);
    expect(store.load("confirmed-answer-thread").at(-1)).toMatchObject({
      kind: "attention-resolved",
      id: attentionId,
      resolution: "answered",
    });
    await host.release();
  });

  test("a synchronous answer write failure preserves no false resolution", async () => {
    const server = new FakeAppServer("sync-answer-failure");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("sync-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    server.stdin.write = (() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    }) as typeof server.stdin.write;
    await expect(host.answer((await host.health()).pendingAttention[0]!, { decision: "accept" }))
      .rejects.toThrow("stdin failed: broken pipe");
    expect(store.load("sync-answer-failure").some((event) => event.kind === "attention-resolved")).toBeFalse();
    expect(await host.health()).toMatchObject({ status: "dead", pendingAttention: [] });
    await host.release();
  });

  test("an asynchronous answer write failure preserves no false resolution", async () => {
    const server = new FakeAppServer("async-answer-failure");
    server.autoResolveServerRequests = false;
    const store = new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    server.request("async-answer", "item/commandExecution/requestApproval", { command: "date" });
    await Bun.sleep(0);
    const answer = host.answer((await host.health()).pendingAttention[0]!, { decision: "accept" });
    server.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await expect(answer).rejects.toThrow("stdin failed: broken pipe");
    expect(store.load("async-answer-failure").some((event) => event.kind === "attention-resolved")).toBeFalse();
    expect(await host.health()).toMatchObject({ status: "dead", pendingAttention: [] });
    await host.release();
  });

  test("a mutating RPC timeout poisons the writer before retry", async () => {
    const server = new FakeAppServer("timeout-thread", "timeout-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });
    await expect(host.send({ id: "ambiguous-send", text: "start" })).rejects.toThrow("outcome is uncertain");
    expect(await host.send({ id: "retry", text: "duplicate" })).toEqual({ outcome: "rejected", reason: "dead-host" });
    expect(server.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    await server.signalObserved("SIGTERM");
    expect(server.signals).toContain("SIGTERM");
    const terminal = await host.health();
    server.notify("turn/started", { threadId: "timeout-thread", turn: { id: "late-timeout-turn" } });
    expect(await host.health()).toMatchObject({ status: "dead", eventCursor: terminal.eventCursor, activeTurnRef: null });
    await host.release();
  });

  test("context compaction can outlive the RPC deadline without killing delivery ownership", async () => {
    const server = new FakeAppServer("compaction-delivery-thread");
    server.autoCompleteUserMessage = false;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });

    const clock = controlHostTimeouts();
    const delivery = host.send({ id: "compaction-delivery", text: "continue after compaction" })
      .then((value) => ({ value }), (error: Error) => ({ error }));
    try {
      // Reuse the request barrier from e5a91ae8: metadata I/O precedes dispatch.
      await waitForCondition(() => server.requests.some((candidate) => candidate.method === "turn/start"), "turn/start was never sent");
      await waitForCondition(() => clock.pendingCount() > 0, "delivery confirmation deadline was never armed");
      clock.advance(10);
      server.notify("item/started", {
        threadId: "compaction-delivery-thread",
        turnId: "turn-1",
        item: { id: "compaction-one", type: "contextCompaction" },
      });
      expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
      expect(server.signals).toEqual([]);

      const request = server.requests.find((candidate) => candidate.method === "turn/start")!;
      const params = request.params as { input: unknown };
      server.notify("item/completed", {
        threadId: "compaction-delivery-thread",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          clientId: "compaction-delivery",
          content: params.input,
        },
      });

      expect(await delivery).toEqual({ value: { outcome: "turn-started", turnId: "turn-1" } });
      expect(server.signals).toEqual([]);
    } finally {
      clock.restore();
      await host.release();
      await delivery;
    }
  });

  test.each([30, 60])("an active turn gives thread/read enough time to answer (%i ms)", async (elapsed) => {
    const ignoredMethods: string[] = [];
    const server = new FakeAppServer("slow-read-thread", "slow-read-thread", false, [], undefined, null, ignoredMethods);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 20,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    let pending: Promise<{ value: unknown } | { error: Error }> | undefined;
    let clock: ReturnType<typeof controlHostTimeouts> | undefined;
    try {
      expect(await host.send({ id: "first", text: "begin" })).toEqual({ outcome: "turn-started", turnId: "turn-1" });
      ignoredMethods.push("thread/read");
      const reads = () => server.requests.filter((request) => request.method === "thread/read");
      const earlierReads = reads().length;
      clock = controlHostTimeouts();
      pending = host.send({ id: "slow-read-follow-up", text: "continue", expectedTurnId: "turn-1" })
        .then((value) => ({ value }), (error: Error) => ({ error }));
      await waitForCondition(() => reads().length > earlierReads, "thread/read was never sent");
      // Cross the ordinary 20 ms deadline; the active window is exactly 60 ms.
      clock.advance(elapsed);
      if (elapsed === 60) {
        const result = await pending;
        expect(result).toHaveProperty("error");
        if (!("error" in result)) throw new Error("thread/read did not expire");
        expect(result.error.message).toContain("thread/read timed out");
        return;
      }
      const read = reads().at(-1)!;
      server.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: read.id,
        result: { thread: { id: "slow-read-thread", path: "/sessions/slow-read-thread.jsonl", turns: [] } },
      })}\n`);
      expect(await pending).toEqual({ value: { outcome: "steered", turnId: "turn-1" } });
    } finally {
      clock?.restore();
      await host.release();
      await pending;
    }
  });

  test("accepts a legal thread/read response above the legacy frame guard", async () => {
    const server = new FakeAppServer("large-read-thread");
    server.readTurns = [{
      id: "historical-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "x".repeat(5 * 1024 * 1024) }],
    }];
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });

    expect(await host.send({ id: "new-delivery", text: "continue" }))
      .toEqual({ outcome: "turn-started", turnId: "turn-1" });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    await host.release();
  });

  test("a late timed-out thread/read response stays harmless after retry delivery", async () => {
    const ignoredMethods = ["thread/read"];
    const server = new FakeAppServer("late-read-thread", "late-read-thread", false, [], undefined, null, ignoredMethods);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 5,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    const entry = { id: "late-read-retry", text: "continue" };

    await expect(host.send(entry)).rejects.toThrow("thread/read timed out");
    const firstRead = server.requests.findLast((request) => request.method === "thread/read")!;
    ignoredMethods.splice(0);

    expect(await host.send(entry)).toEqual({ outcome: "turn-started", turnId: "turn-1" });
    server.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: firstRead.id,
      result: { thread: { id: "late-read-thread", path: "/sessions/late-read-thread.jsonl", turns: [] } },
    })}\n`);
    await Bun.sleep(0);

    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: "turn-1" });
    expect(server.signals).not.toContain("SIGTERM");
    expect(server.requests.filter((request) => request.method === "turn/start" || request.method === "turn/steer")).toHaveLength(1);
    await host.release();
  });

  test("ledger failures are contained, reject pending work, and close subscribers", async () => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("ledger-thread", "ledger-thread", false, [], undefined, null, ["turn/start"]);
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 1_000,
      eventStore: store,
      spawnProcess: fakeSpawn(server),
      ...ownedFakeProcess,
    });
    const stream = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const pendingSend = host.send({ id: "pending-ledger-send", text: "start" });
    server.notify("account/rateLimits/updated", { rateLimits: {} });
    await expect(pendingSend).rejects.toThrow("runtime event ledger failed");
    expect(await host.health()).toMatchObject({ status: "dead", eventCursor: 1 });
    expect(store.appendAttempts).toBe(2);
    server.notify("account/rateLimits/updated", { rateLimits: { retry: true } });
    expect(store.appendAttempts).toBe(2);
    expect((await stream.next()).done).toBeTrue();
    await server.signalObserved("SIGTERM");
    expect(server.signals).toContain("SIGTERM");
    await host.release();
  });

  test.each([2, 50])("ledger failure converges without close and releases the writer claim (%d ms grace)", async (shutdownGraceMs) => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("ledger-missing-close-thread");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const cleanupFinished = Promise.withResolvers<void>();
    let alive = true;
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      shutdownGraceMs,
      eventStore: store,
      spawnProcess: fakeSpawn(server),
      releaseCleanup: cleanupFinished.resolve,
      processIdentity: ownedFakeProcess.processIdentity,
      pidAlive: () => alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") alive = false;
      },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-failed-ledger-registry-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "ledger-missing-close-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/ledger-missing-close-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        process: { pid: 4242, startIdentity: "4242:owned" },
        eventCursor: 1,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 8,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 8,
      claimOwner: "failed-owner",
      pendingAction: null,
    });
    await bindCodexHostPersistence(registry, key, host, "failed-owner", 8);

    try {
      server.notify("account/rateLimits/updated", { rateLimits: {} });
      await cleanupFinished.promise;
      // Cleanup releases the process before release() joins registry persistence.
      await host.release();

      expect(signals).toEqual([
        { pid: -4242, signal: "SIGTERM" },
        { pid: -4242, signal: "SIGKILL" },
      ]);
      expect(await host.health()).toMatchObject({ status: "dead", pid: null });
      expect(registry.snapshot().entries["codex:ledger-missing-close-thread"]).toMatchObject({
        status: "dead",
        claimOwner: null,
        structuredHost: { process: null, endpoint: "stdio:released" },
      });
    } finally {
      await host.release();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a shutdown ledger failure still releases the bound registry claim", async () => {
    const store = new FailingEventStore();
    const server = new FakeAppServer("release-ledger-thread");
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: store,
      spawnProcess: fakeSpawn(server),
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-release-ledger-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const key = { engine: "codex" as const, sessionId: "release-ledger-thread" };
    registry.upsert({
      key,
      artifactPath: "/sessions/release-ledger-thread.jsonl",
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "codex-app-server",
        endpoint: "stdio:4242",
        process: { pid: 4242, startIdentity: null },
        eventCursor: 1,
        protocolVersion: "0.144.1",
        writerClaimEpoch: 4,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 4,
      claimOwner: "release-owner",
      pendingAction: null,
    });
    await bindCodexHostPersistence(registry, key, host, "release-owner", 4);
    await host.release();
    expect(store.appendAttempts).toBe(2);
    expect(registry.snapshot().entries["codex:release-ledger-thread"]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { process: null, endpoint: "stdio:released", activeTurnRef: null, pendingAttention: [], activeFlags: [expect.stringMatching(/^destructive-guard:nested:(on|off)$/), "native-inject", "native-turn-profile"] },
    });
  });

  test("diagnostics redact credential labels, cookies, JWTs, and provider key prefixes", () => {
    const joined = (...parts: string[]) => parts.join("");
    const secrets = [
      joined("oauth", "-secret-value"),
      joined("auth", "-secret-value"),
      joined("session", "-secret-value"),
      joined("client", "-secret-value"),
      joined("cookie", "-secret-value"),
      joined("generic", "-secret-value"),
      joined("eyJabcdefghijk", ".abcdefghijk", ".abcdefghijk"),
      joined("sk", "-ant-", "abcdefghijklmnopqrstuvwxyz"),
      joined("gh", "p_", "x".repeat(36)),
    ];
    const redacted = redactCodexHostDiagnostic([
      `${["oauth", "token"].join("_")}=${secrets[0]}`,
      `${["auth", "token"].join("_")}=${secrets[1]}`,
      `${["session", "token"].join("_")}=${secrets[2]}`,
      `${["client", "secret"].join("_")}=${secrets[3]}`,
      `cookie=${secrets[4]}`,
      `token=${secrets[5]}`,
      secrets[6],
      secrets[7],
      secrets[8],
    ].join(" "));
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });

  test("reports a bounded redacted stderr diagnostic when the app-server exits during startup", async () => {
    const server = new FakeAppServer(
      "startup-exit-thread",
      "startup-exit-thread",
      false,
      [],
      undefined,
      null,
      ["initialize"],
    );
    // Inject the exit after the host has attached its listeners and begun
    // initialization. Repository identity lookup may yield before spawning.
    const initializing = new Promise<void>((resolve) => {
      server.stdin.once("data", () => resolve());
    });
    const started = CodexAppServerHost.start({
      cwd: "/repo",
      requestTimeoutMs: 100,
      shutdownGraceMs: 2,
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server),
    });
    await initializing;
    server.stderr.write(`${"x".repeat(20 * 1024)}\nYour authentication token has been invalidated oauth_token=must-stay-private\n`);
    server.emit("close", 1, null);

    const failure: unknown = await started.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected Codex startup to fail");
    expect(failure.message).toContain("Codex app-server child exited");
    expect(failure.message).toContain("Your authentication token has been invalidated");
    expect(failure.message).not.toContain("must-stay-private");
    expect(failure.message.length).toBeLessThanOrEqual(500);
  });

  test("keeps structured hosting enabled unless the rollback switch is explicit", async () => {
    expect(structuredHostsEnabled({ NODE_ENV: "test" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" })).toBeTrue();
    expect(structuredHostsEnabled({ NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" })).toBeFalse();
    await expect(startCodexStructuredHost(
      { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(new FakeAppServer()) },
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "0" },
    )).rejects.toThrow("structured hosts are disabled");
  });

  for (const ledgerFailure of [false, true]) test(`release waits for its registry checkpoint and concurrent releases (ledger failure=${ledgerFailure})`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-checkpoint-"));
    const registryPath = path.join(directory, "registry.json");
    const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "sqlite" });
    const server = new FakeAppServer("release-checkpoint");
    const eventStore = ledgerFailure ? new FailingEventStore() : new MemoryEventStore();
    const host = await CodexAppServerHost.start({
      cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server), shutdownGraceMs: 2,
      ...ownedFakeProcess,
      signalProcess: (_pid, signal) => server.kill(signal),
    });
    const key = { engine: "codex" as const, sessionId: "release-checkpoint" };
    registry.upsert({
      key, artifactPath: "/sessions/release-checkpoint.jsonl", cwd: "/repo", accountId: null,
      status: "idle", host: null, structuredHost: codexHostColumns(await host.health(), 7),
      claimEpoch: 7, claimOwner: "release-writer", pendingAction: null,
    });
    const stop = await bindCodexHostPersistence(registry, key, host, "release-writer", 7);
    const peer = new Database(path.join(directory, "registry.sqlite"));
    let held = false;
    let terminal!: () => void;
    const terminalObserved = new Promise<void>(resolve => { terminal = resolve; });
    const unsubscribe = host.onStateChange(state => { if (state.status === "unhosted") terminal(); });
    const releases: Promise<void>[] = [];
    const acknowledgements: string[] = [];
    try {
      peer.exec("BEGIN IMMEDIATE");
      held = true;
      releases.push(host.release().then(() => { acknowledgements.push("first"); }));
      await terminalObserved;
      // The transport has ended; the second call must still await persistence.
      releases.push(host.release().then(() => { acknowledgements.push("second"); }));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(acknowledgements).toEqual([]);
      expect(registry.readOnlySnapshot().entries["codex:release-checkpoint"]?.claimOwner).toBe("release-writer");
      peer.exec("ROLLBACK");
      held = false;
      await Promise.all(releases);
      const reopened = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: "sqlite" });
      try {
        expect(reopened.readOnlySnapshot().entries["codex:release-checkpoint"]).toMatchObject({
          status: "unhosted", claimOwner: null,
          structuredHost: { process: null, activeTurnRef: null, pendingAttention: [] },
        });
      } finally { reopened.close(); }
    } finally {
      if (held) peer.exec("ROLLBACK");
      unsubscribe();
      await Promise.allSettled(releases);
      await host.release();
      await stop();
      peer.close();
      registry.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
