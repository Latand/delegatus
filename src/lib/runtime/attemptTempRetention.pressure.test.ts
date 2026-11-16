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
import { reportMediaRoot } from "../reportMedia/lookup";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { allocatedAttemptBytes, attemptReferencesClear } from "./attemptTempFilesystem";
import { AgentRegistry, type AgentHostStatus } from "../agent/registry";
import { emptyLaunchProfile } from "../accounts/migration/contracts";
import { materializeStructuredHostAccess, tempOwnerForConversation } from "./structuredSpawn";

const NOW = Date.parse("2030-01-20T00:00:00Z");
const roots: string[] = [];
async function realParentPass() {
  const worker = new WorktreeSweepWorker({ executable: process.execPath, entry: "--preload",
    args: [path.join(import.meta.dir, "attemptTempPressure.preload.ts"), path.join(import.meta.dir, "../worktreeSweep.worker.ts")] },
  60_000, { now: () => 0, setTimeout, clearTimeout });
  try { return await worker.attemptTemp() as {
    checked: number; removed: number; removedBytes: number; deferred: number; errors: number; bytes: number; overCapBytes: number;
    outcomes: { directory: string; reason: string }[];
  }; } finally { await worker.close(); }
}
function restoreEnvironment(original: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
afterEach(() => { removeKeepMarkers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(reportMediaRoot(), { recursive: true, force: true }); });
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

function nativeFenceDeferrals(report: { outcomes: { directory: string; reason: string }[] }, store: AttemptTempStore) {
  const refused = new Set<string>();
  for (const row of report.outcomes) {
    if (!row.reason.includes("attempt mutation fence mount namespace changed")) continue;
    const owner = store.owner(row.directory), stat = fs.statSync(row.directory);
    expect(owner).not.toBeNull(); expect(`${stat.dev}:${stat.ino}`).toBe(owner!.identity);
    expect(fs.readFileSync(path.join(row.directory, "data")).length).toBe(4096);
    refused.add(row.directory);
  }
  return refused;
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
    try { return await worker.attemptTemp() as { checked: number; removed: number; removedBytes: number; deferred: number; errors: number; bytes: number;
      outcomes: { directory: string; reason: string }[] }; }
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
    let recoveredRemoved = 0;
    for (let pass = 0; pass < 3 && store.bytes() > 0; pass++) {
      const recovered = await run(), refused = nativeFenceDeferrals(recovered, store);
      expect(recovered.errors).toBe(0); recoveredRemoved += recovered.removed;
      // Ambient mounts can change while the real kernel fence validates.
      // Retry only that named refusal, after proving its zero effects above.
      const visited = new Set(recovered.outcomes.map(row => row.directory));
      for (const owner of store.pressurePage(prefix)) {
        expect(refused.has(owner.directory) || !visited.has(owner.directory)).toBeTrue();
        const stat = fs.statSync(owner.directory); expect(`${stat.dev}:${stat.ino}`).toBe(owner.identity);
        expect(fs.readFileSync(path.join(owner.directory, "data")).length).toBe(4096);
      }
    }
    expect(recoveredRemoved).toBe(prefix); expect(store.bytes()).toBe(0);
    for (const directory of directories) expect(fs.existsSync(directory)).toBeFalse();
  } finally {
    store.close(); for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv);
  }
}, 120_000);

test.each([
  { phase: "allocation" as const, holdFirst: false }, { phase: "protection" as const, holdFirst: false },
  { phase: "allocation" as const, holdFirst: true }, { phase: "protection" as const, holdFirst: true },
])("real parent makes progress across restarts with a uniform finite $phase cost (held-prefix=$holdFirst)", async ({ phase, holdFirst }) => {
  const originalEnv = { ...process.env }, f = fixture();
  const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json");
  try {
    savePipelines([finishedLane(f.root, new Date(NOW - 3600_000).toISOString())]);
    for (let n = 0; n < 33; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      if (holdFirst && n === 0) plantKeepMarker(path.join(directory, ".delegatus-keep"));
    }
    const heldBytes = holdFirst ? await allocatedAttemptBytes(path.join(scratch, "llv-stage-000000")) : 0;
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    let removed = 0;
    const nativeRefused = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, slowProof: { phase, prefix: 33, requiredCost: 1500 } }));
      const before = store.bytes(), report = await realParentPass();
      for (const directory of nativeFenceDeferrals(report, store)) nativeRefused.add(directory);
      const clock = JSON.parse(fs.readFileSync(config, "utf8"));
      if (before > heldBytes) expect(report.removed).toBeGreaterThan(0);
      expect(report.errors).toBe(0); expect(report.checked).toBeLessThanOrEqual(32);
      // The timeout seam crosses its assigned deadline by one millisecond.
      expect(clock.elapsed ?? 0).toBeLessThanOrEqual(40_001);
      expect(Math.max(...(clock.windows ?? [0]))).toBeLessThanOrEqual(5000);
      removed += report.removed;
      console.error(JSON.stringify({ fixture: "uniform-finite-proof", phase, holdFirst, pass, removed: report.removed,
        checked: report.checked, deferred: report.deferred, bytes: report.bytes, elapsed: clock.elapsed }));
    }
    for (let retry = 0; retry < 3 && store.bytes() > heldBytes; retry++) {
      for (const owner of store.pressurePage(33).filter(row => !holdFirst || !row.directory.endsWith("000000")))
        expect(nativeRefused.has(owner.directory)).toBeTrue();
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, slowProof: { phase, prefix: 33, requiredCost: 1500 } }));
      const report = await realParentPass(); expect(report.errors).toBe(0); removed += report.removed;
      for (const directory of nativeFenceDeferrals(report, store)) nativeRefused.add(directory);
    }
    expect(removed).toBe(holdFirst ? 32 : 33); expect(store.bytes()).toBe(heldBytes);
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 120_000);

for (const lowSpace of [false, true]) for (const timeoutPrefix of [1, 8, 32]) {
  test.each(["allocation", "protection"] as const)(
    `real parent progresses through mixed timeout/finite %s proofs (timeouts=${timeoutPrefix}, low-space=${lowSpace})`, async phase => {
    const originalEnv = { ...process.env }, f = fixture();
    const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
    process.env.LLV_STATE_DIR = state;
    const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json");
    const directories: { directory: string; identity: string }[] = [];
    const finiteCount = timeoutPrefix === 1 ? 32 : 8, count = timeoutPrefix + finiteCount;
    try {
      savePipelines([finishedLane(f.root, new Date(NOW - 3600_000).toISOString())]);
      for (let n = 0; n < count; n++) {
        const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
        store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 });
        store.measure(directory, 12288);
        const stat = fs.statSync(directory); directories.push({ directory, identity: `${stat.dev}:${stat.ino}` });
      }
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config;
      let removed = 0;
      let previousFirst: string | undefined;
      for (let pass = 0; pass < 4; pass++) {
        fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
          slowProof: { phase, prefix: count, timeoutPrefix, requiredCost: 1500 } }));
        const report = await realParentPass(), clock = JSON.parse(fs.readFileSync(config, "utf8"));
        if (removed < finiteCount) expect(report.removed).toBeGreaterThan(0);
        expect(report.errors).toBe(0); expect(report.checked).toBeLessThanOrEqual(count + 32);
        expect(clock.elapsed ?? 0).toBeLessThanOrEqual(40_001);
        expect(Math.max(...(clock.windows ?? [0]))).toBeLessThanOrEqual(5000);
        if (timeoutPrefix > 1 && removed < finiteCount) {
          const first = report.outcomes[0]!.directory;
          if (previousFirst) expect(first > previousFirst).toBeTrue();
          previousFirst = first;
        }
        removed += report.removed;
        expect(report.bytes).toBe((count - removed) * 12288);
        for (const { directory, identity } of directories.slice(0, timeoutPrefix)) {
          const stat = fs.statSync(directory); expect(`${stat.dev}:${stat.ino}`).toBe(identity);
          expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
        }
        console.error(JSON.stringify({ fixture: "mixed-timeout-finite", phase, timeoutPrefix, lowSpace, pass,
          checked: report.checked, removed: report.removed, removedBytes: report.removedBytes,
          deferred: report.deferred, bytes: report.bytes, elapsed: clock.elapsed }));
      }
      if (timeoutPrefix === 1) expect(removed).toBe(finiteCount);
      if (timeoutPrefix === 8) expect(fs.existsSync(directories[timeoutPrefix]!.directory)).toBeFalse();
      // A new helper with the same ledger recovers when the unavailable
      // proofs return. Timeout roots retained their bytes and inode above.
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12 }));
      for (let pass = 0; store.bytes() > 0 && pass < 3; pass++) {
        const report = await realParentPass(); expect(report.removed).toBeGreaterThan(0); expect(report.errors).toBe(0);
      }
      expect(store.bytes()).toBe(0);
      for (const { directory } of directories) expect(fs.existsSync(directory)).toBeFalse();
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.failing).toBeFalse();
    } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

test.each(["timeout", "permission-denied"] as const)("real parent retains pressure after a %s lower-bound measurement", async partialMeasurement => {
  const originalEnv = { ...process.env }, f = fixture();
  const state = path.join(f.root, "state"), scratch = path.join(state, "scratch"); fs.mkdirSync(scratch, { recursive: true });
  process.env.LLV_STATE_DIR = state;
  const store = new AttemptTempStore(), config = path.join(f.root, "fixture.json"), directories: string[] = [];
  try {
    savePipelines([finishedLane(f.root, new Date(NOW - 3600_000).toISOString())]);
    for (let n = 0; n < 2; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      if (partialMeasurement === "permission-denied") plantKeepMarker(path.join(directory, ".delegatus-keep"));
    }
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, partialMeasurement }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "20000"; process.env.LLV_PRESSURE_FIXTURE = config;
    for (let pass = 0; pass < 2; pass++) {
      const report = await realParentPass();
      expect(report).toMatchObject({ removed: 0, bytes: 24576, overCapBytes: 4576, errors: 0 });
      expect(JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8")).condition.overCap).toBeTrue();
      let physical = 0;
      for (const directory of directories) {
        physical += await allocatedAttemptBytes(directory);
        expect(fs.readFileSync(path.join(directory, "data")).length).toBe(4096);
      }
      expect(physical).toBeGreaterThan(20000);
    }
    removeKeepMarkers();
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12 }));
    const recovered = await realParentPass();
    expect(recovered).toMatchObject({ removed: 1, bytes: 12288, overCapBytes: 0, errors: 0 });
  } finally { store.close(); f.store.close(); restoreEnvironment(originalEnv); }
}, 120_000);

for (const sqliteMode of ["off", "sqlite"] as const) for (const lowSpace of [false, true]) {
  test.each(["live", "starting", "resume", "starts-during-pass", "ended"] as const)(
    `real parent protects standalone %s scratch and config (${sqliteMode}, low-space=${lowSpace})`, async kind => {
    const originalEnv = { ...process.env }, f = fixture();
    process.env.LLV_STATE_DIR = path.join(f.root, "state");
    process.env.LLV_AGENT_REGISTRY_SQLITE = sqliteMode;
    let now = NOW - 2 * 86400000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const registry = new AgentRegistry(undefined, undefined, undefined, { sqliteMode });
    let access: ReturnType<typeof materializeStructuredHostAccess> | undefined;
    try {
      const profile = { ...emptyLaunchProfile({ cwd: f.root }), title: "Standalone pressure fixture" };
      // An ended fixture has no outstanding native-start admission owner.
      const launch = registry.beginSpawnRequest({ engine: "codex", cwd: f.root,
        transport: kind === "starts-during-pass" || kind === "ended" ? null : "structured", accountId: null, launchProfile: profile });
      if (launch.kind !== "created") throw new Error("fixture launch refused");
      const artifactPath = path.join(f.root, "transcript.jsonl"); fs.writeFileSync(artifactPath, "{}\n");
      registry.completeSpawn(launch.receipt.launchId, { key: { engine: "codex", sessionId: "pressure-standalone-session" }, artifactPath, cwd: f.root,
        accountId: null, launchProfile: profile, status: (kind === "resume" || kind === "starts-during-pass" || kind === "ended" ? "dead" : kind) as AgentHostStatus,
        host: null, claimEpoch: 0, claimOwner: null, pendingAction: kind === "resume" ? "resume" : null });
      const owner = tempOwnerForConversation(registry, launch.receipt.conversationId, launch.receipt.launchId);
      expect(owner.pipelineId).toBeNull();
      access = materializeStructuredHostAccess(false, process.env, null, undefined, owner);
      const store = new AttemptTempStore();
      const owned = store.pressurePage(32);
      for (const row of owned) store.measure(row.directory, 12288);
      store.close();
      expect(owned).toHaveLength(2);
      for (const row of owned) fs.writeFileSync(path.join(row.directory, "data"), "standalone work");
      const config = path.join(f.root, "fixture.json");
      fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: lowSpace ? 0 : 1e12,
        ...(kind === "starts-during-pass" ? { resumeDuringPass: owner.launchId } : {}) }));
      process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = lowSpace ? "1000000000" : "0";
      process.env.LLV_PRESSURE_FIXTURE = config; now = NOW;
      const report = await realParentPass();
      expect(report.errors).toBe(0);
      if (kind === "ended") {
        expect(report.removed).toBeGreaterThan(0);
        let removed = report.removed;
        for (let pass = 1; removed < 2 && pass < 3; pass++) {
          // A real filesystem proof can change during a native dispatch.
          // Verify the refusal's zero effects before restarting the helper.
          for (const row of owned.filter(row => fs.existsSync(row.directory))) {
            const stat = fs.statSync(row.directory);
            expect(`${stat.dev}:${stat.ino}`).toBe(row.identity);
            expect(fs.readFileSync(path.join(row.directory, "data"), "utf8")).toBe("standalone work");
          }
          const next = await realParentPass(); expect(next.errors).toBe(0); removed += next.removed;
        }
        expect(removed).toBe(2);
      } else expect(report.removed).toBe(0);
      for (const row of owned) {
        if (kind === "ended") expect(fs.existsSync(row.directory)).toBeFalse();
        else {
          const stat = fs.statSync(row.directory);
          expect(`${stat.dev}:${stat.ino}`).toBe(row.identity);
          expect(fs.readFileSync(path.join(row.directory, "data"), "utf8")).toBe("standalone work");
        }
      }
      if (kind === "starts-during-pass") {
        expect(registry.hostEntry(registry.spawnReceipt(owner.launchId)!.key!)?.status).toBe("starting");
        expect(report.outcomes.some(row => /^authority revision [a-f0-9]{64} changed before dispatch$/.test(row.reason))).toBeTrue();
      }
    } finally { access?.cleanup(); registry.close(); clock.mockRestore(); f.store.close(); restoreEnvironment(originalEnv); }
  }, 120_000);
}

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
