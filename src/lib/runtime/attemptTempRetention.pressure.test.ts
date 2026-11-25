import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { AttemptTempStore, sweepAttemptTemps, ATTEMPT_TEMP_LOW_SPACE_BYTES } from "./attemptTempRetention";
import { attemptTempAuthority } from "./attemptTempProduction";
import { savePipelines } from "../pipelines/store";
import { finishedLane, holdFinishedRoot, nameInReport } from "./attemptTempRetention.testSupport";
import { plantKeepMarker } from "./keepMarker.testSupport";
import { attemptReferencesClear } from "./attemptTempFilesystem";

import { cleanupPressureFixtures, NOW, roots, fixture, nativeFenceDeferrals } from "./attemptTempPressure.testSupport";

afterEach(cleanupPressureFixtures);

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

test("a missing consumer checkout is an operator decision with the root allocation", async () => {
  const f = fixture(), directory = f.make("consumer-gone");
  const checkout = path.join(f.root, "retired-consumer");
  try {
    const report = await sweepAttemptTemps(f.store, { ...f.options, capBytes: 0,
      references: async () => { await fs.promises.readdir(checkout); return true; } });
    expect(report).toMatchObject({ removed: 0, liveHeld: 0, operatorHeld: 1 });
    expect(report.operatorHeldBytes).toBeGreaterThan(0);
    expect(report.outcomes[0]).toMatchObject({ directory, disposition: "operator", bytes: report.operatorHeldBytes,
      reason: expect.stringContaining("consumer checkout became unreadable during retirement") });
    expect(fs.existsSync(directory)).toBeTrue();
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
    expect(JSON.parse(output).removed).toBe(1);
    expect(fs.existsSync(first)).toBeTrue();
    const retry = new AttemptTempStore(f.store.filename);
    try { expect((await sweepAttemptTemps(retry, { ...f.options, capBytes: 0 })).removed).toBe(1); }
    finally { retry.close(); }
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
    expect(page.length).toBe(Math.min(32, 1000 - visited.length)); visited.push(...page);
  }
  expect(visited.slice(0, 1000)).toEqual(expected);
}, 60_000);

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
])("real parent retires a safe root behind $prefix slow $phase proofs across bounded ticks", async ({ phase, prefix }) => {
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
    savePipelines([finishedLane(root, new Date(NOW - 2 * 86400_000).toISOString())]);
    for (let n = 0; n <= prefix; n++) {
      const directory = path.join(scratch, `llv-stage-${String(n).padStart(6, "0")}`); directories.push(directory);
      fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(path.join(directory, "data"), Buffer.alloc(4096));
      store.register({ directory, pipelineId: "retention-lane", launchId: "retention-launch", retainUntilClose: false, createdAt: NOW - 1000 + n });
      store.measure(directory, 12288);
      const stat = fs.statSync(directory); identities.push(`${stat.dev}:${stat.ino}`);
    }
    const baseConfig = { pressureInventory: true, now: NOW, freeBytes: 100 * ATTEMPT_TEMP_LOW_SPACE_BYTES };
    fs.writeFileSync(config, JSON.stringify({ ...baseConfig, slowProof: { phase, prefix } }));
    process.env.LLV_TEMP_SWEEP = "on"; process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "0"; process.env.LLV_PRESSURE_FIXTURE = config;
    let checked = 0, removed = 0, removedBytes = 0, deferred = 0, ticks = 0;
    const limit = Math.ceil(prefix / 7) + 1;
    // Unavailable proofs spend their full bounded window once per pass.
    // Restarting must continue beyond that prefix, including a tick cut short
    // in its last window, until the available sibling receives its visit.
    while (fs.existsSync(directories[prefix]!) && ticks < limit) {
      fs.writeFileSync(config, JSON.stringify({ ...baseConfig, slowProof: { phase, prefix } }));
      const report = await run(); ticks++;
      expect(report.errors).toBe(0);
      checked += report.checked; removed += report.removed; removedBytes += report.removedBytes; deferred += report.deferred;
      const clock = JSON.parse(fs.readFileSync(config, "utf8")) as { elapsed: number; windows: number[] };
      expect(clock.elapsed).toBeLessThanOrEqual(40_001);
      expect(Math.max(...clock.windows)).toBeLessThanOrEqual(5000);
    }
    console.error(JSON.stringify({ fixture: "slow-proof-progress", phase, prefix,
      ticks, checked, removed, removedBytes, deferred }));
    expect(removed).toBe(1); expect(removedBytes).toBe(12288);
    expect(checked).toBeLessThanOrEqual(prefix + 1 + ticks);
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
      for (const owner of directories.filter(directory => fs.existsSync(directory)).map(directory => store.owner(directory)!)) {
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
