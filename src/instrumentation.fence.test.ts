import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  activateViewerRuntimeWhenCurrent,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
  viewerReleaseOwnsTraffic,
  type HotStateCutoverBoundary,
} from "@/lib/viewerInstrumentation";
import {
  HOT_STATE_BACKEND,
  publishHotStateAuthority,
  readHotStateAuthority,
  restoreHotStateAuthority,
  type HotStateAuthority,
} from "@/lib/state/hotStateAuthority";

/* A release the deploy fenced and the supervisor restarted boots while the
   adapter still holds the fence. */

const revision = "c".repeat(40);
const successor = "f".repeat(40);
const port = "19031";
let sandbox = "";
let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  previousEnv = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, PORT: process.env.PORT };
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-boot-under-fence-"));
  process.env.LLV_STATE_DIR = sandbox;
  process.env.PORT = port;
});

afterEach(() => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function target(directory: string, release = revision, listening = port): void {
  fs.writeFileSync(path.join(directory, "viewer-release.json"), JSON.stringify({
    endpoint: `http://127.0.0.1:${listening}`, revision: release, hotStateBackend: HOT_STATE_BACKEND,
  }));
}

/** What the adapter writes: settled SQLite authority, then its fence over it. */
function fenced(directory: string): { settled: HotStateAuthority; fence: HotStateAuthority } {
  target(directory);
  const settled = publishHotStateAuthority(directory, "sqlite", revision);
  return { settled, fence: publishHotStateAuthority(directory, "fencing", revision) };
}

test("a release booting under a fence resolves its boundary once the authority returns to sqlite, and serves", async () => {
  const { settled, fence } = fenced(sandbox);
  let boundary: HotStateCutoverBoundary | null = null;
  let served = false;
  const exits: number[] = [];
  let polls = 0;
  await activateViewerRuntimeWhenCurrent(async () => {
    boundary = await establishHotStateCutoverBoundary(() => true, {
      pollMs: 1,
      fenceWaitMs: 10_000,
      log: () => {},
      exit: (code) => { exits.push(code); },
      schedule: (callback) => {
        // The adapter restores the release it fenced on the third poll.
        if (++polls === 3) restoreHotStateAuthority(sandbox, settled, fence);
        queueMicrotask(callback);
        return {};
      },
    });
    await initializeHotStateStoresAtStartup(boundary);
    served = true;
  }, () => true, { schedule: () => ({}) });

  expect(served).toBeTrue();
  expect(polls).toBe(3);
  expect(exits).toEqual([]);
  expect(boundary!.authority).toMatchObject({ mode: "sqlite", releaseRevision: revision, epoch: fence.epoch + 1 });
  expect(readHotStateAuthority(sandbox)).toEqual(boundary!.authority);
});

test("a fence that never clears ends the boot with a bounded failure exit and stays in place", async () => {
  const { fence } = fenced(sandbox);
  const exits: number[] = [];
  const started = Date.now();
  await expect(establishHotStateCutoverBoundary(() => true, {
    pollMs: 5, fenceWaitMs: 60, log: () => {}, exit: (code) => { exits.push(code); },
  })).rejects.toThrow("hot-state fence did not clear for this release within 60 ms");
  expect(exits).toEqual([1]);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(readHotStateAuthority(sandbox)).toEqual(fence);
});

test("a fence that ends in another release's favour is never overwritten by the booting release", async () => {
  fenced(sandbox);
  const exits: number[] = [];
  let switched: HotStateAuthority | null = null;
  let polls = 0;
  await expect(establishHotStateCutoverBoundary(() => viewerReleaseOwnsTraffic(), {
    pollMs: 1,
    fenceWaitMs: 10_000,
    log: () => {},
    exit: (code) => { exits.push(code); },
    schedule: (callback) => {
      polls += 1;
      // The adapter publishes authority first and the target second.
      if (polls === 2) switched = publishHotStateAuthority(sandbox, "sqlite", successor);
      if (polls === 4) target(sandbox, successor, "19032");
      queueMicrotask(callback);
      return {};
    },
  })).rejects.toThrow("viewer release lost traffic during hot-state cutover");
  expect(exits).toEqual([1]);
  expect(polls).toBe(4);
  expect(readHotStateAuthority(sandbox)).toEqual(switched);
});

test.each(["withdrawn", "stuck"] as const)("a startup a fence interrupted restarts once the fence is %s, never staying up refused", async (end) => {
  const fence: HotStateAuthority = {
    schemaVersion: 1, epoch: 9, mode: "fencing", releaseRevision: revision, updatedAt: "2026-11-26T19:47:08.000Z",
  };
  let held = true;
  const restarts: number[] = [];
  const queue: Array<() => void> = [];
  let polls = 0;
  const booting = activateViewerRuntimeWhenCurrent(
    async () => { throw new Error("structured startup lost release authority"); },
    () => true,
    {
      pollMs: 1,
      fenceWaitMs: end === "stuck" ? 40 : 60_000,
      fenceRequest: () => held ? fence : null,
      restartAfterFencedStartup: (code) => { restarts.push(code); },
      log: () => {},
      schedule: (callback) => { queue.push(callback); setTimeout(() => {
        if (end === "withdrawn" && ++polls === 4) { expect(restarts).toEqual([]); held = false; }
        queue.shift()?.();
      }, 2); return {}; },
    },
  );
  await expect(booting).rejects.toThrow("structured startup lost release authority");
  expect(restarts).toEqual([1]);
});

test("a startup that fails without any fence keeps its own failure and restarts nothing", async () => {
  const restarts: number[] = [];
  await expect(activateViewerRuntimeWhenCurrent(
    async () => { throw new Error("injected activation failure"); },
    () => true,
    { fenceRequest: () => null, restartAfterFencedStartup: (code) => { restarts.push(code); }, schedule: () => ({}) },
  )).rejects.toThrow("injected activation failure");
  expect(restarts).toEqual([]);
});

/* The real `register()` in its own process, as the restarted container runs it. */

function bootInstrumentation(fenceWaitMs: number) {
  const directory = path.join(sandbox, "state");
  fs.mkdirSync(directory, { recursive: true });
  const state = fenced(directory);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(LLV_|DELEGATUS_|__NEXT_PRIVATE|NEXT_)/.test(name)) env[name] = value;
  }
  for (const name of ["home", "config", "tmp"]) fs.mkdirSync(path.join(sandbox, name), { recursive: true });
  const log = path.join(sandbox, "boot.log");
  const child = Bun.spawn([process.execPath, path.resolve("src/lib/viewerFenceBoot.fixture.ts")], {
    cwd: process.cwd(),
    env: {
      ...env,
      HOME: path.join(sandbox, "home"),
      XDG_CONFIG_HOME: path.join(sandbox, "config"),
      TMPDIR: path.join(sandbox, "tmp"),
      LLV_STATE_DIR: directory,
      LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
      LLV_HOT_STATE_FENCE_WAIT_MS: String(fenceWaitMs),
      NEXT_RUNTIME: "nodejs",
      PORT: port,
    },
    stdout: Bun.file(log),
    stderr: Bun.file(path.join(sandbox, "boot.err")),
  });
  const output = () => [log, path.join(sandbox, "boot.err")]
    .map((file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").join("\n");
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  };
  return { ...state, directory, child, output, stop };
}

function importedCollections(directory: string): number {
  const filename = path.join(directory, "state.sqlite");
  if (!fs.existsSync(filename)) return 0;
  try {
    const database = new Database(filename, { readonly: true });
    try { return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_collections").get()!.count; }
    finally { database.close(); }
  } catch { return 0; }
}

test("the instrumentation process exits non-zero when the fence never clears, so its supervisor restarts it", async () => {
  const boot = bootInstrumentation(1_500);
  try {
    const code = await Promise.race([boot.child.exited, Bun.sleep(20_000).then(() => "still running" as const)]);
    expect(code, boot.output()).toBe(1);
    expect(readHotStateAuthority(boot.directory)).toEqual(boot.fence);
  } finally {
    await boot.stop();
  }
}, 30_000);

test("the instrumentation process boots under a fence, leaves it to the adapter and proceeds once it clears", async () => {
  const boot = bootInstrumentation(60_000);
  try {
    // Long enough for several fence monitor polls while the boundary waits.
    await Bun.sleep(3_000);
    expect(boot.child.exitCode, boot.output()).toBeNull();
    // A booting release neither acknowledges the fence nor imports state under it.
    expect(readHotStateAuthority(boot.directory)).toEqual(boot.fence);
    expect(importedCollections(boot.directory)).toBe(0);
    restoreHotStateAuthority(boot.directory, boot.settled, boot.fence);
    const deadline = Date.now() + 20_000;
    while (importedCollections(boot.directory) < 4 && boot.child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    expect(importedCollections(boot.directory), boot.output()).toBeGreaterThanOrEqual(4);
    expect(boot.output()).not.toContain("Failed to prepare server");
    expect(boot.output()).not.toContain("hot-state fence checkpoint");
  } finally {
    await boot.stop();
  }
}, 40_000);
