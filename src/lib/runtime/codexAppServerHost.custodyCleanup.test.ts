import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import * as fence from "@/lib/recordedChecks/hostFence";
import * as checks from "@/lib/recordedChecks/store";
import { CodexAppServerHost } from "./codexAppServerHost";
import { hostExitProcess } from "./hostExit";
import { FakeAppServer, MemoryEventStore, fakeSpawn, installCodexHostFixture, waitForCondition } from "./codexAppServerHost.fixture";

installCodexHostFixture(() => {});

test("socket error and reap callbacks join an admitted release while custody stays fenced", async () => {
  const child = new FakeAppServer("custody-release");
  const term = Promise.withResolvers<void>();
  const checkpoint = Promise.withResolvers<void>();
  const signals: string[] = [];
  const host = await CodexAppServerHost.start({
    cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child),
    pidAlive: () => true, processIdentity: () => "owned", shutdownGraceMs: 5_000,
    signalProcess: (_pid, signal) => { signals.push(signal); term.resolve(); },
  });
  let flushes = 0;
  host.setPersistenceFlush(async () => { flushes++; await checkpoint.promise; });
  const admission = spyOn(fence, "withRecordedHostFence");
  const custody = spyOn(checks, "recordedOwnerHeld").mockReturnValue(false);
  let done = false;
  const first = host.release().then(() => { done = true; });
  try {
    await term.promise;
    // These transport events arrive outside the reservation's async context.
    child.emit("error", new Error("callback connection closed"));
    child.emit("close", 0, null);
    await waitForCondition(() => flushes === 3, "release checkpoints");
    expect(done).toBe(false);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(custody).toHaveBeenCalledTimes(1);
    expect(signals).toEqual(["SIGTERM"]);
    checkpoint.resolve();
    await first;
    expect((await host.health()).pid).toBeNull();
  } finally {
    checkpoint.resolve(); await first; admission.mockRestore(); custody.mockRestore();
  }
});

test("failed admitted cleanup retries through live recorded custody", async () => {
  const child = new FakeAppServer("custody-release-retry");
  const term = Promise.withResolvers<void>();
  const signals: string[] = [];
  const host = await CodexAppServerHost.start({
    cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child),
    pidAlive: () => true, processIdentity: () => "owned", shutdownGraceMs: 20,
    signalProcess: (_pid, signal) => { signals.push(signal); term.resolve(); },
  });
  let held = false;
  const custody = spyOn(checks, "recordedOwnerHeld").mockImplementation(() => held);
  const first = host.release().then(() => null, (error: Error) => error);
  try {
    await term.promise;
    child.emit("error", new Error("callback connection closed"));
    held = true;
    expect((await first)?.message).toContain("could not be reaped");
    const sent = [...signals];
    expect(sent[0]).toBe("SIGTERM");
    expect(sent).toContain("SIGKILL");
    await waitForCondition(() => custody.mock.calls.length >= 2, "fresh custody decision");
    await expect(host.release()).rejects.toThrow("recorded check custody");
    expect(signals).toEqual(sent);
  } finally {
    held = false; child.emit("close", 0, null); await host.release(); custody.mockRestore();
  }
});

test("a failed reap inside a reservation holds a fresh ticket through the retry's last signal", async () => {
  const child = new FakeAppServer("custody-failed-reap");
  const owner = hostExitProcess(child.pid, "owned")!;
  const directory = statePath("recorded-check-host-fences");
  function ticket(): string | null {
    const lock = fs.readdirSync(directory).find(name => name.endsWith(".write-lock"));
    if (!lock) return null;
    try { return JSON.parse(fs.readFileSync(path.join(directory, lock), "utf8")).token; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const primary: Array<{ signal: string; ticket: string | null }> = [];
  const retry: typeof primary = [];
  let firstFailed = false, flushed = false;
  const host = await CodexAppServerHost.start({
    cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child),
    pidAlive: () => true, processIdentity: () => "owned", shutdownGraceMs: 30,
    signalProcess: (_pid, signal) => {
      (firstFailed ? retry : primary).push({ signal, ticket: ticket() });
      if (firstFailed && signal === "SIGKILL") queueMicrotask(() => child.emit("close", 0, null));
    },
  });
  const checked: Array<string | null> = [];
  const custody = spyOn(checks, "recordedOwnerHeld").mockImplementation(() => {
    checked.push(ticket());
    return false;
  });
  host.setPersistenceFlush(async () => { flushed = true; });
  try {
    await fence.withRecordedHostFence(owner, async () => {
      const release = host.release();
      await waitForCondition(() => primary.length > 0, "first signal");
      child.emit("error", new Error("fixture transport closed"));
      await expect(release).rejects.toThrow("could not be reaped");
      firstFailed = true;
    });
    await waitForCondition(() => flushed, "retried reap checkpoint");
    expect(primary.map(item => item.signal)).toContain("SIGKILL");
    expect(retry.map(item => item.signal)).toContain("SIGKILL");
    const originalTicket = primary[0].ticket, retryTicket = retry[0].ticket;
    expect(originalTicket).toBeString();
    expect(retryTicket).toBeString();
    expect(retryTicket).not.toBe(originalTicket);
    expect(primary.every(item => item.ticket === originalTicket)).toBe(true);
    expect(retry.every(item => item.ticket === retryTicket)).toBe(true);
    expect(checked).toContain(originalTicket);
    expect(checked).toContain(retryTicket);
  } finally {
    child.emit("close", 0, null);
    try { await host.release(); } finally { custody.mockRestore(); }
  }
});

test("independent registration waits for the outer retirement after the child closes", async () => {
  const child = new FakeAppServer("custody-registration");
  const owner = hostExitProcess(child.pid, "owned")!;
  const signalled = Promise.withResolvers<void>();
  const reaped = Promise.withResolvers<void>();
  const settleRetirement = Promise.withResolvers<void>();
  const host = await CodexAppServerHost.start({
    cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child),
    pidAlive: () => true, processIdentity: () => "owned", shutdownGraceMs: 5_000,
    signalProcess: () => signalled.resolve(),
  });
  let flushes = 0;
  host.setPersistenceFlush(async () => { flushes++; });
  const stop = fence.withRecordedHostFence(owner, async () => {
    await host.release();
    reaped.resolve();
    await settleRetirement.promise;
  });
  await signalled.promise;
  let registered = false;
  const register = fence.withRecordedHostFence(owner, async () => { registered = true; });
  try {
    child.emit("error", new Error("callback connection closed"));
    child.emit("close", 0, null);
    await reaped.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(flushes).toBe(1);
    expect(registered).toBe(false);
    expect((await host.health()).pid).toBeNull();
  } finally {
    settleRetirement.resolve();
    await Promise.all([stop, register]);
    await waitForCondition(() => flushes === 3, "detached cleanup settled");
  }
  expect(registered).toBe(true);
});

test("cleanup already inside retirement can finish its checkpoints before the fence exits", async () => {
  const child = new FakeAppServer("custody-reentrant");
  const owner = hostExitProcess(child.pid, "owned")!;
  const signalled = Promise.withResolvers<void>();
  const host = await CodexAppServerHost.start({
    cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child),
    pidAlive: () => true, processIdentity: () => "owned", shutdownGraceMs: 5_000,
    signalProcess: () => signalled.resolve(),
  });
  let flushes = 0;
  host.setPersistenceFlush(async () => { flushes++; });
  await fence.withRecordedHostFence(owner, async () => {
    const release = host.release();
    await signalled.promise;
    child.emit("error", new Error("callback connection closed"));
    child.emit("close", 0, null);
    await release;
    await waitForCondition(() => flushes === 3, "reentrant checkpoints settled", 1_000);
  });
  expect((await host.health()).pid).toBeNull();
});
