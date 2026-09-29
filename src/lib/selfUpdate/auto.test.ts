import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialAuto, pruneReleaseWorktrees, readAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, idleUpdate, stoppedProcess, type Snapshot } from "./types";
import type { LauncherRecord } from "./launcher";
import { headOf } from "./release";
import { watchRestartRequests } from "../../../bin/self-update-supervisor.mjs";
import { activeRestartGate, restartGateFile } from "./restartGate";
import { GreenReader } from "./green";
import { proxy } from "../../proxy";
import { POST as postPresence } from "../../app/api/view/presence/route";
import { listPresence, resetPresenceForTest } from "../view/presenceStore";
import { statePath } from "../configDir";
import { NextRequest } from "next/server";
import { watchRestartRequests as watchOldRestartRequests } from "./__fixtures__/preAutoLauncher.mjs";

const root = mkdtempSync("/var/tmp/self-update-auto-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TARGET = "a".repeat(40);
const OLD = "b".repeat(40);

function scenario() {
  const dir = mkdtempSync(join(root, "run-"));
  const record: LauncherRecord = {
    version: 1, launcher: { pid: 100, startIdentity: "launch", autoAdmission: 1 }, checkout: process.cwd(),
    releasesDir: join(dir, "releases"), releasePointer: join(dir, "release.json"), requestFile: join(dir, "request.json"), port: 0, socket: join(dir, "host.sock"), updatedAt: "",
    web: { state: "healthy", pid: 101, startIdentity: "web", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
    runtimeHost: { state: "healthy", pid: 102, startIdentity: "host", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
  };
  let now = Date.parse("2026-01-01T00:00:00Z");
  let prunes = 0;
  let greenState: "green" | "pending" | "red" | "unknown" = "green";
  let turnRunning = false;
  let stageRunning = false;
  const state = { ...initialAuto(), enabled: true, changedAt: new Date(now).toISOString(), green: { [TARGET]: { state: "green" as const } }, rollbackCaptured: true };
  writeAuto(join(dir, "auto.json"), state);
  writeFileSync(join(dir, "state.json"), JSON.stringify({ slice: initialCheck(), update: null, autoPending: null, autoRollbackPointer: null, autoRollbackCaptured: true }));
  const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  const snapshot = (): Snapshot => ({
    mode: "checkout", unsupportedReason: null, available: null, check: idleCheck(), installed: revision(TARGET),
    serving: { web: revision(record.web.revision === TARGET.slice(0, 7) ? TARGET : OLD), runtimeHost: revision(record.runtimeHost.revision === TARGET.slice(0, 7) ? TARGET : OLD) },
    update: idleUpdate(), processes: { web: { ...stoppedProcess(), state: record.web.state, tail: [] }, runtimeHost: { ...stoppedProcess(), state: record.runtimeHost.state, tail: [] } }, busy: null,
    meta: { branch: "main", remote: "https://github.com/example/project", checkout: record.checkout, pollMinutes: 15, serverTime: new Date(now).toISOString() },
  });
  const deps = {
    now: () => now, env: {}, dir, remote: "https://github.com/example/project", branch: "main", pollMinutes: 15, bun: "bun",
    mode: async () => ({ mode: "checkout", reason: null, record }),
    quiet: { runtimeSnapshot: async () => ({ sessions: turnRunning ? [{ turn: "running", host: "hosted" }] : [] }),
      pipelines: () => stageRunning ? [{ state: "running", cursor: { state: "spawning" } }] : [], presence: () => [], memoryAvailableMb: () => 8_192 },
    green: { read: async () => ({ state: greenState }) },
    prune: async () => { prunes += 1; },
  } as unknown as ServiceDeps;
  const service = () => {
    const instance = new SelfUpdateService(deps);
    instance.snapshot = async () => snapshot();
    return instance;
  };
  const pending = () => (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { autoPending?: { role: string; requestId: string } | null }).autoPending ?? null;
  return { dir, record, deps, service, pending, prunes: () => prunes, advance: (ms: number) => { now += ms; }, setGreen: (state: typeof greenState) => { greenState = state; }, setTurn: (running: boolean) => { turnRunning = running; }, setStage: (running: boolean) => { stageRunning = running; } };
}

async function postTypingPresence(role: string): Promise<void> {
  const payload = { schemaVersion: 1, viewSessionId: `typing-${role}`, deviceId: "device-1", device: { kind: "desktop", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 1,
    project: null, mode: "scheme", viewport: { width: 800, height: 600, dpr: 1 }, camera: null, focusedPath: null, selectedPaths: [], visiblePaths: [], board: { renderedRevision: 1, durableRevision: 1, sync: "current" } };
  const request = new NextRequest("http://127.0.0.1:3000/api/view/presence", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(payload) });
  expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  expect((await postPresence(request)).status).toBe(200);
  expect(listPresence().some((session) => session.viewSessionId === payload.viewSessionId)).toBe(true);
}

test.each(["web", "runtime-host"] as const)("an old launcher cannot receive an automatic %s request", async (role) => {
  const h = scenario();
  delete (h.record.launcher as { autoAdmission?: number }).autoAdmission;
  if (role === "runtime-host") h.record.web.revision = TARGET.slice(0, 7);
  const service = h.service();
  expect(await service.setAuto(true)).toMatchObject({ ok: false, code: "auto-unavailable", error: "Automatic updates unavailable: launcher-upgrade" });
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  let restarted = 0;
  const watcher = watchOldRestartRequests(h.record.requestFile, async () => { restarted += 1; }, { intervalMs: 60_000 });
  try {
    await watcher.poll();
    expect(restarted).toBe(0);
    expect(existsSync(h.record.requestFile)).toBe(false);
    expect(h.pending()).toBeNull();
    // The frozen older watcher would have restarted for this extra field.
    writeFileSync(h.record.requestFile, JSON.stringify({ requestId: "control", role, autoGateId: "ignored" }));
    await watcher.poll();
    expect(restarted).toBe(1);
  } finally { watcher.stop(); service.stop(); }
});

test.each(["web", "runtime-host"] as const)("typing through proxy and presence during a delayed green read blocks %s", async (role) => {
  resetPresenceForTest();
  const h = scenario();
  if (role === "runtime-host") h.record.web.revision = TARGET.slice(0, 7);
  h.record.requestFile = join(statePath("self-update"), `request-${role}.json`);
  h.deps.quiet!.presence = (now) => listPresence(now);
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  let releaseGreen: (() => void) | undefined;
  h.deps.green = { read: () => new Promise((resolve) => { releaseGreen = () => resolve({ state: "green" }); }) } as unknown as ServiceDeps["green"];
  // The service holds the admission gate while its fresh GitHub read is pending.
  const deferredService = h.service();
  const tick = deferredService.autoTick();
  for (let i = 0; i < 100 && !activeRestartGate(restartGateFile(h.record.requestFile)); i++) await Bun.sleep(1);
  expect(activeRestartGate(restartGateFile(h.record.requestFile))).not.toBeNull();
  try {
    await postTypingPresence(role);
    releaseGreen?.();
    await tick;
    let restarted = 0;
    const watcher = watchRestartRequests(h.record.requestFile, async () => { restarted += 1; }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => deferredService.admitAutoRestart(requestId, autoGateId) });
    try { await watcher.poll(); } finally { watcher.stop(); }
    expect(restarted).toBe(0);
    expect(h.pending()).toBeNull();
    expect(existsSync(h.record.requestFile)).toBe(false);
  } finally { releaseGreen?.(); resetPresenceForTest(); deferredService.stop(); service.stop(); }
});

test.each(["web", "runtime-host"] as const)("typing before launcher admission blocks %s", async (role) => {
  resetPresenceForTest();
  const h = scenario();
  if (role === "runtime-host") h.record.web.revision = TARGET.slice(0, 7);
  h.record.requestFile = join(statePath("self-update"), `request-final-${role}.json`);
  h.deps.quiet!.presence = (now) => listPresence(now);
  const service = h.service();
  try {
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.pending()?.role).toBe(role);
    await postTypingPresence(`final-${role}`);
    let restarted = 0;
    const watcher = watchRestartRequests(h.record.requestFile, async () => { restarted += 1; }, {
      intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId),
    });
    try { await watcher.poll(); } finally { watcher.stop(); }
    expect(restarted).toBe(0);
    expect(h.pending()).toBeNull();
    expect(existsSync(h.record.requestFile)).toBe(false);
    expect(activeRestartGate(restartGateFile(h.record.requestFile))).toBeNull();
  } finally { resetPresenceForTest(); service.stop(); }
});

test("launcher capability is rechecked after the delayed green read", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  let releaseGreen: (() => void) | undefined;
  h.deps.green = { read: () => new Promise((resolve) => { releaseGreen = () => resolve({ state: "green" }); }) } as unknown as ServiceDeps["green"];
  const current = h.service();
  const tick = current.autoTick();
  for (let i = 0; i < 100 && !activeRestartGate(restartGateFile(h.record.requestFile)); i++) await Bun.sleep(1);
  expect(activeRestartGate(restartGateFile(h.record.requestFile))).not.toBeNull();
  delete (h.record.launcher as { autoAdmission?: number }).autoAdmission;
  try {
    releaseGreen?.();
    await tick;
    expect(existsSync(h.record.requestFile)).toBe(false);
    expect(h.pending()).toBeNull();
    expect(activeRestartGate(restartGateFile(h.record.requestFile))).toBeNull();
  } finally { releaseGreen?.(); current.stop(); service.stop(); }
});

test("a previously taken request still records failure when launcher capability is absent", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  const pending = h.pending()!;
  delete (h.record.launcher as { autoAdmission?: number }).autoAdmission;
  h.record.web = { ...h.record.web, requestId: pending.requestId, state: "healthy", error: { kind: "fell-back", revision: OLD.slice(0, 7), detail: "health probe failed" } };
  await service.autoTick();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, off: { stage: "restart-web", reason: "health probe failed" } });
  expect(h.pending()).toBeNull();
  service.stop();
});

test("two quiet probes persist a web request; a fresh process continues with the host", async () => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  expect(existsSync(h.record.requestFile)).toBe(false);
  h.advance(60_000);
  await service.autoTick();
  const web = h.pending()!;
  expect(web.role).toBe("web");
  expect(JSON.parse(readFileSync(join(h.dir, "auto.json"), "utf8"))).not.toHaveProperty("pending");
  expect(JSON.parse(readFileSync(h.record.requestFile, "utf8")).requestId).toBe(web.requestId);
  let watcher = watchRestartRequests(h.record.requestFile, async ({ requestId, role }) => {
    expect(role).toBe("web");
    h.record.web = { ...h.record.web, revision: TARGET.slice(0, 7), requestId };
  }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId) });
  await watcher.poll();
  watcher.stop();
  service = h.service();
  await service.autoTick();
  expect(h.pending()).toBeNull();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe("runtime-host");
  watcher = watchRestartRequests(h.record.requestFile, async ({ requestId, role }) => {
    expect(role).toBe("runtime-host");
    h.record.runtimeHost = { ...h.record.runtimeHost, revision: TARGET.slice(0, 7), requestId };
  }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId) });
  await watcher.poll();
  watcher.stop();
  service = h.service();
  await service.autoTick();
  await service.autoTick();
  expect(h.prunes()).toBe(1);
  expect(readAuto(join(h.dir, "auto.json")).waitingSince).toBeNull();
  service.stop();
});

test.each(["pending", "red", "unknown"] as const)("a cached green changed to %s during the quiet wait cannot restart, even after reconstruction", async (state) => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.setGreen(state);
  h.advance(60_000);
  await service.autoTick();
  expect(existsSync(h.record.requestFile)).toBe(false);
  expect(h.pending()).toBeNull();
  service.stop();
  service = h.service();
  await service.autoTick();
  expect(existsSync(h.record.requestFile)).toBe(false);
  expect(h.pending()).toBeNull();
  service.stop();
});

test.each(["failure", "pending"] as const)("a latest %s status with a tied timestamp issues no automatic restart", async (latest) => {
  const h = scenario();
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/pulls") ? [{ merged_at: "2026-01-01", merge_commit_sha: TARGET, base: { ref: "main" }, head: { sha: OLD } }]
      : url.includes("/check-runs") ? { check_runs: [] }
      : url.includes("/statuses") ? [
        { id: 20, context: "build", state: latest, created_at: "2026-01-01T00:00:00Z" },
        { id: 10, context: "build", state: "success", created_at: "2026-01-01T00:00:00Z" },
      ]
      : url.includes("/branches/") ? { protected: true, protection: { required_status_checks: { contexts: ["build"] } } }
      : { commit: { tree: { sha: "c".repeat(40) } } };
    return Response.json(body);
  };
  h.deps.green = new GreenReader({ fetch: fetcher as typeof fetch, treeOf: async () => "c".repeat(40), now: h.deps.now });
  const service = h.service();
  try {
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(readAuto(join(h.dir, "auto.json")).green[TARGET]?.state).toBe(latest === "failure" ? "red" : "pending");
    expect(h.pending()).toBeNull();
    expect(existsSync(h.record.requestFile)).toBe(false);
  } finally { service.stop(); }
});

test.each([["web", "turn"], ["web", "stage"], ["runtime-host", "turn"], ["runtime-host", "stage"]] as const)("%s restart defers when a %s starts before launcher consumption", async (role, work) => {
  const h = scenario();
  if (role === "runtime-host") h.record.web.revision = TARGET.slice(0, 7);
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe(role);
  if (work === "turn") h.setTurn(true);
  else h.setStage(true);
  let restarted = false;
  const watcher = watchRestartRequests(h.record.requestFile, async () => { restarted = true; }, {
    intervalMs: 60_000,
    admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId),
  });
  await watcher.poll();
  watcher.stop();
  expect(restarted).toBe(false);
  expect(h.pending()).toBeNull();
  expect(existsSync(h.record.requestFile)).toBe(false);
  h.setTurn(false);
  h.setStage(false);
  service.stop();
});

test.each(["pending", "red", "unknown"] as const)("launcher admission refuses a newly %s check after service reconstruction", async (state) => {
  const h = scenario();
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  service.stop();
  h.setGreen(state);
  service = h.service();
  let restarted = false;
  const watcher = watchRestartRequests(h.record.requestFile, async () => { restarted = true; }, {
    intervalMs: 60_000,
    admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId),
  });
  await watcher.poll();
  watcher.stop();
  expect(restarted).toBe(false);
  expect(h.pending()).toBeNull();
  expect(existsSync(h.record.requestFile)).toBe(false);
  service.stop();
});

test("a web fallback restores the pointer and turns the switch off", async () => {
  const h = scenario();
  writeFileSync(h.record.releasePointer, JSON.stringify({ sha: TARGET, dir: h.record.releasesDir, checkoutHead: headOf(process.cwd()) }));
  let service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  const pending = h.pending()!;
  h.record.web = { ...h.record.web, state: "healthy", requestId: pending.requestId, error: { kind: "fell-back", revision: OLD.slice(0, 7), detail: "health probe failed" } };
  service = h.service();
  await service.autoTick();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, off: { stage: "restart-web" }, pending: null });
  expect(h.pending()).toBeNull();
  expect(existsSync(h.record.releasePointer)).toBe(false);
  service.stop();
});

test("a 24-hour wait records one notice while still allowing future quiet probes", async () => {
  const h = scenario();
  const file = join(h.dir, "auto.json");
  writeAuto(file, { ...readAuto(file), waitingSince: new Date(Date.parse("2025-12-30T23:00:00Z")).toISOString() });
  const service = h.service();
  await service.autoTick();
  const notice = readAuto(file).noticeAt;
  expect(notice).not.toBeNull();
  await service.autoTick();
  expect(readAuto(file).noticeAt).toBe(notice);
  expect(readAuto(file).enabled).toBe(true);
  service.stop();
});

test("a checkout target change preserves the cumulative wait and its recorded notice", async () => {
  const h = scenario();
  const file = join(h.dir, "auto.json");
  const waitingSince = "2025-12-30T23:00:00.000Z";
  const noticeAt = "2025-12-31T23:30:00.000Z";
  writeAuto(file, { ...readAuto(file), waitingSince, waitingTarget: OLD, noticeAt });
  h.setTurn(true);
  const service = h.service();
  const snapshot = await service.snapshot();
  const waitForAutoQuiet = (service as unknown as {
    waitForAutoQuiet(snapshot: Snapshot, target: string, now: number): Promise<boolean>;
  }).waitForAutoQuiet.bind(service);
  await waitForAutoQuiet(snapshot, TARGET, Date.parse("2026-01-01T00:00:00.000Z"));
  expect(readAuto(file)).toMatchObject({ waitingSince, waitingTarget: TARGET, noticeAt });
  service.stop();
});

test("an untaken request times out, is removed, and disables auto-apply", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe("web");
  h.advance(5 * 60_000);
  await service.autoTick();
  expect(h.pending()).toBeNull();
  expect(existsSync(h.record.requestFile)).toBe(false);
  expect(activeRestartGate(restartGateFile(h.record.requestFile))).toBeNull();
  expect(readAuto(join(h.dir, "auto.json"))).toMatchObject({ enabled: false, off: { stage: "restart-web", reason: "the launcher did not take the restart request" } });
  service.stop();
});

test("a new launcher generation drops its old request and re-reads facts", async () => {
  const h = scenario();
  const service = h.service();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  h.record.launcher.pid = 200;
  await service.autoTick();
  expect(h.pending()).toBeNull();
  expect(existsSync(h.record.requestFile)).toBe(false);
  expect(activeRestartGate(restartGateFile(h.record.requestFile))).toBeNull();
  expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(true);
  service.stop();
});

test("release cleanup only removes a registered old worktree under the release root", async () => {
  const h = scenario();
  const shas = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));
  const dirs = shas.map((sha) => join(h.record.releasesDir, sha.slice(0, 12)));
  for (const [index, dir] of dirs.entries()) {
    mkdirSync(dir, { recursive: true });
    utimesSync(dir, new Date((index + 1) * 1_000), new Date((index + 1) * 1_000));
  }
  h.record.web.revision = shas[0]!.slice(0, 7);
  h.record.runtimeHost.revision = shas[0]!.slice(0, 7);
  writeFileSync(h.record.releasePointer, JSON.stringify({ sha: shas[0], dir: dirs[0] }));
  const commands: string[][] = [];
  const run = async (args: string[]) => {
    commands.push(args);
    return { code: 0, stdout: args[1] === "list" ? dirs.map((dir, index) => `worktree ${dir}\nHEAD ${shas[index]}\n`).join("\n") : "", stderr: "" };
  };
  await pruneReleaseWorktrees(h.record, JSON.stringify({ sha: shas[1], dir: dirs[1] }), run);
  expect(commands).toEqual([["worktree", "list", "--porcelain"], ["worktree", "remove", "--force", dirs[2]!], ["worktree", "prune"]]);
});
