import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { AttemptTempStore, sweepAttemptTemps, ATTEMPT_TEMP_LOW_SPACE_BYTES } from "./attemptTempRetention";
import { attemptTempAuthority } from "./attemptTempProduction";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { buildPipeline, savePipelines } from "../pipelines/store";
import { finishedLane, holdFinishedRoot, nameInReport } from "./attemptTempRetention.testSupport";
import { statePath } from "../configDir";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { allocatedAttemptBytes, attemptReferencesClear } from "./attemptTempFilesystem";

const NOW = Date.parse("2030-01-20T00:00:00Z");
const roots: string[] = [];
afterEach(() => { removeKeepMarkers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(statePath("report-media"), { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-retention-")); roots.push(root);
  const store = new AttemptTempStore(path.join(root, "attempt-temp.sqlite"));
  const make = (id: string, createdAt = NOW - 1000, pipelineId: string | null = null) => {
    const directory = path.join(root, `llv-stage-${id}`); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
    store.register({ directory, pipelineId, launchId: id, retainUntilClose: false, createdAt });
    store.measure(directory, 12288);
    return directory;
  };
  const options = { now: () => NOW, state: async () => "closed" as const,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true,
    availableBytes: () => ATTEMPT_TEMP_LOW_SPACE_BYTES };
  return { root, store, make, options };
}

test("pressure reclaims oldest recent ended temp to the cap without making evidence copies", async () => {
  const f = fixture(), oldest = f.make("oldest", NOW - 3), next = f.make("next", NOW - 2), last = f.make("last", NOW - 1);
  fs.writeFileSync(path.join(oldest, "frame.png"), "unlinked scratch capture");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 12288 });
    expect(report).toMatchObject({ pressure: true, checked: 2, removed: 2, bytes: 12288, overCapBytes: 0 });
    expect(report.outcomes.map(row => row.directory)).toEqual([oldest, next]);
    expect(fs.existsSync(last)).toBeTrue();
    expect(fs.existsSync(path.join(f.root, "evidence/attempt-temp"))).toBeFalse();
  } finally { f.store.close(); }
});

test("the next pressure episode restarts oldest first after a helper restart", async () => {
  const f = fixture(), old = f.make("old-live", NOW - 3), middle = f.make("middle", NOW - 2);
  f.make("newest", NOW - 1);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 24576,
      state: async owner => owner.directory === old ? "live" : "closed" });
    expect(report).toMatchObject({ removed: 1, overCapBytes: 0 });
    expect(fs.existsSync(middle)).toBeFalse(); f.store.close();
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.store.filename, String(NOW), "pressure"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0); expect(JSON.parse(output).outcomes[0].directory).toBe(old);
  } finally { f.store.close(); }
});

test.each(["running", "process", "operator", "recorded", "linked", "starts-during-pass"])("pressure preserves %s roots", async kind => {
  const f = fixture(), directory = f.make(kind, NOW - 1000, "retention-lane");
  if (kind === "operator") plantKeepMarker(path.join(directory, ".delegatus-keep"));
  if (kind === "recorded") await holdFinishedRoot(directory);
  if (kind === "linked") { fs.writeFileSync(path.join(directory, "frame.png"), "evidence"); nameInReport(path.join(directory, "frame.png")); }
  let running = kind === "running", reads = 0;
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      state: async () => running ? "live" : "closed",
      authority: async () => ({ state: running ? "live" : "closed", revision: "fixture", isCurrent: () => !running }),
      references: async () => {
        if (kind === "starts-during-pass" && ++reads === 1) running = true;
        return attemptReferencesClear(directory, directory,
          { ownNamespace: null, processes: kind === "process" ? [{ pid: process.pid, paths: [directory], namespace: null, stamped: false }] : [] }, async () => true);
      } });
    expect(report.removed).toBe(0); expect(report.errors).toBe(0);
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test.each([ATTEMPT_TEMP_LOW_SPACE_BYTES - 1, ATTEMPT_TEMP_LOW_SPACE_BYTES])("low-space boundary %i ignores cap and retention only below threshold", async free => {
  const f = fixture(), directory = f.make("recent-evidence");
  // The ordinary policy preserves a recent scratch capture; pressure can
  // discard unlinked media without moving its allocation to another store.
  fs.writeFileSync(path.join(directory, "frame.png"), "scratch");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, availableBytes: () => free,
      state: async () => "settled", capBytes: 1e9 });
    expect(report.lowSpace).toBe(free < ATTEMPT_TEMP_LOW_SPACE_BYTES);
    expect(report.removed).toBe(1);
    expect(report.lowSpaceThresholdBytes).toBe(ATTEMPT_TEMP_LOW_SPACE_BYTES);
    expect(f.store.copiesToInspect(10).length).toBe(free < ATTEMPT_TEMP_LOW_SPACE_BYTES ? 0 : 1);
  } finally { f.store.close(); }
});

test("space-observation failure is explicit and does not enable pressure", async () => {
  const f = fixture(); f.make("kept");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, state: async () => "live",
      availableBytes: () => { throw new Error("fixture statfs unavailable"); } });
    expect(report).toMatchObject({ removed: 0, pressure: false, lowSpace: false, freeBytes: null, spaceError: "fixture statfs unavailable" });
  } finally { f.store.close(); }
});

test("a deferred expensive root moves behind the inventory across a process restart", async () => {
  const f = fixture();
  const first = f.make("expensive", NOW - 2), second = f.make("removable", NOW - 1);
  const { AttemptTempBudgetDeferred } = await import("./attemptTempDiagnostics");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, maxRoots: 1,
      state: async () => { throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its tick budget"); } });
    expect(report).toMatchObject({ checked: 1, deferred: 1, removed: 0 });
    f.store.close();
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.store.filename, String(NOW), "pressure"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    expect(JSON.parse(output).outcomes[0].directory).toBe(second);
    expect(JSON.parse(output).removed).toBe(2);
    expect(fs.existsSync(first)).toBeFalse();
  } finally { f.store.close(); }
});

test("an expensive observation cannot spend the next root's five-second window", async () => {
  const f = fixture(), first = f.make("slow", NOW - 2), second = f.make("fast", NOW - 1);
  let elapsed = 0;
  const clock = spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(elapsed) * BigInt(1_000_000));
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      state: async owner => { if (owner.directory === first) elapsed += 5001; return "closed"; } });
    expect(report).toMatchObject({ checked: 2, removed: 1, deferred: 1, errors: 0 });
    expect(fs.existsSync(first)).toBeTrue(); expect(fs.existsSync(second)).toBeFalse();
  } finally { clock.mockRestore(); f.store.close(); }
});

test("a full page of cheap holds cannot hide removable roots later in the inventory", async () => {
  const f = fixture();
  for (let n = 0; n < 40; n++) f.make(`held-${String(n).padStart(2, "0")}`, NOW - 2000 + n);
  const removable = f.make("removable");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      state: async owner => owner.directory === removable ? "closed" : "live" });
    expect(report).toMatchObject({ removed: 1, liveHeld: 40, checked: 41 });
    expect(fs.existsSync(removable)).toBeFalse();
  } finally { f.store.close(); }
});

test("a thousand tied creation records are all visited within 32 process restarts", async () => {
  const f = fixture(), expected: string[] = [];
  for (let n = 0; n < 1000; n++) expected.push(path.basename(f.make(String(n).padStart(6, "0"))));
  f.store.close();
  const visited: string[] = [];
  for (let pass = 0; pass < 32; pass++) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), f.store.filename, String(NOW), "pressure-cursor"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    const page = JSON.parse(output) as string[];
    expect(page.length).toBe(32); visited.push(...page);
  }
  expect(visited.slice(0, 1000)).toEqual(expected);
});

test("a running attempt in a closed lane is live even after retention", async () => {
  const f = fixture(), directory = f.make("running", 1, "retention-lane");
  const lane = finishedLane(f.root, "2029-01-01T00:00:00Z"), role = lane.stages[0]!.effectiveRole;
  lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "running", launchId: "running", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2029-01-01T00:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  savePipelines([lane]);
  try { expect((await attemptTempAuthority(f.store.owner(directory)!, undefined, () => NOW)).state).toBe("live"); }
  finally { f.store.close(); }
});

test("a real attempt starting during the reference await revokes pressure deletion", async () => {
  const f = fixture(), directory = f.make("resumed", NOW - 1000, "retention-lane");
  const lane = finishedLane(f.root, new Date(NOW - 1000).toISOString());
  lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "resumed", effectiveRole: lane.stages[0]!.effectiveRole,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2030-01-19T00:00:00Z", completedAt: "2030-01-19T01:00:00Z", input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  savePipelines([lane]);
  let started = false;
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => NOW);
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0, authority,
      state: async (owner, inventory) => (await authority(owner, inventory)).state,
      references: async () => {
        if (!started) {
          lane.runs[0]!.attempts[0]!.state = "running"; lane.runs[0]!.attempts[0]!.completedAt = null;
          savePipelines([lane]); started = true;
        }
        return true;
      } });
    expect(started).toBeTrue(); expect(report).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
  } finally { f.store.close(); }
});

test.each([
  { phase: "allocation" as const, prefix: 8 },
  { phase: "protection" as const, prefix: 8 },
  { phase: "allocation" as const, prefix: 32 },
])("real parent retires a safe root behind $prefix slow $phase proofs within one tick", async ({ phase, prefix }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-progress-")); roots.push(root);
  const originalEnv = { ...process.env };
  const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
  const directories: string[] = [], identities: string[] = [];
  const config = path.join(root, "fixture.json");
  const preload = path.join(import.meta.dir, "attemptTempPressure.preload.ts");
  const run = async () => {
    const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload",
      args: [preload, path.join(import.meta.dir, "../worktreeSweep.worker.ts")] }, 60_000, { now: () => 0, setTimeout, clearTimeout });
    try { return await worker.attemptTemp() as { checked: number; removed: number; removedBytes: number; deferred: number; errors: number; bytes: number }; }
    finally { await worker.close(); }
  };
  try {
    savePipelines([finishedLane(root, new Date(NOW - 3600_000).toISOString())]);
    for (let n = 0; n <= prefix; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      const stat = fs.statSync(directory); identities.push(`${stat.dev}:${stat.ino}`);
    }
    const baseConfig = { now: NOW, freeBytes: 100 * ATTEMPT_TEMP_LOW_SPACE_BYTES };
    fs.writeFileSync(config, JSON.stringify({ ...baseConfig, slowProof: { phase, prefix } }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    const report = await run();
    const clock = JSON.parse(fs.readFileSync(config, "utf8")) as { elapsed: number; windows: number[] };
    console.error(JSON.stringify({ fixture: "slow-proof-progress", phase, prefix, elapsed: clock.elapsed,
      checked: report.checked, removed: report.removed, removedBytes: report.removedBytes, deferred: report.deferred, errors: report.errors }));
    expect(report).toMatchObject({ checked: prefix + 1, removed: 1, deferred: prefix, errors: 0 });
    expect(report.removedBytes).toBe(12288); expect(clock.elapsed).toBeLessThan(40_000);
    expect(clock.windows).toHaveLength(prefix); expect(Math.max(...clock.windows)).toBeLessThanOrEqual(5000);
    expect(fs.existsSync(directories[prefix]!)).toBeFalse();
    for (let n = 0; n < prefix; n++) {
      const stat = fs.statSync(directories[n]!); expect(`${stat.dev}:${stat.ino}`).toBe(identities[n]!);
      expect(fs.readFileSync(path.join(directories[n]!, "data")).length).toBe(4096);
    }
    // Restart the helper with the delayed source available again. The same
    // durable rows and cursor must recover without weakening any fence.
    fs.writeFileSync(config, JSON.stringify(baseConfig));
    const recovered = await run();
    expect(recovered).toMatchObject({ removed: prefix, errors: 0, bytes: 0 });
    for (const directory of directories) expect(fs.existsSync(directory)).toBeFalse();
  } finally {
    store.close(); for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
  }
}, 120_000);

test("real parent and restarted helper reclaim a thousand-root inventory five times over cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pressure-campaign-")); roots.push(root);
  const originalEnv = { ...process.env };
  const state = path.join(root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
  const held: string[] = [];
  try {
    const ended = finishedLane(root, new Date(NOW - 3600_000).toISOString());
    const live = buildPipeline({ id: "pressure-live", task: "Live pressure fixture", project: "fixture", repoDir: root,
      stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: ended.stages[0]!.effectiveRole }],
      srcPath: null, srcConversationId: null, now: "2030-01-19T00:00:00Z" });
    live.runs = [{ stageId: "build", attempts: [{ n: 1, state: "running", launchId: "retention-launch", effectiveRole: live.stages[0]!.effectiveRole,
      conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: "2030-01-19T00:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
    savePipelines([ended, live]);
    for (let n = 0; n < 1000; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); fs.mkdirSync(directory, { mode: 0o700 });
      const payload = n < 100 ? 1024 ** 2 : 4096;
      fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(payload));
      store.register({ directory, pipelineId: n === 1 ? live.id : "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 10_000 + n });
      store.measure(directory, payload + 8192);
      if (n === 0 || n === 500) { plantKeepMarker(path.join(directory, ".delegatus-keep")); held.push(directory); }
      if (n === 1) held.push(directory);
    }
    const cap = store.bytes() / 5, config = path.join(root, "fixture.json");
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 100 * ATTEMPT_TEMP_LOW_SPACE_BYTES }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = String(cap); process.env.LLV_PRESSURE_FIXTURE = config;
    const preload = path.join(import.meta.dir, "attemptTempPressure.preload.ts");
    let passes = 0, reclaimed = 0;
    while (store.bytes() > cap && passes < 32) {
      const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload", args: [preload, path.join(import.meta.dir, "../worktreeSweep.worker.ts")] },
        60_000, { now: () => 0, setTimeout, clearTimeout });
      try {
        const result = await worker.attemptTemp() as { checked: number; removed: number; removedBytes: number; overCapBytes: number; errors: number };
        expect(result.checked).toBeLessThanOrEqual(32); expect(result.removed).toBeGreaterThan(0); expect(result.errors).toBe(0);
        reclaimed += result.removedBytes; passes++;
      } finally { await worker.close(); }
    }
    expect(passes).toBeLessThanOrEqual(4); expect(store.bytes()).toBeLessThanOrEqual(cap); expect(reclaimed).toBeGreaterThan(0);
    const allocated = await allocatedAttemptBytes(scratch);
    expect(allocated).toBeLessThanOrEqual(cap);
    for (const directory of held) expect(fs.existsSync(directory)).toBeTrue();
    const report = JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
    expect(report.condition).toMatchObject({ overCap: false, failing: false });
    console.error(JSON.stringify({ fixture: "thousand-root-pressure", roots: 1000, cap, passes, reclaimed, remaining: store.bytes(), allocated }));
  } finally {
    store.close(); for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
  }
}, 180_000);
