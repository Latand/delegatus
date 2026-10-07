/* #2594: the Update surface answers with the installation at once, whatever
   the work-evidence reader is doing. Every case runs on an isolated state
   directory with a work-evidence reader that is held open on purpose:

   - the first GET and the first SSE state carry installation, version and
     process metadata while that reader is pending, and say the work is
     pending instead of zero; a snapshot that fails says so first;
   - overlapping observations share the one reading in flight;
   - the automatic path reads its own fresh evidence, so a displayed "no work"
     never authorizes a restart;
   - the "N commits behind" badge follows the serving revisions. */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeDrain } from "./drain";
import { initialAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { setSelfUpdateServiceForTests } from "./instance";
import type { LauncherRecord } from "./launcher";
import type { QuietPorts } from "./quiet";
import { getEvents, getSnapshot } from "./routes";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, idleUpdate, stoppedProcess, type Snapshot } from "./types";

const root = mkdtempSync(join(tmpdir(), "self-update-work-evidence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => setSelfUpdateServiceForTests(null));

const TARGET = "a".repeat(40);
const OLD = "b".repeat(40);
const NEWER = "c".repeat(40);
const BASE = "http://127.0.0.1:3000/api/self-update";
const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1.0.0", date: "" });

/** A reader the test opens by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/** Resolves with `value`, or with "timed out" after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);
}

/** A managed installation serving TARGET from both processes, whose work
    reader waits on `held` for every reading until the test opens it. */
function managed(options: { persisted?: unknown; installed?: string; hostRevision?: string; mode?: ServiceDeps["mode"];
  quiet?: Partial<QuietPorts>; hostHealth?: ServiceDeps["hostHealth"] } = {}) {
  const dir = mkdtempSync(join(root, "managed-"));
  if (options.persisted) writeFileSync(join(dir, "state.json"), JSON.stringify(options.persisted));
  let now = Date.parse("2026-10-07T09:00:00Z");
  let held = gate();
  let reads = 0;
  let sessions: unknown[] = [];
  const quiet: QuietPorts = {
    runtimeSnapshot: async () => { reads++; await held.opened; return { sessions } as never; },
    pipelines: () => [], flows: () => [], presence: () => [], registryHealth: () => [], memoryAvailableMb: () => 8_192,
    controllerBusyReason: async () => null,
    ...options.quiet,
  };
  const deps: ServiceDeps = {
    now: () => now, env: {}, dir, remote: "https://github.com/example/project", branch: "main", pollMinutes: 60, bun: "bun",
    mode: options.mode ?? (async () => ({ mode: "managed", reason: null, record: null })),
    check: async () => { throw new Error("no network in this test"); },
    describe: async (_repo, sha) => revision(sha),
    createRunner: () => { throw new Error("no runner in managed mode"); },
    requestRestart: () => { throw new Error("no launcher in managed mode"); },
    processAlive: () => true, processIdentity: () => null,
    hostHealth: options.hostHealth ?? (async () => ({ pid: 4242, generation: { revision: options.hostRevision ?? options.installed ?? TARGET } }) as never),
    requestDeployment: async () => { throw new Error("no deployment in this test"); },
    readDeployment: async () => null, findDeploymentByIdempotencyKey: async () => null,
    releaseTarget: () => ({ revision: options.installed ?? TARGET }),
    prepareCheckRepo: async () => dir,
    buildEnv: () => ({}),
    web: { pid: 4141, port: 3000, startedAt: "2026-10-07T08:00:00.000Z" },
    quiet,
  };
  const service = new SelfUpdateService(deps);
  setSelfUpdateServiceForTests(service);
  return {
    service, deps,
    reads: () => reads,
    release: () => held.open(),
    hold: () => { held = gate(); },
    setSessions: (next: unknown[]) => { sessions = next; },
    advance: (ms: number) => { now += ms; },
  };
}

const readOnly = () => getSnapshot(new Request(`${BASE}?readOnly=1`));

/** The SSE events of one stream, read as they arrive. */
function events(signal: AbortSignal) {
  const reader = getEvents(new Request(`${BASE}/events?readOnly=1`, { signal })).body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async function next(): Promise<{ event: string; data: unknown }> {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) return { event, data: JSON.parse(data) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test("the first GET answers with the installation while the work reader is pending, and never calls pending work zero", async () => {
  const h = managed();
  const response = await within(readOnly(), 2_000);
  expect(response).not.toBe("timed out");
  const snapshot = await (response as Response).json() as Snapshot;
  expect(snapshot).toMatchObject({
    mode: "managed",
    installed: { sha: TARGET },
    serving: { web: { sha: TARGET }, runtimeHost: { short: TARGET.slice(0, 7) } },
    processes: { web: { pid: 4141, state: "healthy" }, runtimeHost: { pid: 4242, state: "healthy" } },
    workEvidence: { state: "pending", at: null },
  });
  expect(snapshot.resumeWork).toBeUndefined();

  h.setSessions([{ conversationId: "conversation_busy", sessionKey: { engine: "codex" }, host: "registering", turn: "running" }]);
  h.release();
  await h.service.workSettled();
  const landed = await (await readOnly()).json() as Snapshot;
  expect(landed.workEvidence).toMatchObject({ state: "ready", at: "2026-10-07T09:00:00.000Z", error: null });
  expect(landed.workEvidence!.phases).toMatchObject({ readings: { turns: 0 } });
  expect(landed.resumeWork).toMatchObject({ turns: 1, stages: 0 });
});

test("the first SSE state arrives while the work reader is pending, and the landed reading follows on the same stream", async () => {
  const h = managed();
  const abort = new AbortController();
  try {
    const next = events(abort.signal);
    const first = await within(next(), 2_000);
    expect(first).not.toBe("timed out");
    expect(first).toMatchObject({ event: "state", data: { mode: "managed", installed: { sha: TARGET }, workEvidence: { state: "pending" } } });
    expect((first as { data: Snapshot }).data.resumeWork).toBeUndefined();
    h.release();
    const second = await within(next(), 2_000);
    expect(second).toMatchObject({ event: "state", data: { workEvidence: { state: "ready" }, resumeWork: { turns: 0, stages: 0 } } });
  } finally { abort.abort(); h.release(); }
});

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Until `count()` reaches `value`, for at most fifty turns of the loop. */
async function reached(count: () => number, value: number): Promise<void> {
  for (let turn = 0; turn < 50 && count() < value; turn++) await nextTurn();
}

/** Holds the thread for `ms`, as a synchronous registry read on a long-lived
    installation does: no timer or promise runs meanwhile. */
function blockFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* synchronous work */ }
}

test("the first GET and the first SSE state answer before the work reader's synchronous phases run", async () => {
  // The journal stays pending, and loading the pipelines holds the thread for
  // 700 ms before the probe reaches its first await.
  let pipelineReads = 0;
  const h = managed({ quiet: { pipelines: () => { pipelineReads++; blockFor(700); return []; } } });
  const abort = new AbortController();
  try {
    let started = performance.now();
    const response = await readOnly();
    expect(performance.now() - started).toBeLessThan(200);
    expect(await response.json()).toMatchObject({ mode: "managed", installed: { sha: TARGET }, workEvidence: { state: "pending" } });
    expect(pipelineReads).toBe(0);

    started = performance.now();
    const first = await events(abort.signal)();
    expect(performance.now() - started).toBeLessThan(200);
    expect(first).toMatchObject({ event: "state", data: { installed: { sha: TARGET }, workEvidence: { state: "pending" } } });

    // The reading still runs, once, for both readers.
    await nextTurn();
    await readOnly();
    expect(pipelineReads).toBe(1);
    h.release();
    await h.service.workSettled();
    expect(pipelineReads).toBe(1);
    expect(h.reads()).toBe(1);
  } finally { abort.abort(); h.release(); }
});

test("a reading that could not read the journal is unavailable with its reason, never zero work", async () => {
  const h = managed({ quiet: { runtimeSnapshot: async () => { throw new Error("custody journal unreadable"); } } });
  const abort = new AbortController();
  try {
    const next = events(abort.signal);
    expect(await next()).toMatchObject({ event: "state", data: { workEvidence: { state: "pending" } } });
    const landed = await within(next(), 2_000);
    expect(landed).toMatchObject({ event: "state", data: { workEvidence: { state: "unavailable", error: "custody journal unreadable" } } });
    expect((landed as { data: Snapshot }).data.resumeWork).toBeUndefined();
    await h.service.workSettled();
    const snapshot = await (await readOnly()).json() as Snapshot;
    expect(snapshot.workEvidence).toMatchObject({ state: "unavailable", error: "custody journal unreadable" });
    expect(snapshot.workEvidence!.phases).not.toBeNull();
    expect(snapshot.resumeWork).toBeUndefined();
  } finally { abort.abort(); }
});

test("a reading over a registry it could not read whole is unavailable, and names the records", async () => {
  const h = managed({ quiet: { registryHealth: () => [{ collection: "pipelines", id: "future-lane", reason: "unknown-but-preserved", detail: "stage.kind" }] } });
  await readOnly();
  h.release();
  await h.service.workSettled();
  const snapshot = await (await readOnly()).json() as Snapshot;
  expect(snapshot.workEvidence?.state).toBe("unavailable");
  expect(snapshot.workEvidence?.error).toContain("future-lane");
  expect(snapshot.resumeWork).toBeUndefined();
});

test("a snapshot that fails answers an error at once: the GET says why and the stream's first event is the error", async () => {
  managed({ mode: async () => { throw new Error("launcher record unreadable"); } });
  const response = await within(readOnly(), 2_000);
  expect(response).not.toBe("timed out");
  expect((response as Response).status).toBe(503);
  expect(await (response as Response).json()).toMatchObject({ code: "snapshot-failed", error: "launcher record unreadable" });
  const abort = new AbortController();
  try {
    const first = await within(events(abort.signal)(), 2_000);
    expect(first).toEqual({ event: "snapshot-error", data: { code: "snapshot-failed", error: "launcher record unreadable" } });
  } finally { abort.abort(); }
});

test("a background reader that leaves out the work never starts a reading of it", async () => {
  const h = managed();
  const abort = new AbortController();
  try {
    const snapshot = await (await getSnapshot(new Request(`${BASE}?readOnly=1&work=0`))).json() as Snapshot;
    expect(snapshot).toMatchObject({ mode: "managed", installed: { sha: TARGET } });
    expect(snapshot.workEvidence).toBeUndefined();
    expect(snapshot.resumeWork).toBeUndefined();
    const reader = getEvents(new Request(`${BASE}/events?readOnly=1&work=0`, { signal: abort.signal })).body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: state")) text += decoder.decode((await reader.read()).value);
    expect(text).not.toContain("workEvidence");
    expect(h.reads()).toBe(0);
  } finally { abort.abort(); h.release(); }
});

test("overlapping observations share the one reading in flight and never stack probes", async () => {
  const h = managed();
  const abort = new AbortController();
  try {
    const next = events(abort.signal);
    const answers = await within(Promise.all([readOnly(), readOnly(), readOnly(), next(), readOnly()]), 2_000);
    expect(answers).not.toBe("timed out");
    // The one reading begins on a later turn of the event loop.
    await reached(h.reads, 1);
    expect(h.reads()).toBe(1);
    // A second tab and a poll every second while the reading is still held.
    for (let i = 0; i < 5; i++) { h.advance(1_000); await readOnly(); }
    expect(h.reads()).toBe(1);
    h.release();
    await h.service.workSettled();
    await readOnly();
    expect(h.reads()).toBe(1);
    // A reading that landed is shown again for a moment, then read afresh, once.
    h.hold();
    h.advance(5_000);
    await Promise.all([readOnly(), readOnly(), readOnly()]);
    await reached(h.reads, 2);
    expect(h.reads()).toBe(2);
    const refreshing = await (await readOnly()).json() as Snapshot;
    expect(refreshing.workEvidence?.state).toBe("ready");
    expect(refreshing.resumeWork).toMatchObject({ turns: 0 });
    h.release();
  } finally { abort.abort(); h.release(); }
});

/* The automatic path in checkout mode, as `auto.test.ts` drives it. */
function checkoutAuto() {
  const dir = mkdtempSync(join(root, "checkout-"));
  const record: LauncherRecord = {
    version: 1, launcher: { pid: 100, startIdentity: "launch", autoAdmission: 1 }, checkout: process.cwd(),
    releasesDir: join(dir, "releases"), releasePointer: join(dir, "release.json"), requestFile: join(dir, "request.json"), port: 0, socket: join(dir, "host.sock"), updatedAt: "",
    web: { state: "healthy", pid: 101, startIdentity: "web", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
    runtimeHost: { state: "healthy", pid: 102, startIdentity: "host", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
  };
  let now = Date.parse("2026-01-01T00:00:00Z");
  let turnRunning = false;
  let held: ReturnType<typeof gate> | null = gate();
  let reads = 0;
  writeAuto(join(dir, "auto.json"), { ...initialAuto(), enabled: true, changedAt: new Date(now).toISOString(), green: { [TARGET]: { state: "green" as const } }, rollbackCaptured: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: initialCheck(), update: null, autoPending: null, autoRollbackPointer: null, autoRollbackCaptured: true }));
  const snapshot = (): Snapshot => ({
    mode: "checkout", unsupportedReason: null, available: null, check: idleCheck(), installed: revision(TARGET),
    serving: { web: revision(record.web.revision === TARGET.slice(0, 7) ? TARGET : OLD), runtimeHost: revision(record.runtimeHost.revision === TARGET.slice(0, 7) ? TARGET : OLD) },
    update: idleUpdate(), processes: { web: { ...stoppedProcess(), state: "healthy", lastHealthOk: true, tail: [] }, runtimeHost: { ...stoppedProcess(), state: "healthy", lastHealthOk: true, tail: [] } }, busy: null,
    meta: { branch: "main", remote: "https://github.com/example/project", checkout: record.checkout, pollMinutes: 15, serverTime: new Date(now).toISOString() },
  });
  const deps = {
    now: () => now, env: {}, dir, remote: "https://github.com/example/project", branch: "main", pollMinutes: 15, bun: "bun",
    mode: async () => ({ mode: "checkout", reason: null, record }),
    quiet: {
      runtimeSnapshot: async () => {
        reads++;
        // Only a reading started while the gate is set waits on it.
        if (held) await held.opened;
        return { sessions: turnRunning ? [{ conversationId: "conversation_turn", host: "hosted", turn: "running" }] : [] };
      },
      pipelines: () => [], presence: () => [], memoryAvailableMb: () => 8_192,
    },
    green: { read: async () => ({ state: "green" }) },
    targetOnBranch: async () => true, prune: async () => {}, findDeploymentByIdempotencyKey: async () => null,
    web: { pid: 101, port: 0, startedAt: "" }, processAlive: () => true, processIdentity: (pid: number) => pid === 102 ? "host" : null,
    hostHealth: async () => ({ pid: 102 }), describe: async (_repo: string, sha: string) => revision(sha), buildEnv: () => ({}),
    createRunner: () => ({ state: idleUpdate(), restore: () => {}, start: async () => {}, retry: async () => {}, logPath: () => "" }),
  } as unknown as ServiceDeps;
  const service = new SelfUpdateService(deps);
  service.snapshot = async () => snapshot();
  const pending = () => (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { autoPending?: { role: string } | null }).autoPending ?? null;
  return { dir, service, pending, reads: () => reads, setTurn: (running: boolean) => { turnRunning = running; },
    open: () => { const current = held; held = null; current?.open(); }, advance: (ms: number) => { now += ms; } };
}

test("a displayed reading never authorizes a restart: the automatic path reads fresh custody, pending or landed", async () => {
  const h = checkoutAuto();
  try {
    // The dialog's reading is held open; nothing is said about the work.
    const pendingView = await h.service.observe();
    expect(pendingView.workEvidence?.state).toBe("pending");
    expect(pendingView.resumeWork).toBeUndefined();
    h.open();
    await h.service.workSettled();
    const landed = await h.service.observe();
    expect(landed).toMatchObject({ workEvidence: { state: "ready" }, resumeWork: { turns: 0, stages: 0 } });
    const displayReads = h.reads();

    // A turn starts after the dialog's reading landed. The dialog still shows
    // its reading of "no work"; the drain reads its own and holds the restart.
    h.setTurn(true);
    await h.service.autoTick();
    await h.service.autoTick();
    h.advance(60_000);
    await h.service.autoTick();
    expect(h.reads()).toBeGreaterThan(displayReads);
    expect(activeDrain(join(h.dir, "auto-drain.json"), Date.parse("2026-01-01T00:01:00Z"))?.target).toBe(TARGET);
    expect(h.pending()).toBeNull();
    expect((await h.service.observe()).resumeWork).toMatchObject({ turns: 0 });

    // Once its own reading is quiet, the restart goes ahead on that.
    h.setTurn(false);
    await h.service.autoTick();
    h.advance(60_000);
    await h.service.autoTick();
    expect(h.pending()?.role).toBe("web");
  } finally { h.service.stop(); }
});

const staleCheck = (installed: string) => ({
  slice: { installed: revision(installed), available: revision(TARGET),
    check: { ...idleCheck(), state: "update-available", at: "2026-10-07T08:55:00.000Z", nextPollAt: "2026-10-07T09:55:00.000Z",
      relation: "behind", ahead: 0, behind: 17, delta: { commits: [], summary: { commitCount: 17, entryCount: 0, counts: [], groups: [] } } } },
  update: null,
});

test("the commits-behind badge is gone once both processes serve the available target", async () => {
  // The check ran while OLD was installed; a deployment outside the dialog
  // then moved both processes to TARGET, inside the hour before the next poll.
  const h = managed({ persisted: staleCheck(OLD) });
  h.release();
  const snapshot = await (await readOnly()).json() as Snapshot;
  expect(snapshot.serving.web?.sha).toBe(TARGET);
  expect(snapshot.serving.runtimeHost?.short).toBe(TARGET.slice(0, 7));
  expect(snapshot.available).toBeNull();
  expect(snapshot.check).toMatchObject({ state: "up-to-date", relation: "equal", behind: 0, ahead: 0, delta: null, at: "2026-10-07T08:55:00.000Z" });
  // The correction is the service's own state, so the next process reads it too.
  expect(JSON.parse(readFileSync(join(h.deps.dir, "state.json"), "utf8")).slice.check.behind).toBe(0);
});

test("the badge stays while either process does not serve the available target, and nothing persists as current", async () => {
  for (const options of [{ hostRevision: OLD }, { hostHealth: async () => null }] as const) {
    // TARGET is installed and the web serves it; the runtime host still serves
    // OLD, or does not answer at all.
    const h = managed({ persisted: staleCheck(OLD), installed: TARGET, ...options });
    h.release();
    const snapshot = await (await readOnly()).json() as Snapshot;
    expect(snapshot.serving.web?.sha).toBe(TARGET);
    expect(snapshot.serving.runtimeHost?.sha ?? null).not.toBe(TARGET);
    expect(snapshot.available?.sha).toBe(TARGET);
    expect(snapshot.check).toMatchObject({ state: "update-available", behind: 17 });
    const persisted = JSON.parse(readFileSync(join(h.deps.dir, "state.json"), "utf8")).slice;
    expect(persisted.check).toMatchObject({ state: "update-available", behind: 17 });
    expect(persisted.available.sha).toBe(TARGET);
  }
});

test("a check about the installed revision keeps its answer", async () => {
  const h = managed({ persisted: staleCheck(TARGET), installed: TARGET });
  // TARGET installed, and the check found itself behind something newer.
  const persisted = staleCheck(TARGET);
  persisted.slice.available = revision(NEWER);
  writeFileSync(join(h.deps.dir, "state.json"), JSON.stringify(persisted));
  setSelfUpdateServiceForTests(new SelfUpdateService(h.deps));
  h.release();
  const snapshot = await (await readOnly()).json() as Snapshot;
  expect(snapshot.available?.sha).toBe(NEWER);
  expect(snapshot.check).toMatchObject({ state: "update-available", behind: 17 });
});

/* A checkout whose launcher record says both processes run its HEAD. The
   record is only what the launcher last wrote; the badge clears on what the
   processes answer now. */
async function checkoutServing(hostHealth: ServiceDeps["hostHealth"]) {
  const dir = mkdtempSync(join(root, "checkout-serving-"));
  const checkout = join(dir, "checkout");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: checkout });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  Bun.spawnSync(["mkdir", "-p", checkout]);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "target");
  const head = git("rev-parse", "HEAD");
  const record: LauncherRecord = {
    version: 1, launcher: { pid: 100, startIdentity: "launch", autoAdmission: 1 }, checkout,
    releasesDir: join(dir, "releases"), releasePointer: join(dir, "release.json"), requestFile: join(dir, "request.json"), port: 0, socket: join(dir, "host.sock"), updatedAt: "",
    web: { state: "healthy", pid: 101, startIdentity: "web", startedAt: "", revision: head.slice(0, 7), error: null, requestId: null },
    runtimeHost: { state: "healthy", pid: 102, startIdentity: "host", startedAt: "", revision: head.slice(0, 7), error: null, requestId: null },
  };
  const persisted = staleCheck(OLD);
  persisted.slice.available = revision(head);
  writeFileSync(join(dir, "state.json"), JSON.stringify(persisted));
  const deps = {
    now: () => Date.parse("2026-10-07T09:00:00Z"), env: {}, dir, remote: "https://github.com/example/project", branch: "main", pollMinutes: 60, bun: "bun",
    mode: async () => ({ mode: "checkout", reason: null, record }),
    check: async () => { throw new Error("no network in this test"); },
    web: { pid: 101, port: 0, startedAt: "" }, processAlive: () => true, processIdentity: (pid: number) => pid === 102 ? "host" : null,
    hostHealth, describe: async (_repo: string, sha: string) => revision(sha), buildEnv: () => ({}),
    createRunner: () => ({ state: idleUpdate(), restore: () => {}, start: async () => {}, retry: async () => {}, logPath: () => "" }),
  } as unknown as ServiceDeps;
  const service = new SelfUpdateService(deps);
  return { service, head, persisted: () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).slice };
}

test("in a checkout the badge stays while the runtime host does not answer or answers as another process", async () => {
  const cases: ServiceDeps["hostHealth"][] = [
    async () => null,
    async () => { throw new Error("connect ECONNREFUSED"); },
    async () => ({ pid: 102, startIdentity: "someone else" }) as never,
    async () => ({ pid: 999, startIdentity: "host" }) as never,
  ];
  for (const hostHealth of cases) {
    const h = await checkoutServing(hostHealth);
    try {
      const snapshot = await h.service.snapshot();
      expect(snapshot.installed.sha).toBe(h.head);
      expect(snapshot.processes.runtimeHost).toMatchObject({ state: "failed", lastHealthOk: false });
      expect(snapshot.available?.sha).toBe(h.head);
      expect(snapshot.check).toMatchObject({ state: "update-available", behind: 17 });
      expect(h.persisted().check).toMatchObject({ state: "update-available", behind: 17 });
      expect(h.persisted().available.sha).toBe(h.head);
    } finally { h.service.stop(); }
  }
});

test("in a checkout the badge clears once both processes answer as the ones serving the target", async () => {
  const h = await checkoutServing(async () => ({ pid: 102, startIdentity: "host" }) as never);
  try {
    const snapshot = await h.service.snapshot();
    expect(snapshot.processes.runtimeHost).toMatchObject({ state: "healthy", lastHealthOk: true });
    expect(snapshot.available).toBeNull();
    expect(snapshot.check).toMatchObject({ state: "up-to-date", relation: "equal", behind: 0 });
    expect(h.persisted().check.behind).toBe(0);
    expect(h.persisted().available).toBeNull();
  } finally { h.service.stop(); }
});

test("a stream never replaces a newer state with an older reading that finished late", async () => {
  // The first reading waits on the runtime host; the install moves to NEWER
  // a second later and the reading that change starts answers at once.
  const host = gate();
  let healthReads = 0;
  const h = managed({ hostHealth: async () => {
    if (++healthReads === 1) await host.opened;
    return { pid: 4242, generation: { revision: TARGET } } as never;
  } });
  const abort = new AbortController();
  try {
    const next = events(abort.signal);
    await nextTurn();
    h.deps.releaseTarget = () => ({ revision: NEWER });
    h.advance(1_000);
    h.service.changes.emit();
    const newer = await within(next(), 2_000);
    expect(newer).toMatchObject({ event: "state", data: { installed: { sha: NEWER }, meta: { serverTime: "2026-10-07T09:00:01.000Z" } } });
    host.open();
    // The first reading lands now, about the install as it was; it is not sent.
    expect(await within(next(), 500)).toBe("timed out");
  } finally { abort.abort(); host.open(); h.release(); }
});

/* The answer a new caller gets must not wait for a reading that is already
   running either. The reading is CPU work on the Viewer's own event loop: a
   long-lived installation asks thousands of owners, each answer an already
   settled promise, and no timer or socket runs between them unless the reading
   gives the loop back. The installation is served by a real server on port 0,
   and the callers are another process, so their clock is not the one held. */
test("a new GET and a new SSE subscription arriving after the reading has begun answer before it finishes", async () => {
  const OWNERS = 3_000;
  const sessions = Array.from({ length: OWNERS }, (_, index) => ({ conversationId: `conversation_${index}`, sessionKey: { engine: "codex" },
    cwd: null, artifactPath: null, host: "hosted", turn: "running" }));
  let began = 0;
  let finished = 0;
  let readings = 0;
  const h = managed({ quiet: {
    runtimeSnapshot: async () => ({ sessions }) as never,
    // About a millisecond of reading per owner, answered without any I/O.
    turnLiveness: async () => {
      if (!readings++) began = Date.now();
      blockFor(1);
      if (readings === OWNERS) finished = Date.now();
      return null as never;
    },
  } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) =>
    new URL(request.url).pathname.endsWith("/events") ? getEvents(request) : getSnapshot(request) });
  const client = Bun.spawn([process.execPath, "-e", `
    const base = process.env.SELF_UPDATE_BASE;
    await (await fetch(base + "?readOnly=1")).json();
    await Bun.sleep(300);
    const sent = Date.now();
    const get = fetch(base + "?readOnly=1").then(async (response) => ({ at: Date.now(), body: await response.json() }));
    const sse = fetch(base + "/events?readOnly=1").then(async (response) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        text += decoder.decode(value, { stream: true });
        const state = /event: state\\ndata: (.+)\\n\\n/.exec(text);
        if (state) { const at = Date.now(); void reader.cancel(); return { at, body: JSON.parse(state[1]) }; }
      }
    });
    const [answer, first] = await Promise.all([get, sse]);
    console.log(JSON.stringify({ sent, get: answer, sse: first }));
    process.exit(0);
  `], { env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, SELF_UPDATE_BASE: `http://127.0.0.1:${server.port}/api/self-update` },
    stdout: "pipe", stderr: "inherit" });
  try {
    const output = await new Response(client.stdout).text();
    expect(await client.exited).toBe(0);
    const { sent, get, sse } = JSON.parse(output) as { sent: number; get: { at: number; body: Snapshot }; sse: { at: number; body: Snapshot } };
    await h.service.workSettled();
    expect(readings).toBe(OWNERS);
    // The callers came after the reading began, and it ran on past them.
    expect(began).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(began);
    expect(finished - sent).toBeGreaterThan(1_000);
    for (const answer of [get, sse]) {
      expect(answer.at).toBeLessThan(finished);
      expect(answer.at - sent).toBeLessThan(500);
      expect(answer.body).toMatchObject({ mode: "managed", installed: { sha: TARGET },
        processes: { web: { pid: 4141 }, runtimeHost: { pid: 4242 } }, workEvidence: { state: "pending" } });
    }
  } finally {
    client.kill();
    await server.stop(true);
    h.service.stop();
  }
}, 60_000);
