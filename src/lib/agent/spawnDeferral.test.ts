import "next/dist/server/node-environment-baseline";
import { expect, spyOn, test } from "bun:test";
import type { WorkStore } from "next/dist/server/app-render/work-async-storage.external";
import type { WorkUnitStore } from "next/dist/server/app-render/work-unit-async-storage.external";

// Next captures global AsyncLocalStorage when its module graph first loads.
// Bootstrap before importing any part of that graph, including spawnCommand.
const { after } = await import("next/server");
const { AfterContext } = await import("next/dist/server/after/after-context");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
const { productionSpawnCommandDependencies } = await import("./spawnCommand");
const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function requestScope<T>(work: () => T, waitUntil = true) {
  const closed: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  const context = new AfterContext({
    waitUntil: waitUntil ? promise => { pending.push(promise); } : undefined,
    onClose: callback => { closed.push(callback); },
    onTaskError: undefined,
  });
  const store = { afterContext: context } as WorkStore;
  const unit = { type: "request", phase: "action" } as WorkUnitStore;
  return workAsyncStorage.run(store, () => workUnitAsyncStorage.run(unit, () => ({
    result: work(),
    close: async () => { for (const callback of closed) callback(); await Promise.all(pending); },
  })));
}

test("the pinned Next runtime identifies a missing request before registering any work", () => {
  try { after(async () => {}); throw new Error("expected Next to refuse"); }
  catch (error) {
    expect(error).toMatchObject({ __NEXT_ERROR_CODE: "E468" });
    expect((error as Error).message).toContain("outside a request scope");
  }
});

test("request-scoped spawn deferral waits for response close and runs exactly once", async () => {
  let calls = 0;
  const request = requestScope(() => productionSpawnCommandDependencies.defer(async () => { calls++; }));
  await turn();
  expect(calls).toBe(0);
  await request.close();
  expect(calls).toBe(1);
  await turn();
  expect(calls).toBe(1);
});

test("a broken request lifecycle is refused without falling back to a second launch", async () => {
  let calls = 0;
  expect(() => requestScope(() => productionSpawnCommandDependencies.defer(async () => { calls++; }), false))
    .toThrow("waitUntil");
  await turn();
  expect(calls).toBe(0);
});

test("a failed request-scoped callback stays with Next's error handler and runs once", async () => {
  const error = new Error("fixture request launch failed");
  const log = spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  try {
    const request = requestScope(() => productionSpawnCommandDependencies.defer(async () => { calls++; throw error; }));
    await request.close();
    await turn();
    expect(calls).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("An error occurred in a function passed to `after()`:", error);
  } finally { log.mockRestore(); }
});

test("in-process spawn work yields to the loop and retains its operation label while awaiting", async () => {
  let ran = false;
  let label: string | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  productionSpawnCommandDependencies.defer(async () => {
    ran = true;
    label = viewerLoopMonitor.current();
    await held;
    finished();
  });
  try {
    expect(ran).toBe(false);
    await turn();
    expect(ran).toBe(true);
    expect(label).toBe("agent.deferred-spawn");
    let advanced = false;
    await new Promise<void>(resolve => setTimeout(() => { advanced = true; resolve(); }, 0));
    expect(advanced).toBe(true);
  } finally { release(); await done; }
});

test.each(["throw", "reject"] as const)("in-process deferred work logs a labelled %s without an unhandled failure", async kind => {
  const error = new Error("fixture deferred launch failed");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    productionSpawnCommandDependencies.defer(() => {
      if (kind === "throw") throw error;
      return Promise.reject(error);
    });
    await turn();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[spawn] deferred work failed");
  } finally { log.mockRestore(); }
});
