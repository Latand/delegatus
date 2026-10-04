import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialAuto, pruneReleaseWorktrees, readAuto, writeAuto } from "./auto";
import { initialCheck } from "./checkState";
import { SelfUpdateService, type ServiceDeps } from "./service";
import { idleCheck, idleUpdate, stoppedProcess, type Snapshot } from "./types";
import type { LauncherRecord } from "./launcher";
import { headOf } from "./release";
import { targetOnCurrentBranch } from "./git";
import { watchRestartRequests } from "../../../bin/self-update-supervisor.mjs";
import { activeRestartGate, beginRestartGate, endRestartGate, restartGateFile } from "./restartGate";
import { activeDrain, writeDrain, DRAIN_NOTICE_MS, DRAIN_LEASE_MS } from "./drain";
import { startCurrentReleaseControllers } from "../viewerInstrumentation";
import { GreenReader } from "./green";
import { proxy } from "../../proxy";
import { POST as postPresence } from "../../app/api/view/presence/route";
import { listPresence, resetPresenceForTest } from "../view/presenceStore";
import { statePath } from "../configDir";
import { NextRequest } from "next/server";
import { spawnSync } from "node:child_process";
import { UpdateRunner } from "./steps";
import { watchRestartRequests as watchOldRestartRequests } from "./__fixtures__/preAutoLauncher.mjs";

const root = mkdtempSync("/var/tmp/self-update-auto-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TARGET = "a".repeat(40);
const OLD = "b".repeat(40);

test.each(["before-tick", "mode-wait", "submitted-wait", "ancestor", "taken-web"] as const)("checkout admission fetches real main ancestry at %s", async (seam) => {
  const h = scenario();
  const remote = join(h.dir, "remote");
  const checkout = join(h.dir, "checkout");
  mkdirSync(remote);
  const git = (args: string[], cwd = remote) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  const commit = (label: string) => {
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", label]);
    return git(["rev-parse", "HEAD"]);
  };
  const old = commit("old");
  const target = commit("candidate");
  const descendant = commit("newer main");
  git(["checkout", "--detach", old]);
  const replacement = commit("rewritten main");
  git(["clone", remote, checkout]);
  h.record.checkout = checkout;
  h.record.web.revision = h.record.runtimeHost.revision = old.slice(0, 7);
  const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  const since = new Date(h.deps.now()).toISOString();
  writeAuto(join(h.dir, "auto.json"), { ...readAuto(join(h.dir, "auto.json")), waitingSince: since, waitingTarget: target,
    drain: { id: "checkout-ancestry", target: revision(target), since, overranAt: null, blockers: null } });
  let ancestryReads = 0;
  h.deps.targetOnBranch = async (repo, sha) => { ancestryReads++; return targetOnCurrentBranch(repo, remote, "main", sha); };
  let modeReads = 0;
  h.deps.mode = async () => {
    modeReads++;
    if (seam === "mode-wait" && modeReads === 3) {
      await Promise.resolve();
      git(["branch", "-f", "main", replacement]);
    }
    return { mode: "checkout", reason: null, record: h.record };
  };
  if (seam === "before-tick") git(["branch", "-f", "main", replacement]);
  const service = h.service();
  const snapshot = service.snapshot;
  service.snapshot = async () => ({ ...await snapshot(), installed: revision(target), available: revision(replacement),
    serving: { web: revision(h.record.web.revision === target.slice(0, 7) ? target : old), runtimeHost: revision(h.record.runtimeHost.revision === target.slice(0, 7) ? target : old) } });
  let launches = 0;
  const watcher = watchRestartRequests(h.record.requestFile, async ({ requestId, role }) => {
    launches++;
    const entry = role === "web" ? h.record.web : h.record.runtimeHost;
    entry.requestId = requestId; entry.revision = target.slice(0, 7);
  }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId) });
  try {
    await service.autoTick(); h.advance(60_000); await service.autoTick();
    if (seam === "taken-web") {
      await watcher.poll();
      expect(launches).toBe(1);
      await service.autoTick(); // Observe the already taken web receipt.
      git(["branch", "-f", "main", replacement]);
      await service.autoTick(); h.advance(60_000); await service.autoTick();
      await watcher.poll();
      expect(launches).toBe(2); // Host finishes the release that web already took.
      return;
    }
    if (seam === "submitted-wait") git(["branch", "-f", "main", replacement]);
    await watcher.poll();
    expect(launches).toBe(seam === "ancestor" ? 1 : 0);
    if (seam !== "ancestor") {
      expect(ancestryReads).toBeGreaterThan(0);
      expect(h.pending()).toBeNull();
      expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe("checkout-ancestry");
      git(["branch", "-f", "main", descendant]);
      await service.autoTick(); h.advance(60_000); await service.autoTick();
      await watcher.poll();
      expect(launches).toBe(1);
    }
  } finally { watcher.stop(); service.stop(); }
});

test.each(["hot", "cold", "rollback-hot", "rollback-cold"] as const)("a successful manual newer checkout settles the frozen cohort after %s recovery", async (recovery) => {
  const h = scenario();
  const checkout = join(h.dir, "checkout");
  mkdirSync(checkout);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "manual release");
  const newer = git("rev-parse", "HEAD");
  h.record.checkout = checkout;
  const since = new Date(h.deps.now()).toISOString();
  const rollback = recovery.startsWith("rollback-");
  const drain = { id: "manual-checkout-drain", target: { sha: TARGET, short: TARGET.slice(0, 7), version: "1", date: "" }, since, overranAt: null, blockers: null, admitted: rollback };
  writeAuto(join(h.dir, "auto.json"), { ...readAuto(join(h.dir, "auto.json")), enabled: !rollback, drain, rollback: rollback ? { target: OLD } : null, waitingSince: since, waitingTarget: TARGET });
  writeDrain(join(h.dir, "auto-drain.json"), { id: drain.id, target: TARGET, since, until: h.deps.now() + DRAIN_LEASE_MS, persistent: true });
  const automaticBuilds: string[] = [];
  let update = idleUpdate();
  let hostHealthy = false;
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  h.deps.hostHealth = async () => hostHealthy ? { pid: 102, startIdentity: "host", hostEpoch: 1 } : null;
  h.deps.createRunner = () => ({ get state() { return update; }, restore: (saved) => { update = saved; },
    start: async (target) => { automaticBuilds.push(target); update = { ...idleUpdate(), state: "running", trigger: "auto", target }; }, retry: async () => {}, logPath: () => "" });
  let service = new SelfUpdateService(h.deps); // Real checkout projection reads the pointer, runner and host RPC.
  try {
    await service.snapshot();
    update = { ...idleUpdate(), state: "done", trigger: "operator", target: newer, startedAt: since, finishedAt: since };
    h.record.web.revision = newer.slice(0, 7);
    if (recovery.endsWith("cold")) {
      service.stop();
      const saved = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
      writeFileSync(join(h.dir, "state.json"), JSON.stringify({ ...saved, update }));
      service = new SelfUpdateService(h.deps);
    }
    const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
    await service.autoTick();
    expect(held()?.id).toBe(drain.id);
    expect(automaticBuilds).toEqual([]);
    h.record.runtimeHost.revision = newer.slice(0, 7);
    await service.autoTick();
    expect(held()?.id).toBe(drain.id);
    expect(automaticBuilds).toEqual([]);
    hostHealthy = true;
    await service.autoTick();
    expect(held()).toBeNull();
    expect(readAuto(join(h.dir, "auto.json")).drain).toBeNull();
    expect(readAuto(join(h.dir, "auto.json")).rollback).toBeNull();
    expect(automaticBuilds).toEqual([]);
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

test("checkout drain holds through web and host restarts and releases only when both serve", async () => {
  const h = scenario();
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  h.setTurn(true);
  let service = h.service();
  await service.autoTick();
  await service.autoTick();
  const lease = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  expect(lease()?.target).toBe(TARGET);
  expect(h.pending()).toBeNull();
  h.setTurn(false);
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  const web = h.pending()!;
  expect(web.role).toBe("web");
  endRestartGate(restartGateFile(h.record.requestFile), JSON.parse(readFileSync(h.record.requestFile, "utf8")).autoGateId);
  rmSync(h.record.requestFile);
  h.record.web = { ...h.record.web, revision: TARGET.slice(0, 7), requestId: web.requestId };
  service.stop();
  service = h.service();
  await service.autoTick();
  expect(lease()).not.toBeNull();
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  const host = h.pending()!;
  expect(host.role).toBe("runtime-host");
  endRestartGate(restartGateFile(h.record.requestFile), JSON.parse(readFileSync(h.record.requestFile, "utf8")).autoGateId);
  rmSync(h.record.requestFile);
  h.record.runtimeHost = { ...h.record.runtimeHost, revision: TARGET.slice(0, 7), requestId: host.requestId };
  await service.autoTick();
  await service.autoTick();
  expect(lease()).toBeNull();
  expect(ticks).toBe(1);
  service.stop();
});

test.each(["pending-web", "between-roles"] as const)("switch-off at %s retains early checkout custody through cold recovery and both roles", async (point) => {
  const h = scenario();
  let service = h.service();
  const lease = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  await service.autoTick();
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe("web");
  expect(lease()).not.toBeNull();
  if (point === "pending-web") expect(await service.setAuto(false)).toEqual({ ok: true });
  let watcher = watchRestartRequests(h.record.requestFile, async ({ requestId }) => {
    h.record.web = { ...h.record.web, requestId, revision: TARGET.slice(0, 7) };
  }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId) });
  try { await watcher.poll(); } finally { watcher.stop(); }
  await service.autoTick();
  expect(h.pending()).toBeNull();
  if (point === "between-roles") expect(await service.setAuto(false)).toEqual({ ok: true });
  expect(lease()).not.toBeNull();
  service.stop();
  h.advance(DRAIN_LEASE_MS + 1);
  service = h.service();
  service.startAuto();
  expect(lease()).not.toBeNull();
  // Let the startup tick finish before the second quiet observation.
  for (let i = 0; i < 100 && !readAuto(join(h.dir, "auto.json")).quietSince; i++) await Bun.sleep(1);
  h.advance(60_000);
  await service.autoTick();
  expect(h.pending()?.role).toBe("runtime-host");
  expect(lease()).not.toBeNull();
  watcher = watchRestartRequests(h.record.requestFile, async ({ requestId }) => {
    h.record.runtimeHost = { ...h.record.runtimeHost, requestId, revision: TARGET.slice(0, 7) };
  }, { intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId) });
  try { await watcher.poll(); } finally { watcher.stop(); }
  await service.autoTick();
  await service.autoTick();
  expect(lease()).toBeNull();
  expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
  service.stop();
});

test("the six-hour notice retains launches between checkout restart roles", async () => {
  const h = scenario();
  h.setTurn(true);
  const service = h.service();
  await service.autoTick();
  await service.autoTick();
  h.record.web.revision = TARGET.slice(0, 7);
  h.advance(DRAIN_NOTICE_MS);
  await service.autoTick();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  expect(readAuto(join(h.dir, "auto.json")).drain?.overranAt).not.toBeNull();
  service.stop();
});

test("a ready update immediately holds admission and a three-hour cohort still deploys", async () => {
  const h = scenario();
  h.setTurn(true);
  const service = h.service();
  try {
    await service.autoTick();
    const lease = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
    expect(lease).not.toBeNull();
    h.advance(3 * 60 * 60_000);
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(lease!.id);
    expect(h.pending()).toBeNull();
    h.setTurn(false);
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    expect(h.pending()?.role).toBe("web");
  } finally { service.stop(); }
});

test("a pending green checkout update holds admission before its candidate build", async () => {
  const h = scenario();
  h.setTurn(true);
  const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  const stateFile = join(h.dir, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.slice.available = revision(TARGET);
  writeFileSync(stateFile, JSON.stringify(state));
  const createRunner = h.deps.createRunner;
  let holdAtBuild: ReturnType<typeof activeDrain> = null;
  let finishBuild!: () => void;
  let building = false;
  h.deps.createRunner = (...args) => ({ ...createRunner(...args), start: async () => {
    holdAtBuild = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
    building = true;
    await new Promise<void>((resolve) => { finishBuild = resolve; });
  } });
  const service = h.service();
  const snapshot = service.snapshot.bind(service);
  service.snapshot = async () => ({ ...await snapshot(), installed: revision(OLD), available: revision(TARGET), busy: building ? "update" : null });
  try {
    await service.autoTick();
    expect(holdAtBuild).not.toBeNull();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.target).toBe(TARGET);
    h.advance(3 * 60 * 60_000);
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.target).toBe(TARGET);
  } finally { service.stop(); finishBuild?.(); }
});

test("checkout advances an unaccepted red target to a green build under the original drain after restart", async () => {
  const h = scenario();
  const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  const newer = "c".repeat(40);
  let available = TARGET;
  const builds: string[] = [];
  let finishBuild!: () => void;
  writeAuto(join(h.dir, "auto.json"), { ...initialAuto(), enabled: true });
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ slice: {
    ...initialCheck(), installed: revision(OLD), available: revision(TARGET),
    check: { ...idleCheck(), state: "update-available", relation: "behind" },
  }, update: null }));
  h.deps.check = async () => ({ ok: true, installed: revision(OLD), available: revision(available), relation: "behind", ahead: 0, behind: 2, delta: null });
  h.deps.green = { read: async (_remote: string, _branch: string, target: string) => ({ state: target === TARGET ? "red" : "green" }) } as unknown as ServiceDeps["green"];
  h.deps.createRunner = () => ({ state: idleUpdate(), restore: () => {}, retry: async () => {}, logPath: () => "",
    start: async target => {
      builds.push(target);
      await new Promise<void>(resolve => { finishBuild = resolve; });
    } });
  const createService = () => {
    const instance = h.service();
    const snapshot = instance.snapshot.bind(instance);
    instance.snapshot = async () => ({ ...await snapshot(), installed: revision(OLD), available: revision(available), busy: builds.length ? "update" : null });
    return instance;
  };
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  let service = createService();
  try {
    await service.autoTick();
    const original = held()!;
    expect(original.target).toBe(TARGET);
    expect(builds).toHaveLength(0);
    service.stop();
    h.advance(DRAIN_LEASE_MS + 1);
    service = createService();
    available = newer;
    await service.check();
    await Bun.sleep(0);
    expect(held()).toMatchObject({ id: original.id, target: newer, since: original.since });
    await service.autoTick();
    expect(builds).toEqual([newer]);
    expect(held()).toMatchObject({ id: original.id, target: newer, since: original.since });
    expect(readAuto(join(h.dir, "auto.json")).waitingSince).toBe(original.since);
    expect(h.pending()).toBeNull();
  } finally { finishBuild?.(); service.stop(); }
});

test("six hours names blockers for an operator decision while admission remains held", async () => {
  const h = scenario();
  h.setTurn(true);
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_long_turn", engine: "codex", host: "hosted", turn: "running" }] }) as never;
  const service = h.service();
  try {
    await service.autoTick();
    h.advance(6 * 60 * 60_000);
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    const drain = readAuto(join(h.dir, "auto.json")).drain;
    expect(drain?.overranAt).not.toBeNull();
    expect(drain?.blockers?.turnList?.[0]?.conversationId).toBe("conversation_long_turn");
    expect(h.pending()).toBeNull();
  } finally { service.stop(); }
});

test.each(["red", "pending", "unknown"] as const)("a pending checkout update holds admission before its first %s result", async state => {
  const h = scenario(); h.setGreen(state); h.setTurn(true);
  const file = join(h.dir, "auto.json");
  writeAuto(file, { ...readAuto(file), green: {} });
  const service = h.service();
  try {
    await service.autoTick();
    const hold = activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
    expect(hold).not.toBeNull();
    h.advance(DRAIN_NOTICE_MS); await service.autoTick();
    expect(readAuto(file).drain?.overranAt).not.toBeNull();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(hold!.id);
    expect(h.pending()).toBeNull();
  } finally { service.stop(); }
});

test.each(["red", "pending", "unknown"] as const)("six-hour cohort notice survives %s checks in checkout mode", async state => {
  const h = scenario();
  h.deps.quiet!.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_original", engine: "codex", host: "hosted", turn: "running" }] }) as never;
  let service = h.service();
  try {
    await service.autoTick(); h.setGreen(state);
    service.stop();
    const file = join(h.dir, "auto.json");
    const saved = readAuto(file);
    writeAuto(file, { ...saved, green: { ...saved.green, [TARGET]: { ...saved.green[TARGET], state } } });
    service = h.service(); h.advance(DRAIN_NOTICE_MS + 60_000);
    await service.autoTick();
    const auto = readAuto(join(h.dir, "auto.json"));
    expect(auto.green[TARGET]?.state).toBe(state);
    expect(auto.drain?.overranAt).not.toBeNull();
    expect(auto.drain?.blockers?.turnList?.[0]?.conversationId).toBe("conversation_original");
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    expect(h.pending()).toBeNull();
  } finally { service.stop(); }
});

test.each(["keep-waiting", "deploy-now"] as const)("the operator's %s decision preserves custody and fences stale replies", async (choice) => {
  const h = scenario();
  h.setTurn(true);
  const service = h.service();
  try {
    await service.autoTick();
    h.advance(DRAIN_NOTICE_MS);
    await service.autoTick();
    const drain = readAuto(join(h.dir, "auto.json")).drain!;
    expect(await service.decideDrain("old-decision", choice)).toMatchObject({ ok: false });
    expect(await service.decideDrain(drain.id, choice)).toEqual({ ok: true });
    expect(await service.decideDrain(drain.id, choice)).toMatchObject({ ok: false });
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id).toBe(drain.id);
    if (choice === "deploy-now") expect(h.pending()?.role).toBe("web");
    else {
      expect(h.pending()).toBeNull();
      h.advance(12 * 60 * 60_000);
      await service.autoTick();
      expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
      h.setTurn(false);
      await service.autoTick();
      h.advance(60_000);
      await service.autoTick();
      expect(h.pending()?.role).toBe("web");
    }
  } finally { service.stop(); }
});

test("host fallback holds custody across recovery until web rollback is observed", async () => {
  const h = scenario();
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  h.record.web.revision = TARGET.slice(0, 7);
  let service = h.service();
  try {
    await service.autoTick();
    h.advance(60_000);
    await service.autoTick();
    const pending = h.pending()!;
    expect(pending.role).toBe("runtime-host");
    rmSync(h.record.requestFile);
    h.record.runtimeHost = { ...h.record.runtimeHost, requestId: pending.requestId,
      error: { kind: "fell-back", revision: OLD.slice(0, 7), detail: "host candidate failed" } };
    await service.autoTick();
    expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    expect(ticks).toBe(0);
    service.stop();
    h.advance(DRAIN_LEASE_MS + 1);
    service = h.service();
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    expect(ticks).toBe(0);
    h.record.web.revision = OLD.slice(0, 7);
    h.record.web.state = "starting";
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
    h.record.web.state = "healthy";
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

test.each(["failed", "missing", "wrong-pid", "wrong-identity", "web-away", "web-gone", "host-gone", "mixed"] as const)("real rollback snapshot retains custody with %s evidence across recovery", async (evidence) => {
  const h = scenario();
  const drain = { id: "rollback-drain", target: { sha: TARGET, short: TARGET.slice(0, 7), version: "1", date: "" }, since: new Date(h.deps.now()).toISOString(), overranAt: null, blockers: null, admitted: true };
  writeAuto(join(h.dir, "auto.json"), { ...initialAuto(), enabled: false, drain, rollback: { target: OLD } });
  writeDrain(join(h.dir, "auto-drain.json"), { id: drain.id, target: TARGET, since: drain.since, until: h.deps.now() + DRAIN_LEASE_MS, persistent: true });
  let healthy = false;
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  h.deps.hostHealth = async () => {
    if (!healthy && evidence === "failed") throw new Error("host health unavailable");
    if (!healthy && evidence === "missing") return null;
    return { pid: !healthy && evidence === "wrong-pid" ? 999 : 102, startIdentity: !healthy && evidence === "wrong-identity" ? "another-host" : "host", hostEpoch: 1 };
  };
  h.deps.processAlive = (pid) => healthy || !(evidence === "web-gone" && pid === 101 || evidence === "host-gone" && pid === 102);
  if (evidence === "web-away") h.deps.web = { ...h.deps.web, pid: 999 };
  if (evidence === "mixed") h.record.web.revision = TARGET.slice(0, 7);
  let service = new SelfUpdateService(h.deps); // Use checkoutPart, including fresh host RPC and PID checks.
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  try {
    for (let recovery = 0; recovery < 2; recovery++) {
      await service.autoTick();
      expect(held()?.id).toBe(drain.id);
      expect(readAuto(join(h.dir, "auto.json")).rollback).not.toBeNull();
      expect(ticks).toBe(0);
      service.stop();
      h.advance(DRAIN_LEASE_MS + 1);
      service = new SelfUpdateService(h.deps);
    }
    healthy = true;
    h.deps.web = { ...h.deps.web, pid: 101 };
    h.record.web.revision = OLD.slice(0, 7);
    await service.autoTick();
    expect(held()).toBeNull();
    expect(readAuto(join(h.dir, "auto.json")).rollback).toBeNull();
    await service.autoTick();
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

test("real checkout runner deploys a frozen green ancestor after main advances during pre-build waiting", async () => {
  const h = scenario();
  const remote = join(h.dir, "remote");
  const checkout = join(h.dir, "checkout");
  mkdirSync(remote);
  const git = (args: string[], cwd = remote) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  const commit = (label: string) => {
    writeFileSync(join(remote, "example.txt"), label);
    git(["add", "example.txt"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", label]);
    return git(["rev-parse", "HEAD"]);
  };
  const old = commit("old");
  const target = commit("candidate");
  git(["clone", "-q", remote, checkout]);
  git(["checkout", "-q", "--detach", old], checkout);
  h.record.checkout = checkout;
  h.record.web.revision = h.record.runtimeHost.revision = old.slice(0, 7);
  const revision = (sha: string) => ({ sha, short: sha.slice(0, 7), version: "1", date: "" });
  // A check already in flight delays the build while the original cohort runs.
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), installed: revision(old), available: revision(target), check: { ...idleCheck(), state: "checking" } }, update: null }));
  h.deps.describe = async (_repo, sha) => revision(git(["rev-parse", sha], checkout));
  h.deps.hostHealth = async () => ({ pid: 102, startIdentity: "host", hostEpoch: 1 });
  let runner!: UpdateRunner;
  const holds: string[] = [];
  h.deps.createRunner = (config, publish, changed) => runner = new UpdateRunner(config, {
    now: h.deps.now, memAvailableMb: () => 8192, exists: existsSync,
    buildIdReadable: (dir) => existsSync(join(dir, ".next", "BUILD_ID")), publish,
    revParse: async (ref, cwd) => git(["rev-parse", ref], cwd),
    run: async (args, { cwd, onLine }) => {
      holds.push(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())?.id ?? "released");
      if (args[0] === "git") {
        const argv = [...args.slice(1)];
        if (argv[0] === "fetch") argv[2] = remote;
        const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
        onLine(result.stderr);
        return result.status ?? 1;
      }
      if (args.includes("build")) {
        mkdirSync(join(cwd, ".next"));
        writeFileSync(join(cwd, ".next", "BUILD_ID"), "fixture");
      }
      return 0;
    },
  }, changed);
  h.setTurn(true);
  let ticks = 0;
  h.deps.requestPipelineTick = () => { ticks++; };
  let finishCheck!: () => void;
  let newer = target;
  h.deps.check = async () => {
    // Hold the initial check only; the post-build refresh must also settle
    // before main's final activity fence can admit the restart.
    if (!finishCheck) await new Promise<void>((resolve) => { finishCheck = resolve; });
    return { ok: true, installed: revision(old), available: revision(newer), relation: "behind", ahead: 0, behind: 2, delta: null };
  };
  const service = new SelfUpdateService(h.deps);
  const held = () => activeDrain(join(h.dir, "auto-drain.json"), h.deps.now());
  try {
    const checking = service.check();
    for (let i = 0; i < 100 && !finishCheck; i++) await Bun.sleep(1);
    await service.autoTick();
    const drain = held()!;
    expect(drain.target).toBe(target);
    expect(runner.state.state).toBe("idle");
    newer = commit("newer-main");
    finishCheck();
    await checking;
    for (let i = 0; i < 100 && runner.state.state !== "done" && runner.state.state !== "failed"; i++) await Bun.sleep(1);
    expect(runner.state.state).toBe("done");
    expect(runner.state.target).toBe(target);
    expect(holds.length).toBeGreaterThan(3);
    expect(holds.every((id) => id === drain.id)).toBe(true);
    expect((await service.snapshot()).available?.sha).toBe(newer);
    expect(h.pending()).toBeNull();
    h.setTurn(false);
    await service.check();
    // A completed check schedules its own tick. Async release observations
    // must finish before this test drives the next quiet-window observation.
    const settled = async () => {
      const deadline = Date.now() + 2_000;
      while ((service as unknown as { autoRunning: boolean }).autoRunning && Date.now() < deadline) await Bun.sleep(1);
      expect((service as unknown as { autoRunning: boolean }).autoRunning).toBe(false);
    };
    await settled();
    for (const role of ["web", "runtime-host"] as const) {
      await service.autoTick();
      await settled();
      h.advance(60_000);
      await service.autoTick();
      const pending = h.pending()!;
      expect(pending.role).toBe(role);
      expect(held()?.id).toBe(drain.id);
      endRestartGate(restartGateFile(h.record.requestFile), JSON.parse(readFileSync(h.record.requestFile, "utf8")).autoGateId);
      rmSync(h.record.requestFile);
      h.record[role === "web" ? "web" : "runtimeHost"] = { ...h.record[role === "web" ? "web" : "runtimeHost"], revision: target.slice(0, 7), requestId: pending.requestId };
      await service.autoTick();
      expect(held()?.id).toBe(drain.id);
    }
    // Matching cached revisions alone cannot prove the succession completed.
    h.deps.hostHealth = async () => { throw new Error("candidate host health unavailable"); };
    await service.autoTick();
    expect(held()?.id).toBe(drain.id);
    expect(ticks).toBe(0);
    h.deps.hostHealth = async () => ({ pid: 102, startIdentity: "host", hostEpoch: 1 });
    await service.autoTick();
    expect(held()).toBeNull();
    expect(ticks).toBe(1);
  } finally { service.stop(); }
});

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
    update: idleUpdate(), processes: { web: { ...stoppedProcess(), state: record.web.state, lastHealthOk: record.web.state === "healthy", tail: [] }, runtimeHost: { ...stoppedProcess(), state: record.runtimeHost.state, lastHealthOk: record.runtimeHost.state === "healthy", tail: [] } }, busy: null,
    meta: { branch: "main", remote: "https://github.com/example/project", checkout: record.checkout, pollMinutes: 15, serverTime: new Date(now).toISOString() },
  });
  const deps = {
    now: () => now, env: {}, dir, remote: "https://github.com/example/project", branch: "main", pollMinutes: 15, bun: "bun",
    mode: async () => ({ mode: "checkout", reason: null, record }),
    quiet: { runtimeSnapshot: async () => ({ sessions: turnRunning ? [{ turn: "running", host: "hosted" }] : [] }),
      pipelines: () => stageRunning ? [{ state: "running", cursor: { state: "spawning" } }] : [], presence: () => [], memoryAvailableMb: () => 8_192 },
    green: { read: async () => ({ state: greenState }) },
    targetOnBranch: async () => true,
    prune: async () => { prunes += 1; },
    findDeploymentByIdempotencyKey: async () => null,
    web: { pid: 101, port: 0, startedAt: "" }, processAlive: () => true,
    hostHealth: async () => ({ pid: 102 }), describe: async (_repo: string, sha: string) => revision(sha),
    buildEnv: () => ({}),
    createRunner: () => ({ state: idleUpdate(), restore: () => {}, start: async () => {}, retry: async () => {}, logPath: () => "" }),
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

test.each(["disable", "work-starts", "manual-build", "snapshot-build", "quiet-build"] as const)("final launcher admission preserves pending custody or rechecks %s after its Git observation", async (change) => {
  const h = scenario();
  const checkout = join(h.dir, "admission-checkout"); mkdirSync(checkout);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: checkout, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const sha = run("rev-parse", "HEAD");
  h.record.checkout = checkout;
  writeFileSync(h.record.releasePointer, JSON.stringify({ checkoutHead: sha, sha, dir: checkout }));
  const requestId = "final-admission-request";
  const pending = { role: "web", requestId, target: sha, launcherPid: h.record.launcher.pid, at: new Date().toISOString(), from: sha };
  const available = { sha: "c".repeat(40), short: "c".repeat(7), version: "2", date: "" };
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ slice: change.endsWith("-build")
    ? { ...initialCheck(), check: { ...idleCheck(), state: "update-available" }, available } : initialCheck(), update: null, autoPending: pending }));
  let finishBuild!: () => void;
  const buildWait = new Promise<void>((resolve) => { finishBuild = resolve; });
  const runner = { state: idleUpdate(), start: async () => {
    runner.state = { ...idleUpdate(), state: "running", trigger: "operator" };
    await buildWait; runner.state = idleUpdate();
  }, retry: async () => {}, restore: () => {}, logPath: () => "" };
  h.deps.buildEnv = () => ({});
  h.deps.createRunner = () => runner;
  const service = h.service();
  const originalSnapshot = service.snapshot;
  let snapshots = 0;
  service.snapshot = async () => {
    const view: Snapshot = { ...await originalSnapshot(), installed: { sha, short: sha.slice(0, 7), version: "1", date: "" },
      update: structuredClone(runner.state), busy: runner.state.state === "running" ? "update" : null };
    // A real snapshot computes busy before awaiting autoView's Git probe.
    if (change === "snapshot-build" && ++snapshots === 1) await headOf(checkout);
    return view;
  };
  // The switch's view is independent of the held final admission probe.
  (service as unknown as { buildSnapshot: () => Promise<Snapshot> }).buildSnapshot = service.snapshot;
  const gateFile = restartGateFile(h.record.requestFile), gateId = beginRestartGate(gateFile)!;
  const bin = join(h.dir, "admission-bin"); mkdirSync(bin);
  const entered = join(bin, "entered"), released = join(bin, "released");
  const count = join(bin, "count");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nn=0\n[ ! -f "$ADMISSION_COUNT" ] || n=$(cat "$ADMISSION_COUNT")\nn=$((n+1))\nprintf "%s" "$n" > "$ADMISSION_COUNT"\nif [ "$n" = "$ADMISSION_HOLD" ]; then touch "$ADMISSION_ENTERED"; while [ ! -f "$ADMISSION_RELEASED" ]; do sleep 0.01; done; fi\nexec "$ADMISSION_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, ADMISSION_ENTERED: process.env.ADMISSION_ENTERED, ADMISSION_RELEASED: process.env.ADMISSION_RELEASED,
    ADMISSION_GIT: process.env.ADMISSION_GIT, ADMISSION_COUNT: process.env.ADMISSION_COUNT, ADMISSION_HOLD: process.env.ADMISSION_HOLD };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, ADMISSION_ENTERED: entered, ADMISSION_RELEASED: released, ADMISSION_GIT: git,
    ADMISSION_COUNT: count, ADMISSION_HOLD: change === "snapshot-build" ? "2" : change === "quiet-build" ? "0" : "1" });
  if (change === "quiet-build") h.deps.quiet!.runtimeSnapshot = async () => {
    writeFileSync(entered, "");
    while (!existsSync(released)) await Bun.sleep(5);
    return { sessions: [] };
  };
  let admission: ReturnType<SelfUpdateService["admitAutoRestart"]> | undefined;
  try {
    admission = service.admitAutoRestart(requestId, gateId);
    const deadline = Date.now() + 2_000;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    if (change === "disable") {
      expect(await service.setAuto(false)).toMatchObject({ ok: true });
      expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
    } else if (change.endsWith("-build")) {
      expect(await service.startUpdate("manual-build-during-admission")).toMatchObject({ ok: false, status: 409, code: "busy-restart-web" });
      expect(existsSync(join(h.dir, "apply.json"))).toBe(false);
    } else h.setStage(true);
    writeFileSync(released, "");
    expect(await admission).toBe(change.endsWith("-build"));
    if (change.endsWith("-build")) expect(h.pending()).toMatchObject({ requestId, role: "web", target: sha });
    else expect(h.pending()).toBeNull();
  } finally {
    writeFileSync(released, ""); await admission;
    await service.setAuto(false);
    finishBuild(); await buildWait; await Bun.sleep(0);
    endRestartGate(gateFile, gateId); service.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("automatic build admission rechecks a manual restart during snapshot Git", async () => {
  const h = scenario();
  const checkout = join(h.dir, "build-admission-checkout"); mkdirSync(checkout);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: checkout, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const sha = run("rev-parse", "HEAD");
  h.record.checkout = checkout;
  writeFileSync(h.record.releasePointer, JSON.stringify({ checkoutHead: sha, sha, dir: checkout }));
  const available = { sha: TARGET, short: TARGET.slice(0, 7), version: "2", date: "" };
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), available }, update: null, autoPending: null }));
  let starts = 0, finishBuild!: () => void;
  const buildWait = new Promise<void>((resolve) => { finishBuild = resolve; });
  const runner = { state: idleUpdate(), start: async () => {
    starts++; runner.state = { ...idleUpdate(), state: "running", trigger: "auto" }; await buildWait;
  }, retry: async () => {}, restore: () => {}, logPath: () => "" };
  h.deps.buildEnv = () => ({}); h.deps.createRunner = () => runner;
  h.deps.requestRestart = () => { writeFileSync(h.record.requestFile, "manual request"); return "manual-restart"; };
  const service = h.service(), originalSnapshot = service.snapshot;
  let snapshots = 0;
  service.snapshot = async () => {
    const view = { ...await originalSnapshot(), installed: { sha, short: sha.slice(0, 7), version: "1", date: "" } };
    if (++snapshots === 2) await headOf(checkout);
    return view;
  };
  (service as unknown as { buildSnapshot: () => Promise<Snapshot> }).buildSnapshot = service.snapshot;
  const bin = join(h.dir, "build-admission-bin"); mkdirSync(bin);
  const entered = join(bin, "entered"), released = join(bin, "released"), count = join(bin, "count");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nn=0\n[ ! -f "$BUILD_ADMISSION_COUNT" ] || n=$(cat "$BUILD_ADMISSION_COUNT")\nn=$((n+1))\nprintf "%s" "$n" > "$BUILD_ADMISSION_COUNT"\nif [ "$n" = 2 ]; then touch "$BUILD_ADMISSION_ENTERED"; while [ ! -f "$BUILD_ADMISSION_RELEASED" ]; do sleep 0.01; done; fi\nexec "$BUILD_ADMISSION_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, BUILD_ADMISSION_COUNT: process.env.BUILD_ADMISSION_COUNT,
    BUILD_ADMISSION_ENTERED: process.env.BUILD_ADMISSION_ENTERED, BUILD_ADMISSION_RELEASED: process.env.BUILD_ADMISSION_RELEASED,
    BUILD_ADMISSION_GIT: process.env.BUILD_ADMISSION_GIT };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, BUILD_ADMISSION_COUNT: count, BUILD_ADMISSION_ENTERED: entered,
    BUILD_ADMISSION_RELEASED: released, BUILD_ADMISSION_GIT: git });
  let tick: ReturnType<SelfUpdateService["autoTick"]> | undefined;
  try {
    tick = service.autoTick();
    const deadline = Date.now() + 2_000;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    expect(await service.restart("web")).toMatchObject({ ok: true });
    expect(service.active()).toBe(true);
    writeFileSync(released, ""); await tick;
    expect(starts).toBe(0);
    expect(readFileSync(h.record.requestFile, "utf8")).toBe("manual request");
  } finally {
    writeFileSync(released, ""); await tick; await service.setAuto(false);
    finishBuild(); await buildWait; await Bun.sleep(0); service.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test.each(["build", "restart"] as const)("disabling auto during Git prevents a new automatic %s", async (action) => {
  const h = scenario();
  const checkout = join(h.dir, "tick-checkout"); mkdirSync(checkout);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: checkout, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const sha = run("rev-parse", "HEAD");
  h.record.checkout = checkout;
  writeFileSync(h.record.releasePointer, JSON.stringify({ checkoutHead: sha, sha: OLD, dir: checkout }));
  writeAuto(join(h.dir, "auto.json"), { ...initialAuto(), enabled: true, green: { [TARGET]: { state: "green" } }, rollbackCaptured: false });
  const revision = { sha: TARGET, short: TARGET.slice(0, 7), version: "1", date: "" };
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ slice: { ...initialCheck(), available: revision }, update: null, autoPending: null }));
  let starts = 0;
  h.deps.buildEnv = () => ({});
  h.deps.createRunner = () => ({ state: idleUpdate(), start: async () => { starts++; }, retry: async () => {}, restore: () => {}, logPath: () => "" }) as ReturnType<ServiceDeps["createRunner"]>;
  const service = h.service();
  const snapshot = service.snapshot;
  if (action === "build") service.snapshot = async () => ({ ...await snapshot(), installed: { ...revision, sha, short: sha.slice(0, 7) } });
  (service as unknown as { buildSnapshot: () => Promise<Snapshot> }).buildSnapshot = service.snapshot;
  if (action === "restart") { await service.autoTick(); h.advance(60_000); }
  const bin = join(h.dir, "tick-bin"); mkdirSync(bin);
  const entered = join(bin, "entered"), released = join(bin, "released"), count = join(bin, "count");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nn=0\n[ ! -f "$TICK_COUNT" ] || n=$(cat "$TICK_COUNT")\nn=$((n+1))\nprintf "%s" "$n" > "$TICK_COUNT"\nif [ "$n" = "$TICK_HOLD" ]; then touch "$TICK_ENTERED"; while [ ! -f "$TICK_RELEASED" ]; do sleep 0.01; done; fi\nexec "$TICK_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, TICK_ENTERED: process.env.TICK_ENTERED, TICK_RELEASED: process.env.TICK_RELEASED, TICK_COUNT: process.env.TICK_COUNT, TICK_HOLD: process.env.TICK_HOLD, TICK_GIT: process.env.TICK_GIT };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, TICK_ENTERED: entered, TICK_RELEASED: released, TICK_COUNT: count, TICK_HOLD: action === "build" ? "1" : "2", TICK_GIT: git });
  let tick: ReturnType<SelfUpdateService["autoTick"]> | undefined;
  try {
    tick = service.autoTick();
    const deadline = Date.now() + 2_000;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    expect(await service.setAuto(false)).toMatchObject({ ok: true });
    expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
    writeFileSync(released, ""); await tick;
    expect(starts).toBe(0);
    expect(existsSync(h.record.requestFile)).toBe(false);
    expect(h.pending()).toBeNull();
  } finally {
    writeFileSync(released, ""); await tick; service.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a delayed final Git observation cannot let an older switch overwrite a newer disable", async () => {
  const h = scenario();
  const checkout = join(h.dir, "checkout");
  mkdirSync(checkout);
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: checkout, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "--allow-empty", "-m", "base");
  const sha = run("rev-parse", "HEAD");
  h.record.checkout = checkout;
  writeFileSync(h.record.releasePointer, JSON.stringify({ checkoutHead: sha, sha, dir: checkout }));
  const revision = { sha, short: sha.slice(0, 7), version: "1", date: "" };
  h.deps.describe = async () => revision;
  h.deps.check = async () => ({ ok: true, installed: revision, available: revision, relation: "equal", ahead: 0, behind: 0, delta: null });
  h.deps.buildEnv = () => ({});
  h.deps.createRunner = () => ({ state: idleUpdate(), start: async () => {}, retry: async () => {}, restore: () => {}, logPath: () => "" }) as ReturnType<ServiceDeps["createRunner"]>;
  h.deps.processAlive = () => true;
  h.deps.hostHealth = async () => null;
  h.deps.web = { pid: 101, port: 0, startedAt: "" };
  h.setStage(true);
  const service = new SelfUpdateService(h.deps);
  const bin = join(h.dir, "bin");
  mkdirSync(bin);
  const count = join(h.dir, "git-count");
  const entered = join(h.dir, "git-entered");
  const released = join(h.dir, "git-released");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nn=0\n[ ! -f "$FIXTURE_COUNT" ] || n=$(cat "$FIXTURE_COUNT")\nn=$((n+1))\nprintf "%s" "$n" > "$FIXTURE_COUNT"\nif [ "$n" = 4 ]; then touch "$FIXTURE_ENTERED"; while [ ! -f "$FIXTURE_RELEASED" ]; do sleep 0.01; done; fi\nexec "$FIXTURE_GIT" "$@"\n', { mode: 0o700 });
  const previous = { PATH: process.env.PATH, FIXTURE_COUNT: process.env.FIXTURE_COUNT, FIXTURE_ENTERED: process.env.FIXTURE_ENTERED, FIXTURE_RELEASED: process.env.FIXTURE_RELEASED, FIXTURE_GIT: process.env.FIXTURE_GIT };
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, FIXTURE_COUNT: count, FIXTURE_ENTERED: entered, FIXTURE_RELEASED: released, FIXTURE_GIT: git });
  let older: ReturnType<SelfUpdateService["setAuto"]> | undefined;
  try {
    older = service.setAuto(true);
    const deadline = Date.now() + 2_000;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    expect(await service.setAuto(false)).toMatchObject({ ok: true });
    expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
    writeFileSync(released, "");
    expect(await older).toMatchObject({ ok: false, code: "auto-switch-superseded" });
    expect(readAuto(join(h.dir, "auto.json")).enabled).toBe(false);
  } finally {
    writeFileSync(released, "");
    await older;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    service.stop();
  }
});

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
  writeFileSync(h.record.releasePointer, JSON.stringify({ sha: TARGET, dir: h.record.releasesDir, checkoutHead: await headOf(process.cwd()) }));
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

test("a long wait starts one drain while still allowing future quiet probes", async () => {
  const h = scenario();
  const file = join(h.dir, "auto.json");
  writeAuto(file, { ...readAuto(file), waitingSince: new Date(Date.parse("2025-12-30T23:00:00Z")).toISOString() });
  const service = h.service();
  await service.autoTick();
  const drain = readAuto(file).drain;
  expect(drain).not.toBeNull();
  await service.autoTick();
  expect(readAuto(file).drain?.id).toBe(drain?.id);
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

test("a disabled drain releases after a crash between switch persistence and lease cleanup", async () => {
  const h = scenario();
  h.setTurn(true);
  let service = h.service();
  await service.autoTick();
  await service.autoTick();
  const file = join(h.dir, "auto.json");
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  service.stop();
  writeAuto(file, { ...readAuto(file), enabled: false });
  let wakes = 0;
  h.deps.requestPipelineTick = () => { wakes++; };
  service = h.service();
  await service.autoTick();
  expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
  expect(readAuto(file).drain).toBeNull();
  expect(wakes).toBe(1);
  service.stop();
});

test("cold recovery renews an expired drain before autonomous controllers start", async () => {
  const h = scenario();
  h.setTurn(true);
  const at = new Date(h.deps.now()).toISOString();
  const file = join(h.dir, "auto-drain.json");
  writeAuto(join(h.dir, "auto.json"), { ...readAuto(join(h.dir, "auto.json")), waitingSince: at,
    drain: { id: "cold-drain", target: { sha: TARGET, short: TARGET.slice(0, 7), version: "1", date: "" }, since: at, overranAt: null, blockers: null } });
  writeDrain(file, { id: "cold-drain", target: TARGET, since: at, until: h.deps.now() - 1 });
  const service = h.service();
  const heldAtAdmission: boolean[] = [];
  try {
    await startCurrentReleaseControllers({ LLV_ACCOUNT_CONTROLLER_DISABLED: "1" }, {
      loadSelfUpdateAuto: async () => ({ startSelfUpdateAuto: () => service.startAuto() }),
      loadFlowPipelineController: async () => ({ startFlowPipelineController: () => { heldAtAdmission.push(!!activeDrain(file, h.deps.now())); } }),
      loadSeatTick: async () => ({ startSeatTick: () => { heldAtAdmission.push(!!activeDrain(file, h.deps.now())); return true; } }),
      loadAccountMigrationController: async () => ({ startAccountMigrationController: async () => {} }),
    });
    expect(heldAtAdmission).toEqual([true, true]);
  } finally { service.stop(); }
});

test("timer ticks renew the drain while an earlier observation is still waiting", async () => {
  const h = scenario();
  h.setTurn(true);
  const service = h.service();
  await service.autoTick();
  await service.autoTick();
  const snapshot = service.snapshot.bind(service);
  let resume!: () => void;
  let entered!: () => void;
  const observing = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  service.snapshot = async () => { entered(); await paused; return snapshot(); };
  const firstTick = service.autoTick();
  try {
    await observing;
    h.advance(DRAIN_LEASE_MS + 1);
    await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).not.toBeNull();
  } finally { resume(); await firstTick; service.stop(); }
});

test("a capable launcher receives a single relaunch under automatic drain custody", async () => {
  const h = scenario(); h.record.launcher.relaunch = 1;
  const service = h.service();
  try {
    await service.autoTick(); h.advance(60_000); await service.autoTick();
    const request = JSON.parse(readFileSync(h.record.requestFile, "utf8"));
    expect(request).toMatchObject({ role: "relaunch", target: TARGET, rollbackPointer: null });
    expect(typeof request.autoGateId).toBe("string");
    expect(await service.admitAutoRestart(request.requestId, request.autoGateId)).toBe(true);
    await service.autoTick();
    expect(JSON.parse(readFileSync(h.record.requestFile, "utf8")).requestId).toBe(request.requestId);
  } finally { service.stop(); }
});


test.each(["token", "adopted"] as const)("unsafe legacy %s auto admission never takes custody", async shape => {
  const h = scenario();
  if (shape === "token") h.deps.env = { LLV_TOKEN: "fixture-bearer" };
  else h.deps.mode = async () => ({ mode: "checkout", reason: null, record: h.record, supervision: "adopted" });
  const service = h.service();
  try {
    await service.autoTick(); h.advance(60_000); await service.autoTick();
    expect(readAuto(join(h.dir, "auto.json")).drain?.admitted).not.toBe(true);
    expect(existsSync(h.record.requestFile)).toBe(false);
    expect(existsSync(join(h.dir, "apply.json"))).toBe(false);
    expect(await service.setAuto(false)).toMatchObject({ ok: true }); await service.autoTick();
    expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull();
    expect(await service.setAuto(true)).toMatchObject({ ok: false, status: 409 });
  } finally { service.stop(); }
});

test("cold unsafe legacy admission without an owned operation releases its orphan hold", async () => {
  const h = scenario(); h.deps.env = { LLV_TOKEN: "fixture-bearer" };
  const since = new Date(h.deps.now()).toISOString();
  writeAuto(join(h.dir, "auto.json"), { ...readAuto(join(h.dir, "auto.json")), enabled: false,
    drain: { id: "orphan-legacy", target: { sha: TARGET, short: TARGET.slice(0, 7), version: "1", date: "" }, since, overranAt: null, blockers: null, admitted: true } });
  writeDrain(join(h.dir, "auto-drain.json"), { id: "orphan-legacy", target: TARGET, since, until: 0, persistent: true });
  const service = h.service();
  try { await service.autoTick(); expect(activeDrain(join(h.dir, "auto-drain.json"), h.deps.now())).toBeNull(); }
  finally { service.stop(); }
});


test.each(["gate-removed", "gate-expired", "work-started", "launcher-changed", "issuer-changed"] as const)("relaunch dispatch refuses stale custody at the ancestry barrier: %s", async change => {
  const h = scenario(); h.record.launcher.relaunch = 1;
  const service = h.service();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  let dispatched = 0;
  const watcher = watchRestartRequests(h.record.requestFile, async () => { dispatched++; }, {
    intervalMs: 60_000, admitAuto: ({ requestId, autoGateId }) => service.admitAutoRestart(requestId, autoGateId),
  });
  try {
    await service.autoTick(); h.advance(60_000); await service.autoTick();
    const request = readFileSync(h.record.requestFile, "utf8");
    const apply = readFileSync(join(h.dir, "apply.json"), "utf8");
    const drain = readFileSync(join(h.dir, "auto-drain.json"), "utf8");
    const gateFile = restartGateFile(h.record.requestFile);
    h.deps.targetOnBranch = async () => { entered(); await barrier; return true; };
    const polling = watcher.poll(); await arrival;
    if (change === "gate-removed") rmSync(gateFile);
    if (change === "gate-expired") {
      const gate = JSON.parse(readFileSync(gateFile, "utf8"));
      writeFileSync(gateFile, JSON.stringify({ ...gate, until: 0 }));
    }
    if (change === "issuer-changed") {
      const gate = JSON.parse(readFileSync(gateFile, "utf8"));
      writeFileSync(gateFile, JSON.stringify({ ...gate, issuerPid: -1 }));
    }
    if (change === "work-started") h.setTurn(true);
    if (change === "launcher-changed") h.record.launcher.startIdentity = "successor-launcher";
    const heldGate = existsSync(gateFile) ? readFileSync(gateFile, "utf8") : null;
    release(); await polling;
    expect(dispatched).toBe(0);
    expect(readFileSync(h.record.requestFile, "utf8")).toBe(request);
    expect(readFileSync(join(h.dir, "apply.json"), "utf8")).toBe(apply);
    expect(readFileSync(join(h.dir, "auto-drain.json"), "utf8")).toBe(drain);
    expect(existsSync(gateFile) ? readFileSync(gateFile, "utf8") : null).toBe(heldGate);
    expect(JSON.parse(readFileSync(`${h.record.requestFile}.result.json`, "utf8"))).toMatchObject({ state: "rejected" });
  } finally { release(); watcher.stop(); service.stop(); }
});
