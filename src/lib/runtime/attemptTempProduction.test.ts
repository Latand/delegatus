import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { runTempSweep, sweepStaleTempDirs, type ProcessScan } from "@/lib/tempSweep";
import { statePath } from "@/lib/configDir";
import { attemptReferencesClear } from "./attemptTempFilesystem";

const roots: string[] = [];
afterEach(() => { savePipelines([]); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const modeledBytesPerHour = (removedBytes: number, elapsedMs: number) => removedBytes * 3600000 / (60000 + elapsedMs);

test("hourly reclaim model includes sweep duration before the scheduler's minute wait", () => {
  const bytesPerRun = 537_133_056;
  expect(modeledBytesPerHour(bytesPerRun, 7_390) / 1e9).toBeCloseTo(28.70, 1);
  expect(modeledBytesPerHour(bytesPerRun, 5_600) / 1e9).toBeCloseTo(29.48, 1);
  expect(modeledBytesPerHour(bytesPerRun, 7_390)).toBeLessThan(bytesPerRun * 3600000 / 60000);
});

// These fixtures own no containers. Keep the real process and checkout guards,
// with a fixed container observation independent of host container churn.
const references = (original: string, current: string, scan: ProcessScan) =>
  attemptReferencesClear(original, current, scan, async () => true);

test.skipIf(process.env.LLV_ATTEMPT_TEMP_BENCHMARK !== "1")("retention benchmark: 727 roots under two CPU writers and one synced disk writer", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-retention-benchmark-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "benchmark-lane", task: "Inventory", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "benchmark-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  const checkout = pipeline.worktreeDir!;
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  for (let n = 0; n < 1024; n++) fs.symlinkSync(path.join(root, "absent", String(n)), path.join(checkout, `link-${n}`));
  savePipelines([pipeline]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const inventories = new Set<InstanceType<typeof RepositoryLinkInventory>>();
  const targets = RepositoryLinkInventory.prototype.targets;
  const observed = spyOn(RepositoryLinkInventory.prototype, "targets").mockImplementation(function (this: InstanceType<typeof RepositoryLinkInventory>, repository: string) {
    inventories.add(this); return targets.call(this, repository);
  });
  const loads: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (let n = 0; n < 727; n++) {
      const directory = path.join(root, `llv-stage-${String(n).padStart(4, "0")}`); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(n < 32 ? 16 * 1024 ** 2 : 4096));
      store.register({ directory, pipelineId: pipeline.id, launchId: "benchmark-launch", retainUntilClose: false, createdAt: 1 });
      store.measure(directory, n < 32 ? 16 * 1024 ** 2 : 4096); store.release(directory);
    }
    for (const kind of ["cpu", "cpu", "io"]) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--load", kind, path.join(root, "load-file")],
        { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      loads.push(child);
      const ready = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    }
    const load = () => process.platform === "linux" ? fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number) : os.loadavg();
    const before = load(), start = performance.now();
    const report = await sweepAttemptTemps(store, { now: () => 1000 + performance.now() - start, maxRoots: 32, capBytes: 0,
      state: attemptTempState, references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) });
    const elapsedMs = performance.now() - start;
    console.log("[attempt-temp benchmark] " + JSON.stringify({ registryRoots: 727, checkoutLinks: 1024,
      ownedLoad: { cpuWorkers: 2, syncedDiskWriters: 1, writeBytes: 1024 ** 2 }, hostCpus: os.cpus().length,
      loadBefore: before, loadAfter: load(), elapsedMs, checked: report.checked, removed: report.removed,
      removedBytes: report.removedBytes, errors: report.errors,
      checkoutWalks: [...inventories].reduce((sum, inventory) => sum + inventory.walks.length, 0),
      modeledBytesPerHour: modeledBytesPerHour(report.removedBytes, elapsedMs) }));
    expect(report).toMatchObject({ checked: 32, removed: 32, errors: 0 });
  } finally {
    for (const child of loads) child.kill();
    await Promise.all(loads.map(child => child.exited));
    observed.mockRestore(); store.close();
  }
}, 180_000);

test("the real sweep shares checkout inventory with production lane authority across roots and rechecks", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-production-inventory-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "inventory-lane", task: "Inventory", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "inventory-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  fs.mkdirSync(path.join(pipeline.worktreeDir!, ".git"), { recursive: true });
  savePipelines([pipeline]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const inventories = new Set<InstanceType<typeof RepositoryLinkInventory>>();
  const targets = RepositoryLinkInventory.prototype.targets;
  const observed = spyOn(RepositoryLinkInventory.prototype, "targets").mockImplementation(function (this: InstanceType<typeof RepositoryLinkInventory>, repository: string) {
    inventories.add(this); return targets.call(this, repository);
  });
  try {
    for (let n = 0; n < 8; n++) {
      const directory = path.join(root, `llv-stage-${n}`); fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: pipeline.id, launchId: "inventory-launch", retainUntilClose: false, createdAt: 1 });
    }
    const report = await sweepAttemptTemps(store, { now: () => 2, maxRoots: 8, capBytes: 0,
      state: attemptTempState, references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report).toMatchObject({ checked: 8, removed: 8, errors: 0 });
    expect([...inventories].reduce((sum, inventory) => sum + inventory.walks.length, 0)).toBe(1);
  } finally { observed.mockRestore(); store.close(); }
});

test("a checkout link created after the first authority inventory keeps its attempt root", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { attemptReferencesClear, RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-late-checkout-link-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "late-link-lane", task: "Late checkout link", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "late-link-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  fs.mkdirSync(path.join(pipeline.worktreeDir!, ".git"), { recursive: true });
  savePipelines([pipeline]);
  const directory = path.join(root, "llv-stage-late-link"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
  const checkoutLink = path.join(pipeline.worktreeDir!, "nested", "node_modules");
  fs.mkdirSync(path.dirname(checkoutLink), { recursive: true });
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  store.register({ directory, pipelineId: pipeline.id, launchId: "late-link-launch", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  let inventory: InstanceType<typeof RepositoryLinkInventory> | undefined;
  let injected = false;
  const targets = RepositoryLinkInventory.prototype.targets;
  const observed = spyOn(RepositoryLinkInventory.prototype, "targets").mockImplementation(function (this: InstanceType<typeof RepositoryLinkInventory>, repository: string) {
    const read = targets.call(this, repository);
    return read.then(found => {
      if (!injected && repository === pipeline.worktreeDir) {
        injected = true;
        fs.symlinkSync(directory, checkoutLink, "dir");
      }
      return found;
    });
  });
  try {
    const report = await sweepAttemptTemps(store, { now: () => 2, maxRoots: 1, capBytes: 0,
      state: (owner, current) => { inventory = current; return attemptTempState(owner, current); },
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, inventory!),
      scan: () => ({ ownNamespace: null, processes: [{ pid: 123, namespace: null, stamped: false, paths: [pipeline.worktreeDir!] }] }) });
    expect(injected).toBeTrue();
    expect(report).toMatchObject({ removed: 0, errors: 0, held: 1, liveHeld: 1 });
    expect(fs.existsSync(directory)).toBeTrue();
    expect(fs.lstatSync(checkoutLink).isSymbolicLink()).toBeTrue();
  } finally { observed.mockRestore(); store.close(); }
});

test.each([0, 1, 2, 3, 4, 5, 6])("a restored checkout holds scratch across authority boundary %i (zero is the removal control)", async boundary => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-restored-checkout-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "restored-lane", task: "Checkout restoration", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "restored-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  const repository = pipeline.worktreeDir!;
  roots.push(repository, repository + "-previous");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  savePipelines([pipeline]);
  const directory = path.join(root, "llv-stage-restored"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "data"), "retained payload");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  store.register({ directory, pipelineId: pipeline.id, launchId: "restored-launch", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  const exists = fs.existsSync;
  let observations = 0, disappeared = false, restored = false;
  const existence = spyOn(fs, "existsSync").mockImplementation(file => {
    const present = exists(file);
    if (file === repository && ++observations === boundary && present) {
      disappeared = true; fs.renameSync(repository, repository + "-previous");
    }
    return present;
  });
  const targets = RepositoryLinkInventory.prototype.targets;
  const reads = spyOn(RepositoryLinkInventory.prototype, "targets").mockImplementation(async function (this: InstanceType<typeof RepositoryLinkInventory>, repo: string) {
    try { return await targets.call(this, repo); }
    finally {
      if (disappeared && !restored && repo === repository) {
        restored = true; fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
        fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
      }
    }
  });
  let inventory: InstanceType<typeof RepositoryLinkInventory>;
  try {
    const report = await sweepAttemptTemps(store, { now: () => 2, maxRoots: 1, capBytes: 0,
      state: (owner, current) => { inventory = current; return attemptTempState(owner, current); },
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, inventory!),
      scan: () => ({ ownNamespace: null, processes: [] }) });
    if (boundary === 0) {
      expect(report).toMatchObject({ removed: 1, errors: 0 });
      expect(observations).toBeGreaterThanOrEqual(6);
      expect(exists(directory)).toBeFalse();
    } else {
      expect(disappeared).toBeTrue(); expect(restored).toBeTrue();
      expect(report).toMatchObject({ removed: 0, held: 1, liveHeld: 1, errors: 0 });
      expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("retained payload");
      expect(fs.readlinkSync(path.join(repository, "dependency"))).toBe(directory);
    }
  } finally { reads.mockRestore(); existence.mockRestore(); store.close(); }
});

test("production settlement retires the attempt scratch and config sandbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-production-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "temp-lane", task: "Temp lifetime", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  const attempt: PipelineStageAttempt = { n: 1, state: "passed", launchId: "temp-launch", effectiveRole: role,
    conversationId: "fixture-conversation", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: "2026-10-22T12:01:00Z", input: null, activatedBy: null,
    output: "done", verdict: { status: "pass" }, error: null };
  pipeline.runs = [{ stageId: "build", attempts: [attempt] }];
  savePipelines([pipeline]);
  const access = materializeStructuredHostAccess({ readOnly: false, sandbox: "full" }, { ...process.env }, null, root,
    { pipelineId: pipeline.id, launchId: "temp-launch", retainUntilClose: false });
  const sandbox = access.env.LLV_AGENT_SANDBOX_ROOT;
  if (sandbox) roots.push(sandbox);
  const child = withAgentConfigSandbox({ NODE_ENV: "test" }, access.env);
  fs.writeFileSync(path.join(access.env.TMPDIR!, "review-export"), "settled scratch");
  // Main has no attempt retirement tick: its existing stale sweep leaves the
  // fresh settled root behind. This fallback makes that regression observable.
  const modulePath = "./attemptTempProduction";
  const production = await import(modulePath).catch(() => null);
  if (production) {
    const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
    const store = new AttemptTempStore();
    try { await sweepAttemptTemps(store, { state: production.attemptTempState, references, scan: () => ({ ownNamespace: null, processes: [] }) }); }
    finally { store.close(); }
  } else {
    await sweepStaleTempDirs({ roots: [{ path: root, via: "" }], maxAgeMs: 86400000, scan: { ownNamespace: null, processes: [] } });
  }
  expect(fs.existsSync(access.scratchDirectory!)).toBeFalse();
  if (sandbox) {
    expect(child.XDG_CONFIG_HOME).toBe(path.join(sandbox, "config"));
    expect(fs.existsSync(sandbox)).toBeFalse();
  }
});


test("foreign and gate-named directories with no creation record survive registration, the capped tick and the legacy sweep", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-foreign-survival-")); roots.push(root);
  const foreign = ["merge-gate-state-fixture", "merge-privacy-state-fixture", "delegatus-local-gate-fixture", "delegatus-cpu-wait.fixture", "unrelated-project-cache"]
    .map(name => { const directory = path.join(root, name); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "foreign"); return directory; });
  const orphan = path.join(root, "llv-stage-orphan"); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, "data"), "owned");
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const production = await import("./attemptTempProduction");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const now = Date.now() + 30 * 86400000;
  try {
    for (const directory of foreign) {
      expect(() => store.register({ directory, pipelineId: null, launchId: "foreign", retainUntilClose: false, createdAt: 0 })).toThrow("not an owned directory");
      expect(fs.existsSync(path.join(directory, ".delegatus-attempt-owner"))).toBeFalse();
    }
    store.register({ directory: orphan, pipelineId: "missing-lane", launchId: "orphan", retainUntilClose: false, createdAt: now - 2 * 86400000 });
    const report = await sweepAttemptTemps(store, { now: () => now, state: production.attemptTempState, references,
      capBytes: 0, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(report.removed).toBe(1); expect(fs.existsSync(orphan)).toBeFalse();
    const legacy = await runTempSweep({ NODE_ENV: "test", LLV_TEMP_SWEEP: "on", LLV_TEMP_SWEEP_MAX_AGE_HOURS: "24" },
      { roots: [{ path: root, via: "" }], now: () => now, scan: { ownNamespace: null, processes: [] } });
    expect(legacy?.removed).toEqual([]);
    for (const directory of foreign) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("foreign");
  } finally { store.close(); }
});

test("an idle minute tick writes no journal line or report, and a changed condition is reported once across restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-idle-tick-")); roots.push(root);
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const report = statePath("attempt-temp-report.json");
  fs.rmSync(report, { force: true });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const scan = () => ({ ownNamespace: null, processes: [] });
  // Each call opens its own ledger and keeps nothing in memory, as a restarted helper does.
  const tick = async (env: Record<string, string> = {}) => { lines.length = 0; await runAttemptTempSweep({ scan }, { NODE_ENV: "test", LLV_TEMP_SWEEP: "on", ...env }); return [...lines]; };
  try {
    expect(await tick()).toEqual([]);
    expect(fs.existsSync(report)).toBeFalse();
    const held = path.join(root, "llv-stage-held"); fs.mkdirSync(held); fs.writeFileSync(path.join(held, "data"), Buffer.alloc(8192));
    const store = new AttemptTempStore();
    try { store.register({ directory: held, pipelineId: "missing-lane", launchId: "held", retainUntilClose: false, createdAt: Date.now() }); }
    finally { store.close(); }
    const over = await tick({ LLV_ATTEMPT_TEMP_CAP_BYTES: "0" });
    expect(over).toHaveLength(1); expect(over[0]).toContain("measured bytes over cap");
    expect(JSON.parse(fs.readFileSync(report, "utf8")).condition).toEqual({ mode: "on", overCap: true, failing: false });
    expect(JSON.parse(fs.readFileSync(report, "utf8")).summary).toContain("budget deferred");
    expect(JSON.parse(fs.readFileSync(report, "utf8")).summary).toContain("held by evidence");
    const recovered = await tick();
    expect(recovered).toHaveLength(1); expect(recovered[0]).toContain("0 measured bytes over cap");
    const written = fs.readFileSync(report, "utf8");
    expect(await tick()).toEqual([]);
    expect(await tick()).toEqual([]);
    expect(fs.readFileSync(report, "utf8")).toBe(written);
  } finally { log.mockRestore(); }
});


test.each(["passed", "failed", "needs_decision", "skipped", "committing"] as const)("production authority handles %s and holds declared evidence until close", async state => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-production-state-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "state-lane", task: "Temp authority", project: "fixture", repoDir: path.join(root, "repo"),
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state, launchId: "state-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  savePipelines([pipeline]);
  const { attemptTempState } = await import("./attemptTempProduction");
  const owner = { directory: path.join(root, "llv-stage-fixture"), pipelineId: pipeline.id, launchId: "state-launch", retainUntilClose: false, createdAt: 1 };
  expect(await attemptTempState(owner)).toBe(state === "committing" ? "live" : "settled");
  pipeline.runs[0]!.attempts[0]!.retiredLaunches = [{ launchId: "prior-launch", conversationId: null,
    error: "startup retired", retiredAt: "2026-10-22T12:01:00Z" }]; savePipelines([pipeline]);
  expect(await attemptTempState({ ...owner, launchId: "prior-launch" })).toBe("settled");
  expect(await attemptTempState({ ...owner, launchId: "unrecorded-launch" })).toBe("unknown");
  fs.mkdirSync(path.join(pipeline.worktreeDir!, "nested"), { recursive: true });
  if (state !== "committing") {
    const filesystem = await import("./attemptTempFilesystem");
    const changed = spyOn(filesystem, "repositoryReferencesAttemptTemp").mockImplementation(async () => {
      await Promise.resolve(); pipeline.runs[0]!.attempts[0]!.state = "running"; savePipelines([pipeline]); return false;
    });
    try { expect(await attemptTempState(owner)).toBe("unknown"); }
    finally { changed.mockRestore(); }
    pipeline.runs[0]!.attempts[0]!.state = state; savePipelines([pipeline]);
  }
  fs.symlinkSync(path.join(owner.directory, "packages"), path.join(pipeline.worktreeDir!, "nested/node_modules"), "dir");
  expect(await attemptTempState(owner)).toBe("live");
  pipeline.stages[0]!.effectiveRole = { ...role, access: "read-only" };
  pipeline.stages[0]!.outputs = ["evidence"]; savePipelines([pipeline]);
  expect(await attemptTempState(owner)).toBe("live");
  expect(await attemptTempState({ ...owner, directory: path.join(root, "llv-stage-config-fixture") })).toBe(state === "committing" ? "live" : "settled");
  for (const terminal of ["completed", "closed"] as const) {
    pipeline.state = terminal; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z"; savePipelines([pipeline]);
    expect(await attemptTempState(owner)).toBe("closed");
  }
});


test.each([false, true])("production access gives managed scratch and durable evidence (restricted=%s)", async restricted => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { structuredHostAccessPolicy } = await import("./structuredSpawn");
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { admittedAs, lexicalAllowedRoots } = await import("@/lib/artifact/localFile");
  const profile = emptyLaunchProfile(restricted ? { readOnly: true, sandbox: "restricted" } : {});
  const access = materializeStructuredHostAccess(structuredHostAccessPolicy(profile), { ...process.env }, null,
    undefined, { pipelineId: "evidence-lane", launchId: "evidence-launch", retainUntilClose: false });
  const store = new AttemptTempStore();
  try {
    expect(access.env.TMPDIR?.startsWith(statePath("scratch") + path.sep)).toBeTrue();
    expect(store.has(access.scratchDirectory!)).toBeTrue();
    const evidence = statePath("evidence/evidence-lane/frame.png");
    expect(access.env.LLV_EVIDENCE_DIR).toBe(path.dirname(evidence));
    fs.writeFileSync(evidence, "frame");
    const allowed = lexicalAllowedRoots();
    expect(admittedAs(evidence, allowed)).toBe("evidence");
    expect(admittedAs(evidence.replace(".png", ".svg"), allowed)).toBeNull();
    expect(admittedAs(evidence.replace(".png", ".json"), allowed)).toBeNull();
    access.cleanup();
    await sweepAttemptTemps(store, { state: async () => "closed", references, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(fs.existsSync(access.scratchDirectory!)).toBeFalse();
    await sweepStaleTempDirs({ roots: [{ path: statePath("scratch"), via: "" }], maxAgeMs: 0,
      scan: { ownNamespace: null, processes: [] } });
    expect(fs.readFileSync(evidence, "utf8")).toBe("frame");
  } finally { store.close(); }
});


test.each(process.platform === "win32" ? ["intact", "missing", "operator"] : ["intact", "missing", "operator", "redirected"])("a real agent child requires its managed config proof (%s)", async proof => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { structuredHostAccessPolicy } = await import("./structuredSpawn");
  const access = materializeStructuredHostAccess(structuredHostAccessPolicy(emptyLaunchProfile({ sandbox: "full" })), { ...process.env }, null, undefined,
    { pipelineId: null, launchId: "state-child", retainUntilClose: false });
  const env = withAgentConfigSandbox({ NODE_ENV: "test", TMPDIR: access.env.TMPDIR, HOME: access.env.HOME }, access.env);
  try {
    if (proof === "missing") fs.unlinkSync(path.join(access.env.LLV_AGENT_SANDBOX_ROOT!, ".delegatus-attempt-owner"));
    if (proof === "redirected") {
      const config = path.join(access.env.LLV_AGENT_SANDBOX_ROOT!, "config");
      fs.renameSync(config, config + "-saved");
      const outside = path.join(env.HOME!, ".config"); fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, config, "dir");
    }
    const child = Bun.spawn([process.execPath, "-e", `
      const ownership = await import(${JSON.stringify(path.join(import.meta.dir, "../stateOwnership.ts"))});
      ownership.setStateOwnershipPathsForTests({home: process.env.HOME, tempRoots: []});
      const { stateDir } = await import(${JSON.stringify(path.join(import.meta.dir, "../configDir.ts"))});
      const { assertStateStartupMutation } = await import(${JSON.stringify(path.join(import.meta.dir, "../stateOwnership.ts"))});
      const directory = ${proof === "operator" ? 'require("node:path").join(process.env.HOME, ".config/delegatus/state")' : 'stateDir()'};
      assertStateStartupMutation(directory, "fixture startup");
      console.log(directory);
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (proof === "intact") {
      expect({ code, error }).toEqual({ code: 0, error: "" });
      expect(out.trim()).toBe(env.LLV_STATE_DIR!);
    } else {
      expect(code).not.toBe(0); expect(error).toContain(proof === "operator" ? "StateStartupMutationRefused" : "OperatorStateUnderTestError"); expect(out).toBe("");
    }
  } finally { access.cleanup(); }
});
