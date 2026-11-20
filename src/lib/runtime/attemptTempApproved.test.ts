import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test, spyOn } from "bun:test";
import { saveTasks, mutateTaskPrototypeRound } from "@/lib/tasks/store";
import { savePipelines } from "@/lib/pipelines/store";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { approvedAttemptTempSelection, runApprovedAttemptTempSweep, type AttemptTempApprovalBinding } from "./attemptTempApproved";
import { AttemptTempStore } from "./attemptTempRetention";
import { finishedLane, holdFinishedRoot } from "./attemptTempRetention.testSupport";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import * as filesystem from "./attemptTempFilesystem";
import { WorktreeSweepWorker } from "../pipelines/worktreeSweepWorker";
import { realParentWorker } from "./attemptTempPressure.testSupport";

const NOW = Date.parse("2030-01-20T00:00:00Z"), at = new Date(NOW).toISOString();
const reviewId = "pr_" + "a".repeat(32), inputDigest = "b".repeat(64);
const scan = () => ({ ownNamespace: null, processes: [] });
afterEach(removeKeepMarkers);
function fixture(count = 1) {
  const before = { ...process.env }, root = fs.mkdtempSync(path.join(os.tmpdir(), "approved-attempt-"));
  const state = path.join(root, "state"), scratch = path.join(state, "scratch");
  fs.mkdirSync(scratch, { recursive: true }); process.env.LLV_STATE_DIR = state;
  const lane = finishedLane(root, "2020-01-01T00:00:00Z"); savePipelines([lane]);
  const store = new AttemptTempStore(), directories: string[] = [];
  for (let n = 0; n <= count; n++) {
    const directory = path.join(scratch, "llv-stage-" + String(n).padStart(6, "0")); directories.push(directory);
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "fixture payload");
    store.register({ directory, pipelineId: lane.id, launchId: "retention-launch", createdAt: NOW - 1000,
      retainUntilClose: false }); store.release(directory); store.measure(directory, 12288);
  }
  const manifest = path.join(root, "approved-roots.json"), bindingFile = path.join(state, "attempt-temp-approvals", reviewId + ".json");
  const contents = { candidates: directories.slice(0, count).map(directory => {
    const owner = store.owner(directory)!, stat = fs.statSync(directory);
    return { path: directory, launchId: owner.launchId, laneId: owner.pipelineId, evidence: { registry: {
      devInode: owner.identity, createdAt: new Date(owner.createdAt).toISOString(), released: !!owner.released,
      retainUntilClose: !!owner.retainUntilClose, uid: stat.uid } } };
  }) };
  const round: PrototypeReviewRound = { id: reviewId, taskId: "approved-task", project: "fixture", title: "Approve retained roots",
    publicationKey: "fixture-publication", inputDigest, source: { conversationId: null }, createdAt: at, variants: [],
    questions: ["scope", "execute"].map(id => ({ id, text: id, options: [{ label: "Approve" }, { label: "Decline" }] })),
    decision: { at, chosen: [], comment: "", decidedBy: { kind: "operator" }, answers: ["scope", "execute"].map(questionId => ({ questionId, options: [0] })),
      delivery: { state: "sent", conversationId: null, clientMessageId: "fixture-decision", text: "" } } };
  const tasksFile = path.join(state, "tasks.json");
  saveTasks([{ id: "approved-task", project: "fixture", text: "Approve retained roots", status: "inbox", placement: "unplaced",
    assignments: [], createdAt: at, updatedAt: at, prototypeReviews: [round] }], tasksFile);
  function writeManifest() {
    fs.writeFileSync(manifest, JSON.stringify(contents));
    const binding: AttemptTempApprovalBinding = { version: 1, taskId: "approved-task", project: "fixture", reviewId, inputDigest,
      manifestSha256: createHash("sha256").update(fs.readFileSync(manifest)).digest("hex"), manifestName: path.basename(manifest),
      count: contents.candidates.length, scopeQuestionId: "scope", executeQuestionId: "execute" };
    fs.mkdirSync(path.dirname(bindingFile), { recursive: true }); fs.writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  }
  writeManifest();
  const references = spyOn(filesystem, "attemptReferencesClear").mockResolvedValue(true);
  const request = { reviewId, manifest };
  return { root, state, scratch, store, lane, contents, directories, bindingFile, tasksFile, request, references, writeManifest,
    changeDecision(change: (round: PrototypeReviewRound) => void) { mutateTaskPrototypeRound("approved-task", reviewId, round => change(round!), tasksFile); },
    async run(env: { LLV_TEMP_SWEEP?: string } = {}) { return runApprovedAttemptTempSweep(request, { scan }, { NODE_ENV: "test", LLV_TEMP_SWEEP: "on", ...env }); },
    close() { references.mockRestore(); store.close(); for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before); fs.rmSync(root, { recursive: true, force: true }); } };
}

test.skipIf(process.platform !== "linux")("exact-list execution preserves every outside root and resumes its durable receipts in a fresh helper", async () => {
  const f = fixture(2);
  let worker: WorktreeSweepWorker | undefined;
  try {
    // The process is real; only observations of external consumers belong to
    // the fixture. Native protection, claims and removal remain enabled.
    const config = path.join(f.root, "fixture.json"); fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, realClock: true, measureCost: 0 }));
    process.env.LLV_PRESSURE_FIXTURE = config;
    const launch = { executable: process.execPath, entry: path.resolve("src/lib/worktreeSweep.worker.ts"),
      args: [] as string[] };
    // Bun preloads must precede the entry; a tiny fixture forwards to the real
    // worker so the production request protocol is exercised unchanged.
    const entry = path.join(f.root, "worker.ts");
    fs.writeFileSync(entry, `import ${JSON.stringify(path.resolve("src/lib/runtime/attemptTempPressure.preload.ts"))};\nawait import(${JSON.stringify(launch.entry)});\n`);
    worker = new WorktreeSweepWorker({ ...launch, entry }, 60000);
    const running = worker.approvedAttemptTemp(f.request);
    await expect(worker.approvedAttemptTemp({ ...f.request, reviewId: "pr_" + "c".repeat(32) })).rejects.toThrow("already running");
    const first = await running;
    expect(first).toMatchObject({ complete: true, removed: 2, removedThisRun: 2, skipped: 0 });
    expect(first.removedBytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(f.directories[2]!, "data"), "utf8")).toBe("fixture payload");
    expect(f.store.has(f.directories[2]!)).toBeTrue(); expect(f.store.activePressurePass()).toBeNull();
    await worker.close(); worker = new WorktreeSweepWorker({ ...launch, entry }, 60000);
    fs.mkdirSync(f.directories[0]!); fs.writeFileSync(path.join(f.directories[0]!, "data"), "replacement payload");
    const replay = await worker.approvedAttemptTemp(f.request);
    expect(replay.removedBytes).toBe(first.removedBytes); expect(replay.rows).toEqual(first.rows);
    expect(replay.removedThisRun).toBe(0); expect(replay.removedBytesThisRun).toBe(0);
    expect(fs.readFileSync(path.join(f.directories[0]!, "data"), "utf8")).toBe("replacement payload");
    expect(fs.readFileSync(path.join(f.directories[2]!, "data"), "utf8")).toBe("fixture payload");
  } finally { await worker?.close(); f.close(); }
}, 120000);

for (const invalid of ["missing", "agent", "recommendations", "declined", "set-aside", "other", "revised-form"] as const)
  test(`a ${invalid} primary decision cannot authorize removal`, async () => {
    const f = fixture();
    try {
      f.changeDecision(round => {
        if (invalid === "missing") delete round.decision;
        else if (invalid === "agent") round.decision!.decidedBy = { kind: "agent", conversationId: "fixture" };
        else if (invalid === "recommendations") round.decision!.skipped = true;
        else if (invalid === "declined") round.decision!.answers![0]!.options = [1];
        else if (invalid === "set-aside") round.decision!.answers![0]!.skipped = true;
        else if (invalid === "other") round.decision!.answers![0]!.other = true;
        else round.inputDigest = "c".repeat(64);
      });
      await expect(f.run()).rejects.toThrow("stored operator decision");
      expect(fs.readFileSync(path.join(f.directories[0]!, "data"), "utf8")).toBe("fixture payload");
      expect(fs.existsSync(path.join(f.state, "attempt-temp-approved"))).toBeFalse();
    } finally { f.close(); }
  });

for (const invalid of ["edited", "duplicate", "outside", "unbound"] as const)
  test(`a ${invalid} manifest has zero effects`, async () => {
    const f = fixture();
    try {
      if (invalid === "edited") fs.appendFileSync(f.request.manifest, " ");
      else if (invalid === "unbound") fs.unlinkSync(f.bindingFile);
      else { if (invalid === "duplicate") f.contents.candidates.push(f.contents.candidates[0]!);
        else f.contents.candidates[0]!.path = path.join(f.root, "llv-stage-outside"); f.writeManifest(); }
      await expect(f.run()).rejects.toThrow();
      expect(f.store.owner(f.directories[0]!)!.bytes).toBe(12288);
      expect(fs.readFileSync(path.join(f.directories[1]!, "data"), "utf8")).toBe("fixture payload");
    } finally { f.close(); }
  });

test.skipIf(process.platform !== "linux")("fresh inode, registry, keep, shared retention and consumer holds all survive", async () => {
  const f = fixture(5);
  try {
    fs.renameSync(f.directories[0]!, f.directories[0]! + "-saved"); fs.mkdirSync(f.directories[0]!);
    f.store.release(f.directories[1]!); // A registry rebind remains separate from a leaf replacement.
    f.contents.candidates[1]!.launchId = "different-launch"; f.writeManifest();
    plantKeepMarker(path.join(f.directories[2]!, ".delegatus-keep"));
    await holdFinishedRoot(f.directories[3]!, f.lane.id, "approved-shared", [f.directories[5]!]);
    // Even an expired check has another root outside the approved selection.
    f.lane.closedAt = "2020-01-01T00:00:00Z"; savePipelines([f.lane]);
    f.references.mockImplementation(async original => original !== f.directories[4]);
    const result = await f.run();
    expect(result.removed).toBe(0); expect(result.skipped).toBe(5);
    for (const directory of f.directories.slice(1)) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("fixture payload");
    expect(fs.readFileSync(path.join(f.directories[0]! + "-saved", "data"), "utf8")).toBe("fixture payload");
    const { recordedRootHeld } = await import("../recordedChecks/store");
    expect(recordedRootHeld(f.directories[5]!)).toBeTrue();
  } finally { f.close(); }
}, 60000);

test("revoking the saved decision across an awaited reference read prevents dispatch", async () => {
  const f = fixture();
  try {
    expect(approvedAttemptTempSelection(f.request).current()).toBeTrue();
    f.references.mockImplementation(async () => { f.changeDecision(round => { round.decision!.answers![0]!.options = [1]; }); return true; });
    const result = await f.run(); expect(result.removed).toBe(0);
    expect(fs.readFileSync(path.join(f.directories[0]!, "data"), "utf8")).toBe("fixture payload");
  } finally { f.close(); }
}, 60000);

test("disabled and preview modes preserve bytes and allow later authorized execution", async () => {
  const f = fixture();
  try {
    await expect(f.run({ LLV_TEMP_SWEEP: "off" })).rejects.toThrow("disabled");
    const preview = await f.run({ LLV_TEMP_SWEEP: "dry-run" }); expect(preview.removed).toBe(0); expect(preview.removedBytes).toBe(0);
    const result = await f.run(); expect(result.removed).toBe(1);
    expect(fs.readFileSync(path.join(f.directories[1]!, "data"), "utf8")).toBe("fixture payload");
  } finally { f.close(); }
}, 60000);

test("a standalone row without a lane retirement claim is retained with an explicit receipt", async () => {
  const f = fixture();
  try {
    f.contents.candidates[0]!.laneId = null; f.writeManifest();
    const result = await f.run(); expect(result.removed).toBe(0);
    expect(result.rows[0]!.reason).toContain("no lane retirement claim");
    expect(fs.readFileSync(path.join(f.directories[0]!, "data"), "utf8")).toBe("fixture payload");
  } finally { f.close(); }
});

test("a journal cannot introduce an outside target or invalid recovered outcome", async () => {
  const f = fixture();
  try {
    await f.run({ LLV_TEMP_SWEEP: "dry-run" });
    const journal = path.join(f.state, "attempt-temp-approved", reviewId + ".json"), valid = fs.readFileSync(journal, "utf8");
    for (const change of ["outside", "invalid-reason"] as const) {
      const prior = JSON.parse(valid);
      if (change === "outside") prior.rows[0].directory = f.directories[1];
      else prior.rows[0].reason = null;
      fs.writeFileSync(journal, JSON.stringify(prior));
      await expect(f.run()).rejects.toThrow("journal does not belong");
      expect(fs.readFileSync(path.join(f.directories[0]!, "data"), "utf8")).toBe("fixture payload");
      expect(fs.readFileSync(path.join(f.directories[1]!, "data"), "utf8")).toBe("fixture payload");
    }
  } finally { f.close(); }
}, 60000);

test.skipIf(process.platform !== "linux")("a fresh helper resumes after the exact 32-row page boundary", async () => {
  const f = fixture(34);
  let worker: WorktreeSweepWorker | undefined;
  try {
    for (const directory of f.directories.slice(0, 32)) plantKeepMarker(path.join(directory, ".delegatus-keep"));
    const config = path.join(f.root, "fixture.json"), entry = path.join(f.root, "worker.ts");
    fs.writeFileSync(config, JSON.stringify({ now: NOW, freeBytes: 1e12, realClock: true, measureCost: 0 }));
    process.env.LLV_PRESSURE_FIXTURE = config;
    fs.writeFileSync(entry, `import ${JSON.stringify(path.resolve("src/lib/runtime/attemptTempPressure.preload.ts"))};\nawait import(${JSON.stringify(path.resolve("src/lib/worktreeSweep.worker.ts"))});\n`);
    const launch = { executable: process.execPath, entry };
    worker = new WorktreeSweepWorker(launch, 60000);
    const first = await worker.approvedAttemptTemp(f.request);
    expect(first).toMatchObject({ complete: false, checked: 32, removed: 0, skipped: 32 });
    await worker.close(); worker = new WorktreeSweepWorker(launch, 60000);
    const last = await worker.approvedAttemptTemp(f.request);
    expect(last).toMatchObject({ complete: true, checked: 34, removed: 2, skipped: 32 });
    expect(last.freeBefore).toBe(first.freeBefore);
    for (const directory of f.directories.slice(0, 32)) expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("fixture payload");
    expect(fs.readFileSync(path.join(f.directories[34]!, "data"), "utf8")).toBe("fixture payload");
  } finally { await worker?.close(); f.close(); }
}, 120000);

test.skipIf(process.platform !== "linux")("approved lists require strictly more than 24h and reconsider retained rows after a process restart", async () => {
  const f = fixture();
  let worker: ReturnType<typeof realParentWorker> | undefined;
  try {
    f.lane.closedAt = new Date(NOW - 86400000).toISOString(); savePipelines([f.lane]);
    const config = path.join(f.root, "fixture.json"); process.env.LLV_PRESSURE_FIXTURE = config;
    for (const delta of [-1, 0, 1]) {
      fs.writeFileSync(config, JSON.stringify({ now: NOW + delta, freeBytes: 1e12, realClock: true, measureCost: 0 }));
      worker = realParentWorker(true);
      const report = await worker.approvedAttemptTemp(f.request);
      expect(report.removedThisRun).toBe(delta > 0 ? 1 : 0);
      expect(fs.existsSync(f.directories[0]!)).toBe(delta <= 0);
      expect(fs.readFileSync(path.join(f.directories[1]!, "data"), "utf8")).toBe("fixture payload");
      await worker.close(); worker = undefined;
    }
  } finally { await worker?.close(); f.close(); }
}, 120000);
