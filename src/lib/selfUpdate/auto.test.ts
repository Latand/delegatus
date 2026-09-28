import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideAuto, initialAuto, pruneReleaseWorktrees, readAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, idleUpdate, stoppedProcess, type Snapshot } from "./types";
import type { LauncherRecord } from "./launcher";
import { headOf } from "./release";

const root = mkdtempSync("/var/tmp/self-update-auto-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TARGET = "a".repeat(40);
const OLD = "b".repeat(40);

function scenario() {
  const dir = mkdtempSync(join(root, "run-"));
  const record: LauncherRecord = {
    version: 1, launcher: { pid: 100, startIdentity: "launch" }, checkout: process.cwd(),
    releasesDir: join(dir, "releases"), releasePointer: join(dir, "release.json"), requestFile: join(dir, "request.json"), port: 0, socket: join(dir, "host.sock"), updatedAt: "",
    web: { state: "healthy", pid: 101, startIdentity: "web", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
    runtimeHost: { state: "healthy", pid: 102, startIdentity: "host", startedAt: "", revision: OLD.slice(0, 7), error: null, requestId: null },
  };
  let now = Date.parse("2026-01-01T00:00:00Z");
  let prunes = 0;
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
    quiet: { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: () => [], presence: () => [], memoryAvailableMb: () => 8_192 },
    prune: async () => { prunes += 1; },
  } as unknown as ServiceDeps;
  const service = () => {
    const instance = new SelfUpdateService(deps);
    instance.snapshot = async () => snapshot();
    return instance;
  };
  const pending = () => (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { autoPending?: { role: string; requestId: string } | null }).autoPending ?? null;
  return { dir, record, service, pending, prunes: () => prunes, advance: (ms: number) => { now += ms; } };
}

test("the decision table preserves green and quiet gates", () => {
  const facts = { enabled: true, available: true, relation: "behind", green: { state: "green" as const }, built: false, webCurrent: false, hostCurrent: false, busy: false };
  expect(decideAuto({ ...facts, enabled: false })).toBe("none");
  expect(decideAuto({ ...facts, green: null })).toBe("read-green");
  expect(decideAuto(facts)).toBe("build");
  expect(decideAuto({ ...facts, built: true })).toBe("wait-web");
  expect(decideAuto({ ...facts, built: true, webCurrent: true })).toBe("wait-host");
  expect(decideAuto({ ...facts, built: true, webCurrent: true, hostCurrent: true })).toBe("done");
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
  h.record.web = { ...h.record.web, revision: TARGET.slice(0, 7), requestId: web.requestId };
  rmSync(h.record.requestFile);
  service = h.service();
  await service.autoTick();
  expect(h.pending()).toBeNull();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe("runtime-host");
  const host = h.pending()!;
  h.record.runtimeHost = { ...h.record.runtimeHost, revision: TARGET.slice(0, 7), requestId: host.requestId };
  rmSync(h.record.requestFile);
  service = h.service();
  await service.autoTick();
  await service.autoTick();
  expect(h.prunes()).toBe(1);
  expect(readAuto(join(h.dir, "auto.json")).waitingSince).toBeNull();
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
