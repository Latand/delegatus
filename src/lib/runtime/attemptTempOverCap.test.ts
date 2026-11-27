import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { AgentRegistry, closeAgentRegistryForTests } from "@/lib/agent/registry";
import { pipelineIdentity, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { RecordedCheckStore } from "@/lib/recordedChecks/store";
import { OWNERSHIP_PRELOAD, ownershipSandbox } from "@/lib/state/fixtures/ownershipSandbox";
import { writeEnvelope } from "@/lib/recordedChecks/wire";
import { attemptTempJournalPath, type ProcessScan } from "@/lib/tempSweep";
import { attemptReferencesClear } from "./attemptTempFilesystem";
import * as attemptRemoval from "./attemptTempRemoval";
import { AttemptTempStore, type AttemptTempSweepOptions } from "./attemptTempRetention";
import { runAttemptTempSweep } from "./attemptTempProduction";
import { finishedLane, holdFinishedRoot, nameInReport } from "./attemptTempRetention.testSupport";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";

const NOW = Date.parse("2035-01-15T00:00:00Z"), HOUR = 3600_000, MiB = 1024 ** 2;
const FREE = 531e9;
const roots: string[] = [];
let saved: string | undefined, clock: ReturnType<typeof spyOn<DateConstructor, "now">>;

beforeEach(() => { saved = process.env.LLV_STATE_DIR; clock = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => {
  clock.mockRestore(); removeKeepMarkers(); closeAgentRegistryForTests();
  if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "over-cap-"))); roots.push(root);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const lanes: Pipeline[] = [];
  /** A lane whose one attempt, launched as `id`, ended `hoursAgo`. */
  const lane = (id: string, hoursAgo: number, state: "completed" | "paused" = "completed", repoDir = repo): Pipeline => {
    const completedAt = new Date(NOW - hoursAgo * HOUR).toISOString();
    const base = finishedLane(repoDir, completedAt);
    const pipeline: Pipeline = { ...base, ...pipelineIdentity(id, base.task, repoDir), id, repoDir,
      runs: [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: id, effectiveRole: base.stages[0]!.effectiveRole,
        conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: completedAt, completedAt,
        input: null, activatedBy: null, output: null, verdict: null, error: null }] }] };
    if (state === "paused") Object.assign(pipeline, { state: "paused", pausedState: "running", closedAt: null });
    lanes.push(pipeline); savePipelines(lanes);
    return pipeline;
  };
  const store = () => new AttemptTempStore();
  /** One registered stage root holding `bytes` of data, released by its attempt. */
  const make = (name: string, pipeline: Pipeline, bytes = MiB) => {
    // Stage roots carry exactly the six characters `mkdtemp` appends.
    const directory = statePath("scratch", `llv-stage-${name.padEnd(6, "0").slice(0, 6)}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "payload"), Buffer.alloc(bytes, 7));
    const ledger = store();
    try {
      ledger.register({ directory, pipelineId: pipeline.id, launchId: pipeline.runs[0]!.attempts[0]!.launchId!, retainUntilClose: false,
        createdAt: Date.parse(pipeline.runs[0]!.attempts[0]!.completedAt!) - HOUR });
      ledger.release(directory);
      ledger.measure(directory, bytes);
    } finally { ledger.close(); }
    return directory;
  };
  const read = <T>(query: (ledger: AttemptTempStore) => T): T => {
    const ledger = store();
    try { return query(ledger); } finally { ledger.close(); }
  };
  const processes: ProcessScan["processes"] = [];
  const ports = {
    scan: () => ({ ownNamespace: null, processes }),
    references: (original: string, current: string, scan: ProcessScan) => attemptReferencesClear(original, current, scan, async () => true),
    availableBytes: () => FREE,
  } satisfies Pick<AttemptTempSweepOptions, "scan" | "references" | "availableBytes">;
  const tick = async (capBytes?: number, mode = "on") => (await runAttemptTempSweep(ports, { NODE_ENV: "test", LLV_TEMP_SWEEP: mode,
    ...(capBytes === undefined ? {} : { LLV_ATTEMPT_TEMP_CAP_BYTES: String(capBytes) }) }))!;
  const written = () => JSON.parse(fs.readFileSync(statePath("attempt-temp-report.json"), "utf8"));
  return { root, repo, lane, make, read, processes, ports, tick, written };
}
const present = (directories: readonly string[]) => directories.map(directory => fs.existsSync(directory));
const keptCodes = (report: { overCap: { held: Record<string, unknown> } | null }) => Object.keys(report.overCap?.held ?? {}).sort();

test("a ledger over its cap with ample free space reclaims finished scratch oldest first, until it is under the cap", async () => {
  const f = fixture();
  // Created newest first, so neither names nor registration give the order away.
  const directories = [4, 6, 8, 10].map(hours => f.make(`h${hours}`, f.lane(`lane-${hours}`, hours)));
  const report = await f.tick(2.5 * MiB);
  expect(report.lowSpace).toBeFalse();
  expect(report.errors).toBe(0);
  // The two oldest finishes bring four MiB under two and a half.
  expect(present(directories)).toEqual([true, true, false, false]);
  expect(report.overCap).toMatchObject({ removed: 2, checked: 2, ended: "cleared", errors: 0 });
  expect(report.expiryPage.removed).toBe(0);
  expect(report.removed).toBe(2);
  expect(report.overCapBytes).toBe(0);
  expect(f.written().condition.overCap).toBeFalse();
  expect(f.written().summary).toContain("expiry page 0 roots");
  expect(f.written().summary).toContain("over-cap reclaim 2 roots");
  const journal = fs.readFileSync(statePath("disk-cleaner", "ordinary-2035-01-15.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(journal.filter(row => row.phase === "removed").map(row => [row.path, row.reason])).toEqual(
    [directories[3]!, directories[2]!].map(directory => [path.relative(statePath(), directory), "over-cap"]));
  // Under the cap, the same finished scratch waits for its ordinary expiry.
  const next = await f.tick(2.5 * MiB);
  expect(next.overCap).toBeNull();
  expect(present(directories)).toEqual([true, true, false, false]);
});

test("under the cap, finished scratch keeps its 24 hours whatever else the tick does", async () => {
  const f = fixture();
  const directory = f.make("young", f.lane("lane-young", 5));
  const report = await f.tick(100 * MiB);
  expect(report).toMatchObject({ overCap: null, removed: 0, overCapBytes: 0 });
  expect(fs.existsSync(directory)).toBeTrue();
});

test("an unreadable root keeps its measured bytes while reclaim continues and publishes the report", async () => {
  const f = fixture();
  const unreadable = f.make("unread", f.lane("lane-unread", 8));
  const eligible = f.make("eligible", f.lane("lane-eligible", 6));
  const original = fs.lstatSync.bind(fs);
  const stat = spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === unreadable) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return (original as (...values: unknown[]) => ReturnType<typeof fs.lstatSync>)(target, ...args);
  }) as typeof fs.lstatSync);
  try {
    const report = await f.tick(1);
    expect(report.overCap?.outcomes).toContainEqual(expect.objectContaining({ directory: unreadable, bytes: MiB, reasonCode: "root_unreadable" }));
    expect(report.overCap?.removed).toBe(1);
    expect(fs.existsSync(unreadable)).toBeTrue();
    expect(fs.existsSync(eligible)).toBeFalse();
    expect(Date.parse(f.written().at)).not.toBeNaN();
    expect(f.written().overCap.outcomes).toContainEqual(expect.objectContaining({ directory: unreadable, reasonCode: "root_unreadable" }));
  } finally { stat.mockRestore(); }
});

test("over the cap, every existing proof still keeps its root", async () => {
  const f = fixture();
  const cases = ["live", "argv", "keep", "git", "linked", "custody", "open", "inside", "touched", "clear"] as const;
  const directories = {} as Record<typeof cases[number], string>;
  for (const name of cases) directories[name] = f.make(name, f.lane(`lane-${name}`, 5, name === "open" ? "paused" : "completed"));
  f.processes.push({ pid: 41, namespace: null, stamped: false, cwd: directories.live, paths: [directories.live] });
  f.processes.push({ pid: 42, namespace: null, stamped: false, paths: [f.repo], references: [`--input=${directories.argv}/payload`] });
  plantKeepMarker(path.join(directories.keep, ".delegatus-keep"));
  const git = path.join(directories.git, "export", ".git");
  fs.mkdirSync(path.join(git, "objects"), { recursive: true }); fs.mkdirSync(path.join(git, "refs"));
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  nameInReport(path.join(directories.linked, "payload.png"));
  await holdFinishedRoot(directories.custody, "lane-custody", "", [], "lane-custody");
  f.lane("lane-works-inside", 5, "paused", path.join(directories.inside, "checkout"));
  fs.utimesSync(path.join(directories.touched, "payload"), new Date(NOW - HOUR), new Date(NOW - HOUR));
  const report = await f.tick(1);
  expect(report.errors, JSON.stringify(report.overCap?.outcomes)).toBe(0);
  expect(Object.fromEntries(cases.map(name => [name, fs.existsSync(directories[name])])))
    .toEqual({ live: true, argv: true, keep: true, git: true, linked: true, custody: true, open: true, inside: true, touched: true, clear: false });
  const reasons = Object.fromEntries(report.overCap!.outcomes.map(row => [path.basename(row.directory), row.reasonCode]));
  const reason = (name: typeof cases[number]) => reasons[path.basename(directories[name])];
  expect([reason("custody"), reason("linked"), reason("inside"), reason("open"), reason("touched"), reason("clear")])
    .toEqual(["recorded_evidence_hold", "linked_evidence_hold", "open_lane", "owner_live", "recently_touched", "retired"]);
  expect([reason("live"), reason("argv"), reason("keep"), reason("git")])
    // The fixture's reference observer reports every hold under its own code.
    .toEqual(["reference_observer_hold", "reference_observer_hold", "keep_marker", "idle_tree_git_checkout"]);
  expect(report.overCap).toMatchObject({ removed: 1, ended: "exhausted" });
  expect(f.written().condition.overCap).toBeTrue();
  expect(keptCodes(report)).toContain("open_lane");
});

test("a lane reopened during the reference read keeps its scratch", async () => {
  const f = fixture(), pipeline = f.lane("lane-reopened", 5);
  const directory = f.make("reopen", pipeline);
  let reads = 0;
  const references = f.ports.references;
  f.ports.references = async (original, current, scan) => {
    if (++reads === 1) { Object.assign(pipeline, { state: "paused", pausedState: "running", closedAt: null }); savePipelines([pipeline]); }
    return references(original, current, scan);
  };
  const report = await f.tick(1);
  expect(reads).toBeGreaterThan(0);
  expect(report).toMatchObject({ removed: 0, errors: 0 });
  expect(fs.readFileSync(path.join(directory, "payload")).length).toBe(MiB);
});

test("a conversation that starts working inside a root during its proofs keeps it", async () => {
  const f = fixture();
  const directory = f.make("moved", f.lane("lane-moved", 5));
  const references = f.ports.references;
  let peer: AgentRegistry | undefined;
  f.ports.references = async (original, current, scan) => {
    if (!peer) {
      // Another process registers a live conversation, with no process of its
      // own for the reference proof to find.
      peer = new AgentRegistry(statePath("agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
      peer.upsert({ key: { engine: "codex", sessionId: "fixture-peer-session" },
        artifactPath: path.join(f.root, "conversation.jsonl"), cwd: path.join(directory, "work"), accountId: null, status: "live",
        host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: null });
    }
    return references(original, current, scan);
  };
  try {
    const report = await f.tick(1);
    expect(peer).toBeDefined();
    expect(report).toMatchObject({ removed: 0, errors: 0 });
    expect(report.overCap!.outcomes).toContainEqual(expect.objectContaining({ directory, reasonCode: "open_lane" }));
    expect(fs.readFileSync(path.join(directory, "payload")).length).toBe(MiB);
  } finally { peer?.close(); }
});

test("a cwd at the scratch namespace parent leaves a child eligible while a cwd inside another root holds it", async () => {
  const f = fixture();
  const parentCwd = f.make("parent", f.lane("lane-parent", 8));
  const insideCwd = f.make("inside2", f.lane("lane-inside2", 6));
  const registry = new AgentRegistry(statePath("agent-registry.json"), () => false, undefined, { sqliteMode: "sqlite" });
  registry.upsert({ key: { engine: "codex", sessionId: "scratch-parent-cwd" }, artifactPath: path.join(f.root, "parent.jsonl"),
    cwd: statePath("scratch"), accountId: null, status: "live", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: null });
  registry.upsert({ key: { engine: "codex", sessionId: "scratch-inside-cwd" }, artifactPath: path.join(f.root, "inside.jsonl"),
    cwd: path.join(insideCwd, "working"), accountId: null, status: "live", host: null, claimEpoch: 1, claimOwner: null, pendingAction: null, structuredHost: null });
  try {
    const report = await f.tick(1);
    expect(report.errors).toBe(0);
    expect(fs.existsSync(parentCwd)).toBeFalse();
    expect(fs.existsSync(insideCwd)).toBeTrue();
    expect(report.overCap?.outcomes).toContainEqual(expect.objectContaining({ directory: insideCwd, reasonCode: "open_lane" }));
  } finally { registry.close(); }
});

test("an unchanged registry is read once however many roots a reclaim proves", async () => {
  const f = fixture();
  // Reading every conversation again at each proof outlasts a root's window on
  // a large installation, so nothing there would ever be removed.
  const directories = [8, 6, 4].map(hours => f.make(`q${hours}`, f.lane(`lane-${hours}`, hours)));
  const reads = spyOn(AgentRegistry.prototype, "worktreeProtectionSnapshot");
  try {
    const report = await f.tick(1);
    expect(report).toMatchObject({ errors: 0, removed: 3 });
    expect(present(directories)).toEqual([false, false, false]);
    expect(reads.mock.calls.length).toBe(1);
  } finally { reads.mockRestore(); }
});

test("a write that lands after quarantine restores the root and keeps it for being recently touched", async () => {
  const f = fixture();
  const directory = f.make("late", f.lane("lane-late", 5));
  let written = false;
  const references = f.ports.references;
  f.ports.references = async (original, current, scan) => {
    if (current !== original && !written) {
      written = true;
      fs.utimesSync(path.join(current, "payload"), new Date(NOW - HOUR), new Date(NOW - HOUR));
    }
    return references(original, current, scan);
  };
  const report = await f.tick(1);
  expect(written).toBeTrue();
  expect(report).toMatchObject({ removed: 0, errors: 0 });
  expect(fs.readFileSync(path.join(directory, "payload")).length).toBe(MiB);
  expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
});

test("the report never calls pressure cleared while the ledger is over its cap", async () => {
  const f = fixture();
  const directory = f.make("held", f.lane("lane-held", 5, "paused"));
  // What an earlier release recorded when its pass ended under the cap.
  const database = new Database(statePath("attempt-temp.sqlite"));
  try { database.query("INSERT INTO pressure_pass_last VALUES(1,?,?,'pressure-cleared',216,1,216,0,0)").run(NOW - 72 * HOUR, NOW - 72 * HOUR + 12_000); }
  finally { database.close(); }
  const report = await f.tick(1);
  expect(report.overCapBytes).toBeGreaterThan(0);
  expect(report.overCap!.ended).toBe("exhausted");
  expect(report.lastPass!.ended).toBe("pressure-cleared");
  expect(f.written().condition.overCap).toBeTrue();
  expect(f.written().summary).not.toContain("pressure cleared");
  expect(fs.existsSync(directory)).toBeTrue();
  // Under the cap the history is shown again, with the time it happened.
  await f.tick(100 * MiB);
  expect(f.written().summary).toContain(new Date(NOW - 72 * HOUR + 12_000).toISOString());
});

test("a preview over the cap names what it would remove and removes nothing", async () => {
  const f = fixture();
  const directories = [8, 6, 4].map(hours => f.make(`p${hours}`, f.lane(`lane-${hours}`, hours)));
  const report = await f.tick(1.5 * MiB, "dry-run");
  expect(report.overCap).toMatchObject({ removed: 2, ended: "cleared" });
  expect(present(directories)).toEqual([true, true, true]);
  expect(f.written().condition.overCap).toBeTrue();
});

test("directories already gone stop counting before anything is deleted for them", async () => {
  const f = fixture();
  const gone = [30, 28].map(hours => f.make(`g${hours}`, f.lane(`lane-${hours}`, hours - 20), 8 * MiB));
  const kept = f.make("kept", f.lane("lane-kept", 4));
  for (const directory of gone) fs.rmSync(directory, { recursive: true });
  const report = await f.tick(4 * MiB);
  expect(report.errors).toBe(0);
  expect(report.overCap).toMatchObject({ removed: 0, absent: 2, ended: "cleared" });
  expect(fs.existsSync(kept)).toBeTrue();
});

test("a long held prefix of older roots does not starve a younger eligible one", async () => {
  const f = fixture(), open = f.lane("lane-open", 20, "paused");
  const held = Array.from({ length: 40 }, (_, index) => f.make(`o${String(index).padStart(2, "0")}`, open, 4096));
  const eligible = f.make("last", f.lane("lane-last", 5));
  const report = await f.tick(1);
  expect(report.errors).toBe(0);
  expect(fs.existsSync(eligible)).toBeFalse();
  expect(held.every(directory => fs.existsSync(directory))).toBeTrue();
  expect(report.overCap).toMatchObject({ removed: 1, checked: 41 });
});

test("a removal interrupted after quarantine is finished across ticks before the attempt expires", async () => {
  const f = fixture();
  const directory = f.make("cut", f.lane("lane-cut", 5));
  const crashed = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--crash-quarantined", directory],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(crashed.stdout).text(), new Response(crashed.stderr).text(), crashed.exited]);
  expect([output, exit], error).toEqual(["quarantined\n", 0]);
  expect(fs.existsSync(directory)).toBeFalse();
  expect(fs.existsSync(attemptTempJournalPath(directory))).toBeTrue();
  // The first tick's trash recovery returns the claimed tree to its owner; the
  // attempt is finished but inside its 24 hours, so reclaim takes it next.
  for (let tick = 0; tick < 2 && f.read(ledger => ledger.has(directory)); tick++) {
    clock.mockReturnValue(NOW + tick * 61_000);
    const report = await f.tick(1);
    expect(report.errors, JSON.stringify(report.overCap?.outcomes)).toBe(0);
  }
  expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
  expect(f.read(ledger => ledger.has(directory))).toBeFalse();
  expect(fs.readdirSync(statePath("scratch"))).toEqual([]);
});

test("an interrupted reclaim is finished by a later reclaim before the attempt expires", async () => {
  const f = fixture();
  const directory = f.make("resume", f.lane("lane-resume", 5));
  // A first tick under the cap spends the hourly trash discovery.
  expect((await f.tick(100 * MiB)).removed).toBe(0);
  const crashed = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--crash-quarantined", directory],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(await crashed.exited).toBe(0);
  clock.mockReturnValue(NOW + 61_000);
  const report = await f.tick(1);
  expect(report.errors, JSON.stringify(report.overCap?.outcomes)).toBe(0);
  expect(report.overCap).toMatchObject({ removed: 1, ended: "cleared" });
  expect(fs.readdirSync(statePath("scratch"))).toEqual([]);
});

test("a fresh write in quarantined scratch survives replay until idle for three hours", async () => {
  const f = fixture();
  const directory = f.make("newwrite", f.lane("lane-newwrite", 5));
  const interrupt = spyOn(attemptRemoval, "removeTreeWithinAttemptBudget").mockImplementation(async (_target, mutationStarted) => {
    mutationStarted();
    throw new Error("fixture process stopped after quarantine");
  });
  try { await f.tick(1); } finally { interrupt.mockRestore(); }
  const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8"));
  const fresh = path.join(journal.trash, "fresh-after-quarantine");
  fs.writeFileSync(fresh, "keep this new write");
  fs.utimesSync(fresh, new Date(NOW + 1000), new Date(NOW + 1000));
  clock.mockReturnValue(NOW + 1000);
  const report = await f.tick(1);
  expect(report.errors, JSON.stringify(report.overCap?.outcomes)).toBe(0);
  expect(fs.readFileSync(path.join(directory, "fresh-after-quarantine"), "utf8")).toBe("keep this new write");
});

test("an over-cap quarantine keeps a fresh write through ordinary expiry until it has been idle for three hours", async () => {
  const f = fixture();
  const directory = f.make("expirywrite", f.lane("lane-expirywrite", 23 + 54 / 60));
  const interrupt = spyOn(attemptRemoval, "removeTreeWithinAttemptBudget").mockImplementation(async (_target, mutationStarted) => {
    mutationStarted();
    throw new Error("fixture stopped after over-cap quarantine");
  });
  try { await f.tick(1); } finally { interrupt.mockRestore(); }
  const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8"));
  expect(journal.idleRequiredMs).toBe(3 * HOUR);
  const fresh = path.join(journal.trash, "fresh-after-quarantine");
  fs.writeFileSync(fresh, "wait for idle");
  const writtenAt = NOW + 10 * 60_000 - 1000;
  fs.utimesSync(fresh, new Date(writtenAt), new Date(writtenAt));

  clock.mockReturnValue(NOW + 10 * 60_000);
  const expiredTick = await f.tick(1);
  expect(expiredTick.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory, "fresh-after-quarantine"), "utf8")).toBe("wait for idle");

  clock.mockReturnValue(writtenAt + 3 * HOUR + 1000);
  const idleTick = await f.tick(1);
  expect(idleTick.removed).toBe(1);
  expect(fs.existsSync(directory)).toBeFalse();
});

test("a tick whose expiry page spends the whole budget lets reclaim go first on the next one", async () => {
  const f = fixture();
  const expired = f.make("slow", f.lane("lane-slow", 40)), young = f.make("young", f.lane("lane-young", 5));
  const hrtime = process.hrtime.bigint.bind(process.hrtime);
  let spent = BigInt(0);
  const monotonic = spyOn(process.hrtime, "bigint").mockImplementation(() => hrtime() + spent);
  const references = f.ports.references;
  f.ports.references = async (original, current, scan) => {
    // The expired root's reference proof outlasts every window of the tick.
    if (original === expired) spent += BigInt(41_000_000_000);
    return references(original, current, scan);
  };
  try {
    const first = await f.tick(1);
    expect(first.overCap).toMatchObject({ checked: 0, removed: 0, ended: "budget" });
    expect(fs.existsSync(young)).toBeTrue();
    clock.mockReturnValue(NOW + 61_000);
    const second = await f.tick(1);
    expect(second.overCap).toMatchObject({ removed: 1 });
    expect(fs.existsSync(young)).toBeFalse();
    expect(fs.existsSync(expired)).toBeTrue();
  } finally { monotonic.mockRestore(); }
});

test("an expired root whose removal was cut after it began is finished by the expiry page", async () => {
  const f = fixture();
  const directory = f.make("expcut", f.lane("lane-expired-cut", 40));
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`;
  // What a scheduled removal cut after it began leaves: its queued intent, the
  // quarantined tree and the journal. No evidence copy or check names the tree.
  f.read(ledger => ledger.queueTrashIntent(directory, identity));
  const trash = path.join(path.dirname(directory), `.delegatus-trash-${path.basename(directory)}-fixture`);
  fs.renameSync(directory, trash);
  writeEnvelope(attemptTempJournalPath(directory), { directory, trash, uid: stat.uid, identity, disposable: true });
  const report = await f.tick();
  expect(report).toMatchObject({ errors: 0, removed: 1, overCap: null });
  expect(report.outcomes.map(row => row.reasonCode)).not.toContain("recovery_owner_unknown");
  expect(fs.existsSync(trash)).toBeFalse();
  expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
  expect(f.read(ledger => ledger.has(directory))).toBeFalse();
});

/** The recorded identity a reboot leaves behind: the same inode, read earlier
 * under another device number. */
function renumber(directory: string) {
  const stat = fs.lstatSync(directory);
  const database = new Database(statePath("attempt-temp.sqlite"));
  try { database.query("UPDATE roots SET identity=? WHERE directory=?").run(`${stat.dev + 1}:${stat.ino}`, directory); }
  finally { database.close(); }
}

test.each([["expiry page", 40, undefined], ["over-cap reclaim", 5, 1]] as const)(
  "a finished root recorded under an earlier device number is bound again and removed by the %s", async (_path, hoursAgo, cap) => {
  const f = fixture();
  const directory = f.make("device", f.lane("lane-device", hoursAgo));
  renumber(directory);
  const report = await f.tick(cap);
  expect(report).toMatchObject({ errors: 0, removed: 1, rebound: 1 });
  expect(fs.existsSync(directory)).toBeFalse();
});

test.each(["another directory", "no owner marker", "born after its row"] as const)(
  "a changed root identity with %s stays held under a named reason, with no error", async change => {
  const f = fixture();
  const directory = f.make("swap", f.lane("lane-swap", 40));
  if (change === "another directory") {
    fs.renameSync(directory, path.join(f.root, "original"));
    fs.cpSync(path.join(f.root, "original"), directory, { recursive: true });
  } else {
    renumber(directory);
    if (change === "no owner marker") fs.rmSync(path.join(directory, ".delegatus-attempt-owner"));
    else {
      const database = new Database(statePath("attempt-temp.sqlite"));
      try { database.query("UPDATE roots SET createdAt=? WHERE directory=?").run(Date.parse("2001-01-01T00:00:00Z"), directory); }
      finally { database.close(); }
    }
  }
  const report = await f.tick();
  expect(report).toMatchObject({ errors: 0, removed: 0, rebound: 0 });
  expect(report.outcomes).toContainEqual(expect.objectContaining({ directory, disposition: "held", reasonCode: "root_identity_changed" }));
  expect(fs.existsSync(path.join(directory, "payload"))).toBeTrue();
});

test("recorded custody follows a renumbered root through its release and retirement", async () => {
  const f = fixture();
  const directory = f.make("custody", f.lane("lane-custody", 8 * 24));
  const lstat = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
  const earlier = lstat(directory)!;
  const recordedUnder = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: never) => {
    const stat = lstat(file, options) as fs.Stats | undefined;
    if (stat && file === directory) Object.defineProperty(stat, "dev", { value: Number(earlier.dev) + 1 });
    return stat;
  }) as typeof fs.lstatSync);
  let check: string;
  try { check = await holdFinishedRoot(directory, "lane-custody", "", [], "lane-custody"); }
  finally { recordedUnder.mockRestore(); }
  renumber(directory);
  const report = await f.tick();
  expect(report.errors, JSON.stringify(report.outcomes)).toBe(0);
  expect(report).toMatchObject({ removed: 1, rebound: 1 });
  expect(fs.existsSync(directory)).toBeFalse();
  const checks = new RecordedCheckStore();
  try {
    expect(checks.get(check)?.acknowledgement?.disposition).toBe("expired-with-lane");
    expect(checks.rootRetirement(directory, `${Number(earlier.dev) + 1}:${earlier.ino}`)).toMatchObject({ outcome: { state: "completed" } });
  } finally { checks.close(); }
});

/* A deploy leaves the previous release's ledger behind. The serving Viewer
 * opens it at startup, and the minute tick then runs in a `tool` helper, which
 * may change no schema in the operator's own state directory. Sandboxed state
 * never meets that fence, so these run real processes under an operator-shaped
 * home. */
test.each([
  ["over the cap, over-cap reclaim", 5, "1", { expiryPage: { removed: 0 }, overCap: { removed: 1, ended: "cleared" } }],
  ["under the cap, the expiry page", 40, String(100 * MiB), { expiryPage: { removed: 1 }, overCap: null }],
] as const)("on an upgraded install, %s removes scratch from the tool helper and writes its report", (_case, hoursAgo, cap, expected) => {
  const sandbox = ownershipSandbox();
  try {
    const repo = path.join(sandbox.temporaryRoot(), "repo"); fs.mkdirSync(repo);
    const run = (owner: "viewer" | "tool", ...argv: string[]) => {
      const result = Bun.spawnSync({ cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD,
        path.join(import.meta.dir, "attemptTempOverCap.fixture.ts"), ...argv],
        cwd: process.cwd(), env: { ...sandbox.environment(), LLV_STATE_OWNER: owner }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const stderr = result.stderr.toString();
      expect(result.exitCode, `${owner} ${argv[0]}\n${stderr}`).toBe(0);
      return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
    };
    const seeded = run("viewer", "--seed-previous-release", String(hoursAgo), repo).answer;
    expect(path.relative(sandbox.home, seeded.directory).startsWith("..")).toBeFalse();
    expect(seeded.tables).toContain("routine_sweep_cursor");
    expect(seeded.tables).not.toContain("over_cap_cursor");
    // No tick has run yet, so the report read below is this tick's own.
    const started = run("viewer", "--viewer-start");
    expect(fs.existsSync(started.report)).toBeFalse();
    const tick = run("tool", "--minute-tick", cap);
    expect(tick.answer, JSON.stringify(tick.answer.outcomes)).toMatchObject({ ...expected, removed: 1, errors: 0 });
    expect(fs.existsSync(seeded.directory)).toBeFalse();
    expect(JSON.parse(fs.readFileSync(tick.report, "utf8"))).toMatchObject({ ...expected, removed: 1, errors: 0 });
  } finally { sandbox.release(); }
}, 120_000);

test("a fresh helper uses its current cap after a prior tick starved at one byte", () => {
  const sandbox = ownershipSandbox();
  try {
    const run = (owner: "viewer" | "tool", ...argv: string[]) => {
      const result = Bun.spawnSync({ cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD,
        path.join(import.meta.dir, "attemptTempOverCap.fixture.ts"), ...argv],
        cwd: process.cwd(), env: { ...sandbox.environment(), LLV_STATE_OWNER: owner }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
    };
    const seeded = run("viewer", "--seed-previous-release", "5", path.join(sandbox.temporaryRoot(), "repo")).answer;
    run("viewer", "--viewer-start");
    run("viewer", "--record-starved-report");
    const tick = run("tool", "--minute-tick", String(100 * MiB));
    expect(tick.answer.overCap).toMatchObject({ capBytes: 100 * MiB, removed: 0 });
    expect(fs.existsSync(seeded.directory)).toBeTrue();
  } finally { sandbox.release(); }
}, 120_000);

test("a leading retry reclaims against a zero disk-adjusted cap", () => {
  const sandbox = ownershipSandbox();
  try {
    const run = (owner: "viewer" | "tool", ...argv: string[]) => {
      const result = Bun.spawnSync({ cmd: [process.execPath, "--preload", OWNERSHIP_PRELOAD,
        path.join(import.meta.dir, "attemptTempOverCap.fixture.ts"), ...argv],
        cwd: process.cwd(), env: { ...sandbox.environment(), LLV_STATE_OWNER: owner }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!);
    };
    const seeded = run("viewer", "--seed-previous-release", "5", path.join(sandbox.temporaryRoot(), "repo"), String(2 * MiB)).answer;
    run("viewer", "--viewer-start");
    run("viewer", "--record-starved-report", String(MiB));
    const tick = run("tool", "--minute-tick-low-space", String(100 * MiB));
    expect(tick.answer.overCap).toMatchObject({ capBytes: 0, removed: 1, ended: "cleared" });
    expect(fs.existsSync(seeded.directory)).toBeFalse();
  } finally { sandbox.release(); }
}, 120_000);
