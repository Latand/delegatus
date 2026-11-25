import { expect, spyOn, test } from "bun:test";
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
    expect(registered).toBe(false);
    expect((await host.health()).pid).toBeNull();
  } finally {
    settleRetirement.resolve();
    await Promise.all([stop, register]);
    await waitForCondition(() => flushes === 3, "detached cleanup settled");
  }
  expect(registered).toBe(true);
});
