import fs from "node:fs";
import { createHash } from "node:crypto";
import * as attemptRemoval from "./attemptTempRemoval";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { buildPipeline, savePipelines, findPipelineRecord, pipelineIdentity } from "@/lib/pipelines/store";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { materializeOwnedStructuredHostAccess, materializeStructuredHostAccess, tempOwnerForConversation } from "./structuredSpawn";
import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { stageGitReceiptDirectory } from "@/lib/git/stageAttemptGuard";
import { withAgentConfigSandbox } from "./agentConfigSandbox";
import { runTempSweep, scanProcesses, sweepStaleTempDirs, type ProcessScan } from "@/lib/tempSweep";
import { statePath } from "@/lib/configDir";
import { attemptReferencesClear, RepositoryLinkInventory } from "./attemptTempFilesystem";
import { holdFinishedRoot, finishedLane, nameInReport } from "./attemptTempRetention.testSupport";
import { ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS, attemptScratchExpiry } from "./attemptScratchPolicy";
import { attemptScratchAuthority } from "./attemptTempProduction";
import { RecordedCheckStore, recordedRootHeld } from "@/lib/recordedChecks/store";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { plantKeepMarker, removeKeepMarkers } from "./keepMarker.testSupport";
import { AttemptTempStore } from "./attemptTempRetention";
import { runAttemptTempSweep } from "./attemptTempProduction";
import { AttemptTempBudgetDeferred } from "./attemptTempDiagnostics";
import { writeEnvelope } from "@/lib/recordedChecks/wire";
import { realParentPass, restoreEnvironment } from "./attemptTempPressure.testSupport";

test("a production tick schedules a parked terminal failure and retains a passed reopened cursor", async () => {
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-parked-failure-")); roots.push(root);
  isolateState(root);
  const now = Date.parse("2026-10-20T12:30:00.000Z"), clock = spyOn(Date, "now").mockReturnValue(now);
  const p = finishedLane(root, "2026-10-01T00:00:00Z"); p.state = "running";
  p.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
  const completedAt = "2026-10-20T12:00:00.000Z";
  const attempt: PipelineStageAttempt = { n: 1, state: "failed", launchId: "parked-launch", effectiveRole: p.stages[0]!.effectiveRole,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-20T11:00:00.000Z", completedAt, input: null, activatedBy: null, output: "failed", verdict: { status: "fail" }, error: null };
  p.runs = [{ stageId: "build", attempts: [attempt] }];
  savePipelines([p]);
  const owner = { launchId: attempt.launchId!, retainUntilClose: false, createdAt: Date.parse("2026-10-20T11:00:00Z") };
  const directory = statePath("scratch", "llv-stage-parked"); fs.mkdirSync(directory, { recursive: true });
  const store = new AttemptTempStore();
  try {
    store.register({ directory, pipelineId: p.id, launchId: owner.launchId, retainUntilClose: false, createdAt: owner.createdAt });
    expect(await runAttemptTempSweep({ scan: () => ({ ownNamespace: null, processes: [] }) },
      { NODE_ENV: "test", LLV_TEMP_SWEEP: "on" })).not.toBeNull();
    expect(store.retentionExpiry(directory)).toBe(Date.parse(completedAt) + ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS);
    p.runs[0]!.attempts[0] = { ...attempt, state: "passed" }; savePipelines([p]);
    expect(attemptScratchExpiry(p, owner)).toBeNull();
  } finally { store.close(); clock.mockRestore(); }
});

test("a restarted scheduled sweep restores a quarantined root before expiry and permits reopening", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-crash-before-expiry-")); roots.push(root); isolateState(root);
  const now = Date.parse("2035-01-15T00:00:00Z"), clock = spyOn(Date, "now").mockReturnValue(now);
  const pipeline = finishedLane(root, new Date(now - 60 * 60_000).toISOString()); savePipelines([pipeline]);
  const directory = statePath("scratch", "llv-stage-crash"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "payload"), "retained payload");
  const store = new AttemptTempStore(); let storeClosed = false;
  try {
    await holdFinishedRoot(directory, pipeline.id, "", [], "crash-launch");
    store.register({ directory, pipelineId: pipeline.id, launchId: "crash-launch", retainUntilClose: false, createdAt: now - 2 * 60 * 60_000 });
    const stat = fs.lstatSync(directory), trash = path.join(path.dirname(directory), `.delegatus-trash-${path.basename(directory)}-crash`);
    fs.renameSync(directory, trash);
    fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid,
      identity: `${stat.dev}:${stat.ino}`, disposable: true }));
    store.queueTrashIntent(directory, `${stat.dev}:${stat.ino}`);
    store.close(); storeClosed = true; // The next tick opens a fresh ledger after the owner process died.
    const restarted = new AttemptTempStore();
    try {
      const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
      const report = await sweepAttemptTemps(restarted, { now: () => now, authority,
        state: async (owner, inventory) => (await authority(owner, inventory)).state,
        scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true, scheduledOnly: true });
      expect(report.removed).toBe(0);
      expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained payload");
      expect(fs.existsSync(trash)).toBeFalse();
      expect(restarted.owner(directory)).toMatchObject({ pipelineId: pipeline.id, launchId: "crash-launch" });
      const reopened = structuredClone(pipeline); reopened.state = "running"; reopened.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
      expect(() => savePipelines([reopened])).not.toThrow();
      const terminal = structuredClone(reopened); terminal.state = "completed"; terminal.cursor = null;
      terminal.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "crash-launch",
        effectiveRole: terminal.stages[0]!.effectiveRole, conversationId: "fixture", sessionId: null,
        agentPath: null, paneId: null, flowId: null, startedAt: new Date(now - 60_000).toISOString(),
        completedAt: new Date(now).toISOString(), input: null, activatedBy: null, output: "passed", verdict: { status: "pass" }, error: null }] }];
      savePipelines([terminal]);
      const { recordingAttemptTempState } = await import("./attemptTempProduction");
      await recordingAttemptTempState(restarted)(restarted.owner(directory)!);
      expect(restarted.retentionExpiry(directory)).not.toBeNull();
    } finally { restarted.close(); }
  } finally { if (!storeClosed) store.close(); clock.mockRestore(); }
});

test.each([false, true])("all roots of an acknowledged check await expiry after clock rollback (restart=%s)", async restart => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-sibling-rollback-")); roots.push(root);
  const expired = Date.parse("2026-11-01T00:00:01Z"), cutoff = expired - 1000, beforeExpiry = expired - 86400000;
  let now = expired;
  const p = finishedLane(root, "2026-10-25T00:00:00Z"); savePipelines([p]);
  const directories = ["first", "sibling"].map(name => path.join(root, `llv-stage-${name}`));
  const filename = path.join(root, "owners.sqlite"), store = new AttemptTempStore(filename);
  for (const [index, directory] of directories.entries()) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "retained data");
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: index + 1 });
  }
  const id = await holdFinishedRoot(directories[0], p.id, "", directories.slice(1));
  const write = RecordedCheckStore.prototype.write;
  const acknowledgement = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, ...args: Parameters<typeof write>) {
    const result = await write.apply(this, args);
    if (args[0].acknowledgement?.disposition === "expired-with-lane") now = beforeExpiry;
    return result;
  });
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const options = { now: () => now, authority, state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
    maxRoots: 1, references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) };
  const sweep = async () => {
    if (!restart) return sweepAttemptTemps(store, options);
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), filename, String(now), "production"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    return JSON.parse(output);
  };
  try {
    expect((await sweepAttemptTemps(store, options)).removed).toBe(0);
    const checks = new RecordedCheckStore();
    try { expect(checks.get(id)?.acknowledgement?.disposition).toBe("expired-with-lane"); } finally { checks.close(); }
    for (const directory of directories) {
      expect(recordedRootHeld(directory)).toBeFalse();
      expect(store.requiredRootExpiry(directory)).toBe(cutoff);
    }
    now = beforeExpiry + 60001;
    // The sibling was outside the first page; force both visits before expiry.
    for (const directory of directories) store.release(directory);
    for (let n = 0; n < directories.length; n++) {
      const report = await sweep();
      expect(report.checked).toBe(1); expect(report.removed).toBe(0); expect(report.errors).toBe(0);
    }
    for (const directory of directories) expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained data");
    now = expired;
    for (const directory of directories) store.release(directory);
    for (let n = 0; n < directories.length; n++) expect((await sweep()).removed).toBe(1);
    for (const directory of directories) { expect(fs.existsSync(directory)).toBeFalse(); expect(store.has(directory)).toBeFalse(); }
  } finally { acknowledgement.mockRestore(); store.close(); }
});

test.each(["acknowledgement", "quarantine", "removal"] as const)(
  "previously held roots retain their expiry across clock rollback at %s and a process restart", async boundary => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-clock-rollback-")); roots.push(root);
  const expired = Date.parse("2026-11-01T00:00:01Z"), beforeExpiry = expired - 86400000;
  let now = expired, rolledBack = false;
  const p = finishedLane(root, "2026-10-25T00:00:00Z"); savePipelines([p]);
  const directory = path.join(root, "llv-stage-clock-rollback"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "retained data");
  const filename = path.join(root, "owners.sqlite"), store = new AttemptTempStore(filename);
  store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: 1 });
  const id = await holdFinishedRoot(directory);
  const rollback = () => { now = beforeExpiry; rolledBack = true; };
  const write = RecordedCheckStore.prototype.write;
  const acknowledgement = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, ...args: Parameters<typeof write>) {
    const result = await write.apply(this, args);
    if (boundary === "acknowledgement" && args[0].acknowledgement?.disposition === "expired-with-lane") rollback();
    return result;
  });
  const rename = fs.renameSync.bind(fs);
  const quarantine = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    if (boundary === "quarantine" && from === directory && path.basename(String(to)).startsWith(".delegatus-trash-")) rollback();
  });
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const options = { now: () => now, authority, state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
    references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    const report = await sweepAttemptTemps(store, { ...options, ...(boundary === "removal" ? { remove: async (target, _guard, dispatch) => {
      rollback();
      if (!dispatch()) throw new Error("attempt temp deferred: clock rollback before removal");
      await fs.promises.rm(target, { recursive: true });
    } } : {}) });
    expect(rolledBack).toBeTrue(); expect(report.removed).toBe(0); expect(report.errors).toBe(0);
    expect(store.requiredRootExpiry(directory)).toBe(Date.parse("2026-11-01T00:00:00Z"));
    store.release(directory); // Force the next process to inspect before expiry.
    const checks = new RecordedCheckStore();
    try { expect(checks.get(id)?.acknowledgement?.disposition).toBe("expired-with-lane"); } finally { checks.close(); }
  } finally { acknowledgement.mockRestore(); quarantine.mockRestore(); store.close(); }
  // A new OS process must honor the persisted prerequisite, even though the
  // check is already acknowledged and its root is no longer held.
  const fixture = path.join(import.meta.dir, "attemptTempRetention.fixture.ts");
  const restart = Bun.spawn([process.execPath, fixture, filename, String(beforeExpiry + 60001), "closed"],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(restart.stdout).text(), new Response(restart.stderr).text(), restart.exited]);
  expect(exit, error).toBe(0); expect(JSON.parse(output).checked).toBe(1); expect(JSON.parse(output).removed).toBe(0);
  expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("retained data");
  const recovered = new AttemptTempStore(filename);
  try { now = expired; expect((await sweepAttemptTemps(recovered, options)).removed).toBe(1); }
  finally { recovered.close(); }
});

test.each([["root", false], ["copy", false], ["root", true], ["copy", true]] as const)(
  "a protected %s quarantine releases retry and reopen after owner death (already restored=%s)", async (kind, restored) => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const { sweepEvidenceCopies } = await import("./attemptEvidenceCopies");
  const { digest } = await import("@/lib/recordedChecks/wire");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-protected-replay-")); roots.push(root);
  isolateState(root); // The copy case writes its marker through statePath().
  const now = Date.parse("2026-11-01T00:00:01Z"), p = finishedLane(root, "2026-10-01T00:00:00Z");
  p.merge = { state: "blocked", by: null, repository: "fixture/repository", prNumber: 1,
    policyChangedAt: p.closedAt!, reviewedHead: "a".repeat(40), chain: [], updates: [], seenChecks: [], head: null, headSeenAt: null,
    lastChecks: null, readAt: null, nextReadAt: null, requestedAt: p.closedAt!, mergedHead: null, mergeCommit: null, method: null,
    mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: p.closedAt! };
  savePipelines([p]);
  const directory = kind === "root" ? path.join(root, "llv-stage-protected-replay") : statePath("evidence", "attempt-temp", digest(root));
  fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
  plantKeepMarker(path.join(directory, "nested", ".delegatus-keep"));
  fs.writeFileSync(path.join(directory, "payload"), "keep data");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  if (kind === "root") store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: 1 });
  else store.registerCopy({ destination: directory, pipelineId: p.id, launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
  const fixture = path.join(import.meta.dir, "attemptTempRetention.fixture.ts");
  const owner = Bun.spawn([process.execPath, fixture, "--claim-hold", p.id, directory],
    { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = owner.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); reader.releaseLock();
    const stat = fs.lstatSync(directory), trash = path.join(path.dirname(directory), `.delegatus-trash-${path.basename(directory)}-replay`);
    fs.renameSync(directory, trash);
    fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid, identity: `${stat.dev}:${stat.ino}`, disposable: true }));
    if (restored) fs.renameSync(trash, directory); // Crash before journal cancellation.
    owner.stdin.end(); expect(await owner.exited).toBe(0);
    const queued = structuredClone(p); queued.merge!.state = "queued"; queued.merge!.attempts++; queued.merge!.updatedAt = new Date(now).toISOString();
    expect(() => savePipelines([queued])).toThrow("retirement pending");
    const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
    for (let i = 0; i < 3; i++) {
      const report = await (kind === "root" ? sweepAttemptTemps : sweepEvidenceCopies)(store, { now: () => now + i * 60001,
        authority, state: async (owner, inventory) => (await authority(owner, inventory)).state,
        references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) });
      expect(report.removed).toBe(0); expect(report.errors).toBe(0);
    }
    expect(fs.existsSync(trash)).toBeFalse(); expect(fs.existsSync(attemptTempJournalPath(directory))).toBeFalse();
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep data");
    expect(fs.existsSync(path.join(directory, "nested", ".delegatus-keep"))).toBeTrue();
    expect(() => savePipelines([queued])).not.toThrow();
    queued.state = "running"; expect(() => savePipelines([queued])).not.toThrow();
  } finally { owner.stdin.end(); await owner.exited; store.close(); }
});

test.each(["identity", "occupied", "binding"] as const)("refused quarantine cancellation preserves a changed %s and its claim", async change => {
  const { claimAttemptRetirement } = await import("@/lib/pipelines/store");
  const { restoreRefusedAttemptTrash } = await import("@/lib/pipelines/retirementClaim");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-cancel-fence-")); roots.push(root);
  const p = finishedLane(root, "2026-10-01T00:00:00Z"); savePipelines([p]);
  const directory = path.join(root, "llv-stage-cancel"), trash = path.join(root, ".delegatus-trash-llv-stage-cancel-replay");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep data");
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`;
  const release = await claimAttemptRetirement(p.id, directory);
  fs.renameSync(directory, trash);
  const journal = attemptTempJournalPath(directory);
  fs.writeFileSync(journal, JSON.stringify({ directory: change === "binding" ? directory + "-other" : directory,
    trash, identity: change === "identity" ? "0:0" : identity, uid: stat.uid, disposable: true }));
  if (change === "occupied") { fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "replacement"); }
  try {
    expect(() => restoreRefusedAttemptTrash(directory, identity)).toThrow("changed");
    expect(fs.existsSync(journal)).toBeTrue(); expect(fs.readFileSync(path.join(trash, "payload"), "utf8")).toBe("keep data");
    if (change === "occupied") expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("replacement");
    release(); p.state = "running"; expect(() => savePipelines([p])).toThrow("retirement pending");
  } finally { fs.unlinkSync(journal); release(); } // Only this test owns the intent; no remover was launched.
});

test.each([null, "invalid-clock"])("unknown completed attempt clock preserves the real hold and automatic copy (%s)", async completedAt => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const { sweepEvidenceCopies } = await import("./attemptEvidenceCopies");
  const { digest } = await import("@/lib/recordedChecks/wire");
  const now = Date.parse("2026-11-01T00:00:01Z"), root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-unknown-clock-")); roots.push(root);
  const directory = path.join(root, "llv-stage-clock"); fs.mkdirSync(directory);
  const p = finishedLane(root, "2026-10-01T00:00:00Z");
  p.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", effectiveRole: p.stages[0].effectiveRole,
    launchId: "retention-launch", conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: p.closedAt!, completedAt, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const copy = statePath("evidence", "attempt-temp", digest(root)); fs.mkdirSync(copy, { recursive: true });
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const options = { now: () => now, authority, state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
    references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: 1 });
    store.registerCopy({ destination: copy, pipelineId: p.id, launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
    await holdFinishedRoot(directory);
    expect((await sweepAttemptTemps(store, options)).removed).toBe(0); expect(recordedRootHeld(directory)).toBeTrue();
    expect((await sweepEvidenceCopies(store, options)).removed).toBe(0); expect(fs.existsSync(copy)).toBeTrue();
  } finally { store.close(); }
});

test.each([["root", "retry"], ["root", "reopen"], ["copy", "retry"], ["copy", "reopen"]])(
  "retry admission is fenced throughout asynchronous %s removal (%s)", async (kind, mutation) => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const { sweepEvidenceCopies } = await import("./attemptEvidenceCopies");
  const { digest } = await import("@/lib/recordedChecks/wire");
  const now = Date.parse("2026-11-01T00:00:01Z"), root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-retry-fence-")); roots.push(root);
  const directory = kind === "root" ? path.join(root, "llv-stage-retry") : statePath("evidence", "attempt-temp", digest(root));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "payload"), "previous evidence");
  const p = finishedLane(root, "2026-10-01T00:00:00Z");
  p.merge = { state: "blocked", by: null, repository: "fixture/repository", prNumber: 1,
    policyChangedAt: p.closedAt!, reviewedHead: "a".repeat(40), chain: [], updates: [], seenChecks: [], head: null, headSeenAt: null,
    lastChecks: null, readAt: null, nextReadAt: null, requestedAt: p.closedAt!, mergedHead: null, mergeCommit: null, method: null,
    mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: p.closedAt! };
  savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  let observed = false;
  const rm = attemptRemoval.removeTreeWithinAttemptBudget;
  const removal = spyOn(attemptRemoval, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started) => {
    if (path.basename(String(target)).startsWith(".delegatus-trash-")) {
      const reopened = structuredClone(p);
      if (mutation === "reopen") reopened.state = "running";
      else { reopened.merge!.state = "queued"; reopened.merge!.attempts++; reopened.merge!.updatedAt = new Date(now).toISOString(); }
      expect(() => savePipelines([reopened])).toThrow("retirement pending");
      expect(findPipelineRecord(p.id)?.state).toBe("completed"); expect(findPipelineRecord(p.id)?.merge?.state).toBe("blocked"); observed = true;
      const independent = buildPipeline({ id: "independent-retention", task: "Independent", project: "fixture", repoDir: root,
        stages: [], state: "draft", srcPath: null, srcConversationId: null, now: p.closedAt! });
      expect(() => savePipelines([p, independent])).not.toThrow();
      await Promise.resolve();
      expect(() => savePipelines([reopened])).toThrow("retirement pending");
    }
    return rm(target, started);
  });
  try {
    if (kind === "root") { store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: 1 }); await holdFinishedRoot(directory); }
    else store.registerCopy({ destination: directory, pipelineId: p.id, launchId: "copy", kind: "lane", createdAt: 1, expiresAt: 1, checkedAt: 0, bytes: 4096 });
    const options = { now: () => now, authority, state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
      references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) };
    expect((await (kind === "root" ? sweepAttemptTemps(store, options) : sweepEvidenceCopies(store, options))).removed).toBe(1);
    expect(observed).toBeTrue(); expect(fs.existsSync(directory)).toBeFalse();
    p.state = "running"; expect(() => savePipelines([p])).not.toThrow();
  } finally { removal.mockRestore(); store.close(); }
});

test.each([false, true])("a retirement claim recovers after owner death (pending journal=%s)", async pending => {
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const now = Date.parse("2026-11-01T00:00:01Z"), root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-claim-restart-")); roots.push(root);
  const directory = path.join(root, "llv-stage-restart"); fs.mkdirSync(directory);
  const p = finishedLane(root, "2026-10-01T00:00:00Z"); savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: false, createdAt: 1 }); store.close();
  const fixture = path.join(import.meta.dir, "attemptTempRetention.fixture.ts");
  const owner = Bun.spawn([process.execPath, fixture, "--claim-hold", p.id, directory], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  try {
    const reader = owner.stdout.getReader();
    const ready = await reader.read(); expect(new TextDecoder().decode(ready.value)).toBe("ready\n"); reader.releaseLock();
    const reopened = structuredClone(p); reopened.state = "running";
    expect(() => savePipelines([reopened])).toThrow("retirement pending");
    if (pending) {
      const { attemptTempJournalPath } = await import("@/lib/tempSweep");
      const trash = path.join(root, ".delegatus-trash-llv-stage-restart-replay"), stat = fs.lstatSync(directory);
      fs.renameSync(directory, trash);
      fs.writeFileSync(attemptTempJournalPath(directory), JSON.stringify({ directory, trash, uid: stat.uid,
        identity: `${stat.dev}:${stat.ino}`, disposable: true }));
    } else {
      // A process may finish settlement but die before releasing its claim.
      const settled = new AttemptTempStore(path.join(root, "owners.sqlite"));
      try { settled.forget(directory); } finally { settled.close(); }
    }
    owner.stdin.end(); expect(await owner.exited).toBe(0);
    if (!pending) {
      expect(() => savePipelines([reopened])).not.toThrow(); expect(fs.existsSync(directory)).toBeTrue(); return;
    }
    expect(() => savePipelines([reopened])).toThrow("retirement pending");
    const recovery = Bun.spawn([process.execPath, fixture, path.join(root, "owners.sqlite"), String(now), "expired"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(recovery.stdout).text(), new Response(recovery.stderr).text(), recovery.exited]);
    expect(exit, error).toBe(0); expect(JSON.parse(output).removed).toBe(1);
    expect(() => savePipelines([reopened])).not.toThrow();
  } finally { owner.stdin.end(); await owner.exited; }
});

test("seven-day retention settles an unread check and retires its root in one visit", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const now = Date.parse("2026-11-01T00:00:01Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-expiry-")); roots.push(root);
  const directory = path.join(root, "llv-stage-expired"); fs.mkdirSync(directory);
  const p = buildPipeline({ id: "retention-lane", task: "Retention", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-10-24T00:00:00Z" });
  p.state = "completed"; p.cursor = null; p.closedAt = "2026-10-25T00:00:00Z"; savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: now - 9 * 86400000 });
    const identity = store.owner(directory)!.identity, id = await holdFinishedRoot(directory);
    const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
    const report = await sweepAttemptTemps(store, { now: () => now, state: async (owner, inventory) => (await authority(owner, inventory)).state,
      authority, scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report.errors).toBe(0); expect(report.removed).toBe(1);
    expect(fs.existsSync(directory)).toBeFalse(); expect(store.has(directory)).toBeFalse(); expect(recordedRootHeld(directory)).toBeFalse();
    const checks = new RecordedCheckStore();
    try {
      expect(checks.get(id)?.acknowledgement).toMatchObject({ disposition: "expired-with-lane", actor: "retention", at: now });
      expect(checks.rootRetirement(directory, identity)).toMatchObject({ outcome: { state: "completed" } });
    } finally { checks.close(); }
  } finally { store.close(); }
});

test.each([false, true])("six-day retention keeps the check and excludes human pins from reclaimable bytes (keep=%s)", async keep => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const now = Date.parse("2026-11-01T00:00:00Z"), expiresAt = now + 86400000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-six-days-")); roots.push(root);
  const directory = path.join(root, "llv-stage-held"); fs.mkdirSync(directory);
  if (keep) plantKeepMarker(path.join(directory, ".delegatus-keep"));
  const p = finishedLane(root, "2026-10-26T00:00:00Z"); savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: now - 9 * 86400000 });
    const id = await holdFinishedRoot(directory);
    const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
    const report = await sweepAttemptTemps(store, { now: () => now, state: async (owner, inventory) => (await authority(owner, inventory)).state,
      authority, scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report.removed).toBe(0); expect(recordedRootHeld(directory)).toBeTrue();
    expect(store.owner(directory)?.checkedAt).toBe(expiresAt);
    expect(store.retentionExpiry(directory)).toBe(expiresAt);
    expect(store.retention(now).upcomingBytes > 0).toBe(!keep);
    const checks = new RecordedCheckStore();
    try { expect(checks.get(id)?.acknowledgement).toBeNull(); } finally { checks.close(); }
  } finally { store.close(); }
});

test("lane revision and a clock moving backwards revoke expiry after awaited observations", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-expiry-fence-")); roots.push(root);
  let now = Date.parse("2026-11-01T00:00:01Z");
  const p = finishedLane(root, "2026-10-25T00:00:00Z"); savePipelines([p]);
  const directory = path.join(root, "llv-stage-fenced"); fs.mkdirSync(directory);
  const owner = { directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: 1 };
  const observation = await attemptTempAuthority(owner, undefined, () => now);
  expect(observation.state).toBe("expired");
  now -= 86400000; expect(observation.isCurrent()).toBeFalse();
  now += 86400000;
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  try {
    store.register(owner); await holdFinishedRoot(directory);
    const write = RecordedCheckStore.prototype.write;
    const changed = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, row, revision, authority, waitMs) {
      if (row.acknowledgement?.disposition === "expired-with-lane") { p.state = "running"; savePipelines([p]); }
      return write.call(this, row, revision, authority, waitMs);
    });
    try {
      const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
      const report = await sweepAttemptTemps(store, { now: () => now, authority, state: async (owner, inventory) => (await authority(owner, inventory)).state,
        references: async () => true, scan: () => ({ ownNamespace: null, processes: [] }) });
      expect(report.removed).toBe(0); expect(report.errors).toBe(1); expect(recordedRootHeld(directory)).toBeTrue();
    } finally { changed.mockRestore(); }
  } finally { store.close(); }
});

test("an unheld recent root retires immediately and its evidence copy inherits the lane clock", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const { sweepEvidenceCopies } = await import("./attemptEvidenceCopies");
  let now = Date.parse("2026-11-01T01:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-recent-")); roots.push(root);
  const directory = path.join(root, "llv-stage-recent"); fs.mkdirSync(path.join(directory, ".artifacts"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".artifacts", "frame.png"), "evidence");
  const p = finishedLane(root, "2026-11-01T00:00:00Z"); savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const options = { now: () => now, state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
    authority, scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true };
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: now - 3600000 });
    expect((await sweepAttemptTemps(store, options)).removed).toBe(1);
    const parent = statePath("evidence", "attempt-temp");
    const destination = fs.readdirSync(parent).map(name => path.join(parent, name)).find(name => store.copy(name)?.pipelineId === p.id)!;
    expect(store.copy(destination)?.expiresAt).toBe(Date.parse("2026-11-08T00:00:00Z"));
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ pipelineId: p.id, launchId: "retention-launch" });
    expect((await sweepEvidenceCopies(store, options)).removed).toBe(0);
    now = Date.parse("2026-11-08T00:00:01Z");
    expect((await sweepEvidenceCopies(store, options)).removed).toBe(1);
    expect(fs.existsSync(destination)).toBeFalse();
  } finally { store.close(); }
});

test("retrying preservation recreates a missing copy before expiry and stops doing so after expiry", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const { sweepEvidenceCopies } = await import("./attemptEvidenceCopies");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-copy-producer-")); roots.push(root);
  const directory = path.join(root, "llv-stage-producer"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "frame.png"), "source evidence");
  let now = Date.parse("2026-11-01T01:00:00Z"), references = 0;
  const p = finishedLane(root, "2026-11-01T00:00:00Z"); savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const options = { now: () => now, authority,
    state: async (owner: Parameters<typeof authority>[0], inventory: Parameters<typeof authority>[1]) => (await authority(owner, inventory)).state,
    // The second observation refuses deletion after preservation. Each retry
    // must then run the real preservation producer again.
    references: async () => ++references % 2 === 1, scan: () => ({ ownNamespace: null, processes: [] }) };
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: false, createdAt: now });
    expect((await sweepAttemptTemps(store, options)).removed).toBe(0);
    const parent = statePath("evidence", "attempt-temp");
    const destination = fs.readdirSync(parent).map(name => path.join(parent, name)).find(name => store.copy(name))!;
    const prior = path.join(root, "previous-copy"); fs.renameSync(destination, prior);
    store.defer(directory, 0);
    expect((await sweepAttemptTemps(store, options)).removed).toBe(0);
    expect(fs.existsSync(destination)).toBeTrue();
    expect(fs.lstatSync(destination).ino).not.toBe(fs.lstatSync(prior).ino);
    now = Date.parse("2026-11-08T00:00:01Z");
    expect((await sweepEvidenceCopies(store, { ...options, references: async () => true })).removed).toBe(1);
    for (let tick = 0; tick < 3; tick++) {
      store.defer(directory, 0);
      expect((await sweepAttemptTemps(store, options)).removed).toBe(0);
      expect(fs.existsSync(destination)).toBeFalse();
    }
    store.defer(directory, 0);
    expect((await sweepAttemptTemps(store, { ...options, references: async () => true })).removed).toBe(1);
    expect(fs.existsSync(destination)).toBeFalse();
  } finally { store.close(); }
});

test.each(["needs_decision", "pending"] as const)("a lane completed while an attempt was %s expires its scratch seven days after the close", async state => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority, recordingAttemptTempState } = await import("./attemptTempProduction");
  const now = Date.parse("2026-11-01T00:00:01Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-parked-")); roots.push(root);
  const directory = path.join(root, "llv-stage-parked"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "scratch of a parked attempt");
  const p = finishedLane(root, "2026-10-20T00:00:00Z");
  // Parking leaves completedAt unset, and the later close does not stamp it.
  p.runs = [{ stageId: "build", attempts: [{ n: 1, state, effectiveRole: p.stages[0]!.effectiveRole,
    launchId: "parked-launch", conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-19T00:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: "waiting for the operator" }] }];
  savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  try {
    store.register({ directory, pipelineId: p.id, launchId: "parked-launch", retainUntilClose: false, createdAt: now - 14 * 86400000 });
    expect(await authority(store.owner(directory)!, new RepositoryLinkInventory())).toMatchObject({ state: "expired", expiresAt: Date.parse("2026-10-27T00:00:00Z") });
    const report = await sweepAttemptTemps(store, { now: () => now, state: recordingAttemptTempState(store, authority), authority,
      scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
    expect(report).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse(); expect(store.has(directory)).toBeFalse();
  } finally { store.close(); }
});

test("a finished-lane root held by linked evidence records its retention end and leads the first page after it", async () => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority, recordingAttemptTempState } = await import("./attemptTempProduction");
  const closed = Date.parse("2026-10-30T00:00:00Z"), expiresAt = closed + 7 * 86400000;
  let now = closed + 86400000;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-linked-")); roots.push(root);
  const p = finishedLane(root, new Date(closed).toISOString());
  const open = buildPipeline({ id: "open-lane", task: "Open", project: "fixture", repoDir: root, stages: p.stages,
    srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00Z" });
  open.state = "running"; savePipelines([p, open]);
  const target = path.join(root, "outside.png"); fs.writeFileSync(target, "kept outside the root");
  const linked = path.join(root, "llv-stage-linked"); fs.mkdirSync(linked);
  fs.symlinkSync(target, path.join(linked, "frame.png"));
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
  const sweep = (maxRoots: number) => sweepAttemptTemps(store, { now: () => now, maxRoots, state: recordingAttemptTempState(store, authority), authority,
    scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true });
  try {
    store.register({ directory: linked, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: false, createdAt: closed - 86400000 });
    const held = await sweep(1);
    expect(held.outcomes).toEqual([expect.objectContaining({ directory: linked, disposition: "failed", reason: "linked attempt evidence" })]);
    expect(store.retentionExpiry(linked)).toBe(expiresAt);
    // Open-lane roots the round robin would visit before it.
    for (let n = 0; n < 6; n++) {
      const directory = path.join(root, `llv-stage-open-${n}`); fs.mkdirSync(directory);
      store.register({ directory, pipelineId: open.id, launchId: `open-${n}`, retainUntilClose: false, createdAt: closed - 10 * 86400000 });
    }
    now = expiresAt + 1;
    const report = await sweep(2);
    expect(report.outcomes[0]).toMatchObject({ directory: linked, disposition: "removed" });
    expect(fs.existsSync(linked)).toBeFalse(); expect(fs.readFileSync(target, "utf8")).toBe("kept outside the root");
  } finally { store.close(); }
});

test.each(["running", "paused", "needs_decision", "teardown", "merge", "attempt", "unconfirmed"])("unfinished lane %s never expires an old check hold", async kind => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempAuthority } = await import("./attemptTempProduction");
  const now = Date.parse("2026-11-01T00:00:00Z");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-unfinished-")); roots.push(root);
  const directory = path.join(root, "llv-stage-unfinished"); fs.mkdirSync(directory);
  const p = finishedLane(root, "2026-10-01T00:00:00Z");
  if (["running", "paused", "needs_decision"].includes(kind)) p.state = kind as typeof p.state;
  else if (kind === "teardown") {
    p.state = "closed";
    p.closeTeardown = { id: "teardown", phase: "pending", waitingForActivation: false, acknowledgeHosts: false, flow: null };
    p.closeReport = { status: "pending", pending: [], stopped: [], alreadyStopped: [], unconfirmed: [], reviewers: [], acknowledged: [], stillRunning: [], notes: [], worktree: null };
  }
  else if (kind === "merge") p.merge = { state: "queued", by: null, repository: "fixture/repository", prNumber: null,
    policyChangedAt: p.closedAt!, reviewedHead: "a".repeat(40), chain: [], updates: [], seenChecks: [], head: null, headSeenAt: null,
    lastChecks: null, readAt: null, nextReadAt: null, requestedAt: p.closedAt!, mergedHead: null, mergeCommit: null, method: null,
    mergedAt: null, attempts: 0, reason: null, blockedAt: null, updatedAt: p.closedAt! };
  else if (kind === "attempt") p.runs = [{ stageId: "build", attempts: [{ n: 1, state: "running", effectiveRole: p.stages[0].effectiveRole,
    launchId: "retention-launch", conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: p.closedAt!, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  else p.unconfirmedHosts = [{ conversationId: "fixture", agentPath: null, paneId: null,
    stageId: "build", attempt: 1, operationId: null, detail: "termination unconfirmed", at: p.closedAt! }];
  savePipelines([p]);
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  try {
    store.register({ directory, pipelineId: p.id, launchId: "retention-launch", retainUntilClose: true, createdAt: now - 30 * 86400000 });
    await holdFinishedRoot(directory);
    const authority: NonNullable<Parameters<typeof sweepAttemptTemps>[1]["authority"]> = (owner, inventory) => attemptTempAuthority(owner, inventory, () => now);
    expect((await sweepAttemptTemps(store, { now: () => now, state: async (owner, inventory) => (await authority(owner, inventory)).state,
      authority, scan: () => ({ ownNamespace: null, processes: [] }), references: async () => true })).removed).toBe(0);
    expect(recordedRootHeld(directory)).toBeTrue(); expect(fs.existsSync(directory)).toBeTrue();
  } finally { store.close(); }
});

const roots: string[] = [];
const stateRestores: Array<() => void> = [];
/** Points LLV_STATE_DIR inside a test's own root until the test ends, passed or failed. */
function isolateState(root: string): void {
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  stateRestores.push(() => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior; });
}
afterEach(() => { removeKeepMarkers(); for (const restore of stateRestores.splice(0).reverse()) restore(); savePipelines([]); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
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

const WORK_TICK = Date.parse("2026-11-24T17:53:00Z");
const oldestWorkExpiry = WORK_TICK - 624_407_000;
const emptyScan = () => ({ ownNamespace: null, processes: [] });
const workPorts = { scan: emptyScan, availableBytes: () => 412e9 };
const workMode = { NODE_ENV: "test", LLV_TEMP_SWEEP: "on" };

function workScratchFixture(total: number, overdue: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-work-shape-"));
  roots.push(root);
  isolateState(root);
  const store = new AttemptTempStore();
  const lane = finishedLane(root, new Date(WORK_TICK - 3 * 86400_000).toISOString());
  const closedLane = (id: string, at: number) => ({
    ...lane, ...pipelineIdentity(id, lane.task, lane.repoDir), id, closedAt: new Date(at).toISOString(),
  });
  const oldestLane = closedLane("oldest-lane", oldestWorkExpiry - ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS);
  const youngLane = closedLane("young-lane", WORK_TICK - 3_600_000);
  savePipelines([lane, oldestLane, youngLane]);
  const scratch = statePath("scratch");
  fs.mkdirSync(scratch);
  const directories = Array.from({ length: total }, (_, index) => {
    const directory = path.join(scratch, `llv-stage-${String(index).padStart(6, "0")}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "payload"), "fixture");
    const owner = index === overdue - 1 ? oldestLane : index < overdue ? lane : youngLane;
    store.register({ directory, pipelineId: owner.id, launchId: `fixture-launch-${index}`,
      retainUntilClose: true, createdAt: WORK_TICK - 10 * 86400_000 });
    store.measure(directory, index === overdue - 1 ? 12_288 : 1_950_000, WORK_TICK);
    store.retainRoot(directory, Date.parse(owner.closedAt!) + ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS);
    return directory;
  });
  return { store, directories };
}

test("work-shaped backlog visits beyond four and drains the 279 overdue registered roots", async () => {
  const { store, directories } = workScratchFixture(812, 279);
  let now = WORK_TICK;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const ticks: { ms: number; cpu: number; checked: number; removed: number }[] = [];
    const tick = async () => {
      const start = performance.now();
      const report = (await runAttemptTempSweep({ ...workPorts, references }, workMode))!;
      ticks.push({ ms: performance.now() - start, cpu: report.cleanup.sweepCpuSeconds, checked: report.checked, removed: report.removed });
      return report;
    };
    const first = await tick();
    // Keep the first-tick sample even when the fix is absent on the baseline.
    if (process.env.LLV_ATTEMPT_TEMP_WORK_BENCHMARK === "1")
      console.log(JSON.stringify({ fixture: "work-drain-first-tick", ...ticks[0] }));
    expect(first.checked).toBeGreaterThan(4);
    for (let n = 1; n < 20 && store.due(now, 1, true).length; n++) {
      now += 120_000; // Include the helper deadline and the scheduler delay.
      await tick();
    }
    if (process.env.LLV_ATTEMPT_TEMP_WORK_BENCHMARK === "1")
      console.log(JSON.stringify({ fixture: "work-drain", ticks: ticks.length, maxMs: Math.max(...ticks.map(tick => tick.ms)),
        cpuSeconds: ticks.reduce((sum, tick) => sum + tick.cpu, 0), removed: ticks.reduce((sum, tick) => sum + tick.removed, 0) }));
    expect(directories.slice(0, 279).filter(directory => fs.existsSync(directory))).toHaveLength(0);
    expect(directories.slice(279).every(directory => store.has(directory) && fs.existsSync(directory))).toBeTrue();
  } finally { clock.mockRestore(); store.close(); }
}, 300_000);

test("work-shaped zero-reclaim page reaches the root overdue by 624407 seconds", async () => {
  const { store, directories } = workScratchFixture(5, 5);
  const clock = spyOn(Date, "now").mockReturnValue(WORK_TICK);
  const [first, second, third, fourth, oldest] = directories;
  try {
    expect(store.oldestEligibleRootAgeSeconds(WORK_TICK)).toBe(624407);
    const report = await runAttemptTempSweep({ ...workPorts, references: async original => {
      if (original === first || original === second) throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
      return original !== third && original !== fourth;
    } }, workMode);
    expect(report).toMatchObject({ removed: 1, deferred: 2, held: 2 });
    expect(report?.outcomes.map(row => [row.directory, row.reasonCode])).toEqual([
      [oldest, "retired"], [first, "checkout_budget"], [second, "checkout_budget"],
      [third, "reference_observer_hold"], [fourth, "reference_observer_hold"],
    ]);
    expect(fs.existsSync(oldest!)).toBeFalse();
    expect(directories.slice(0, 4).every(directory => fs.existsSync(directory))).toBeTrue();
  } finally { clock.mockRestore(); store.close(); }
});

test("work-shaped unattributed copy report recognizes a legacy copy of registered scratch", async () => {
  const { store, directories: [original] } = workScratchFixture(1, 1);
  const clock = spyOn(Date, "now").mockReturnValue(WORK_TICK);
  try {
    const { identity } = store.owner(original!)!;
    const name = createHash("sha256").update(original!).update("\0").update(identity).digest("hex");
    const copy = statePath("evidence", "attempt-temp", name);
    fs.mkdirSync(copy, { recursive: true });
    writeEnvelope(path.join(copy, "manifest.json"), { original, identity });
    store.registerCopy({ destination: copy, pipelineId: null, launchId: "legacy", kind: "unattributed",
      createdAt: WORK_TICK - 10 * 86400_000, expiresAt: null, checkedAt: 0, bytes: 4096 });
    store.checkpointCopies("", true);
    const otherSource = path.join(path.dirname(original!), "llv-stage-unbound");
    const otherName = createHash("sha256").update(otherSource).update("\0").update(identity).digest("hex");
    const other = statePath("evidence", "attempt-temp", otherName);
    fs.mkdirSync(other);
    writeEnvelope(path.join(other, "manifest.json"), { original: otherSource, identity });
    store.registerCopy({ ...store.copy(copy)!, destination: other, bytes: 8192 });
    const tick = () => runAttemptTempSweep({ ...workPorts, references: async () => false }, workMode);
    const report = await tick();
    expect(report).toMatchObject({ held: 1, copies: { adopted: 0, sourceAttributed: 1, removed: 0,
      unattributed: { count: 1, bytes: 8192 } } });
    expect(fs.existsSync(copy)).toBeTrue();
    expect(store.has(original!)).toBeTrue();
    expect(store.copy(copy)?.kind).toBe("unattributed"); // Attribution gives the legacy copy no removal authority.
    expect(store.copyLedgerPage("", 10)).toContainEqual({ destination: copy, kind: "unattributed" });
    expect(store.dueCopies(WORK_TICK, 10)).toEqual([]);
    expect((await tick())?.copies).toMatchObject({ sourceAttributed: 0, unattributed: { count: 1, bytes: 8192 } });
    store.forgetCopy(copy);
    expect(store.unattributedCopies()).toEqual({ count: 1, bytes: 8192 });
  } finally { clock.mockRestore(); store.close(); }
});

test("attributing a legacy copy before its registered source retires survives the sealed cursor", async () => {
  const { store, directories: [original] } = workScratchFixture(1, 1);
  const clock = spyOn(Date, "now").mockReturnValue(WORK_TICK);
  try {
    const { identity } = store.owner(original!)!;
    const name = createHash("sha256").update(original!).update("\0").update(identity).digest("hex");
    const copy = statePath("evidence", "attempt-temp", name);
    fs.mkdirSync(copy, { recursive: true });
    writeEnvelope(path.join(copy, "manifest.json"), { original, identity });
    store.registerCopy({ destination: copy, pipelineId: null, launchId: "legacy", kind: "unattributed",
      createdAt: WORK_TICK - 10 * 86400_000, expiresAt: null, checkedAt: 0, bytes: 4096 });
    store.checkpointCopies("", true);
    store.checkpointCopySource("", true);
    const report = await runAttemptTempSweep({ ...workPorts, references }, workMode);
    expect(report).toMatchObject({ removed: 1, copies: { adopted: 0, removed: 0, sourceAttributed: 1,
      unattributed: { count: 0, bytes: 0 } } });
    expect(store.has(original!)).toBeFalse();
    expect(fs.existsSync(original!)).toBeFalse();
    expect(fs.existsSync(copy)).toBeTrue();
    expect(store.copy(copy)?.expiresAt).toBeNull();
    expect(store.dueCopies(WORK_TICK, 10)).toEqual([]);
  } finally { clock.mockRestore(); store.close(); }
});

test.each([false, true])("a verified legacy copy is bound before its source retires (discovery sealed=%s)", async sealed => {
  const { store, directories: [original] } = workScratchFixture(1, 1);
  const clock = spyOn(Date, "now").mockReturnValue(WORK_TICK);
  try {
    const { identity } = store.owner(original!)!;
    const name = createHash("sha256").update(original!).update("\0").update(identity).digest("hex");
    const copy = statePath("evidence", "attempt-temp", name);
    fs.mkdirSync(copy, { recursive: true });
    writeEnvelope(path.join(copy, "manifest.json"), { original, identity });
    store.checkpointCopies("", sealed);
    const report = await runAttemptTempSweep({ ...workPorts, references }, workMode);
    expect(report).toMatchObject({ removed: 1, copies: { removed: 0, unattributed: { count: 0, bytes: 0 } } });
    expect(fs.existsSync(original!)).toBeFalse();
    expect(fs.existsSync(copy)).toBeTrue();
    expect(store.copy(copy)).toMatchObject({ pipelineId: "oldest-lane", launchId: "fixture-launch-0", kind: "lane" });
  } finally { clock.mockRestore(); store.close(); }
});

test("expensive expired proofs keep their next retry across fresh helpers", async () => {
  const { store, directories: [directory] } = workScratchFixture(1, 1);
  const tick = async (at: number, fail: boolean) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"),
      "--production-report", String(at), "--fixture-container-inventory",
      ...(fail ? [`--checkout-budget-root=${path.basename(directory!)}`] : [])],
    { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, errors).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  try {
    const retryAt = WORK_TICK + 15 * 60_000;
    expect(await tick(WORK_TICK, true)).toMatchObject({ checked: 1, deferred: 1, removed: 0,
      outcomes: [expect.objectContaining({ reasonCode: "checkout_budget", retryAt })] });
    expect(store.owner(directory!)?.checkedAt).toBe(retryAt);
    expect(store.allocationDue(WORK_TICK + 60_000)).toEqual([]);
    expect(await tick(WORK_TICK + 60_000, false)).toMatchObject({ checked: 0, removed: 0 });
    expect(fs.readFileSync(path.join(directory!, "payload"), "utf8")).toBe("fixture");
    expect(await tick(retryAt, false)).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(fs.existsSync(directory!)).toBeFalse();
  } finally { store.close(); }
}, 15_000);

test("a failed full proof under cap pressure waits between minute ticks and retries when due", async () => {
  const { store, directories: [directory] } = workScratchFixture(1, 1);
  const previousCap = process.env.LLV_ATTEMPT_TEMP_CAP_BYTES;
  process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = "1";
  const tick = async (at: number, fail: boolean) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"),
      "--production-report", String(at), "--fixture-container-inventory",
      ...(fail ? [`--checkout-budget-root=${path.basename(directory!)}`] : [])],
    { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, errors).toBe(0);
    return JSON.parse(output.trim().split("\n").at(-1)!);
  };
  try {
    const retryAt = WORK_TICK + 15 * 60_000;
    const failed = await tick(WORK_TICK, true);
    expect(failed).toMatchObject({ checked: 1, deferred: 1, removed: 0,
      outcomes: [expect.objectContaining({ reasonCode: "checkout_budget", retryAt })] });
    expect(store.owner(directory!)?.checkedAt).toBe(retryAt);
    expect(await tick(WORK_TICK + 60_000, false)).toMatchObject({ checked: 0, removed: 0 });
    expect(fs.readFileSync(path.join(directory!, "payload"), "utf8")).toBe("fixture");
    expect(await tick(retryAt, false)).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(fs.existsSync(directory!)).toBeFalse();
  } finally {
    if (previousCap === undefined) delete process.env.LLV_ATTEMPT_TEMP_CAP_BYTES;
    else process.env.LLV_ATTEMPT_TEMP_CAP_BYTES = previousCap;
    store.close();
  }
}, 15_000);

test("a process first seen by retirement scan reports its live reference", async () => {
  const { store, directories: [directory] } = workScratchFixture(1, 1);
  const clock = spyOn(Date, "now").mockReturnValue(WORK_TICK);
  let scans = 0;
  try {
    const report = await runAttemptTempSweep({ ...workPorts, references,
      scan: () => ++scans < 4 ? emptyScan() : ({ ownNamespace: null, processes: [
        { pid: 41, namespace: null, stamped: false, paths: [directory!] },
      ] }),
    }, workMode);
    expect(report).toMatchObject({ checked: 1, removed: 0, outcomes: [expect.objectContaining({
      disposition: "live", reasonCode: "process_reference",
    })] });
    expect(fs.readFileSync(path.join(directory!, "payload"), "utf8")).toBe("fixture");
  } finally { clock.mockRestore(); store.close(); }
});

test.skipIf(process.env.LLV_ATTEMPT_TEMP_WORK_BENCHMARK !== "1")("work-shaped measurement over one hour of minute ticks", async () => {
  const { store, directories } = workScratchFixture(812, 4);
  let now = WORK_TICK;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const samples: { ms: number; cpu: number; checked: number; deferred: number; held: number }[] = [];
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    maxGap = Math.max(maxGap, at - last);
    last = at;
  }, 5);
  try {
    const budgetRoots = new Set(directories.slice(0, 2));
    for (const directory of budgetRoots) {
      for (let n = 0; n < 384; n++) fs.mkdirSync(path.join(directory, String(n).padStart(4, "0")));
    }
    for (let n = 0; n < 692; n++) store.registerCopy({
      destination: statePath("evidence", "attempt-temp", n.toString(16).padStart(64, "0")), pipelineId: null, launchId: "legacy",
      kind: "unattributed", createdAt: now, expiresAt: null, checkedAt: now, bytes: 67_052_024,
    });
    store.checkpointCopies("", true);
    last = performance.now();
    for (let n = 0; n < 60; n++) {
      now = WORK_TICK + 60_000 * n;
      const start = performance.now();
      const report = (await runAttemptTempSweep({ ...workPorts, references: async original => {
        if (budgetRoots.has(original)) throw new AttemptTempBudgetDeferred("checkout link inventory exceeded its time budget");
        return false;
      } }, workMode))!;
      samples.push({ ms: performance.now() - start, cpu: report.cleanup.sweepCpuSeconds, checked: report.checked,
        deferred: report.deferred, held: report.held });
      expect(report.removed).toBe(0);
      expect(report.reclaimedBytes).toBe(0);
      await Bun.sleep(0);
    }
    const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
    console.log(JSON.stringify({ fixture: "work-no-reclaim", ticks: samples.length, medianMs: times[29],
      p95Ms: times[56], maxMs: times[59], maxHeartbeatGapMs: maxGap,
      cpuSeconds: samples.reduce((sum, sample) => sum + sample.cpu, 0),
      checked: samples.reduce((sum, sample) => sum + sample.checked, 0),
      deferred: samples.reduce((sum, sample) => sum + sample.deferred, 0), first: samples[0] }));
  } finally { clearInterval(timer); clock.mockRestore(); store.close(); }
}, 60_000);

test.skipIf(process.env.LLV_ATTEMPT_TEMP_WORK_BENCHMARK !== "1")("work-shaped Viewer-side heartbeat during an overdue page", async () => {
  const { store } = workScratchFixture(812, 279);
  const env = { ...process.env };
  const config = statePath("work-heartbeat.json");
  fs.writeFileSync(config, JSON.stringify({ now: WORK_TICK, freeBytes: 412e9, realClock: true, measureCost: 0 }));
  process.env.LLV_PRESSURE_FIXTURE = config;
  process.env.LLV_TEMP_SWEEP = "on";
  let last = performance.now(), maxGap = 0, beats = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    maxGap = Math.max(maxGap, at - last);
    last = at;
    beats++;
  }, 5);
  try {
    const start = performance.now();
    const report = await realParentPass(true);
    expect(report.errors).toBe(0);
    expect(report.checked).toBeGreaterThanOrEqual(4);
    expect(beats).toBeGreaterThan(0);
    console.log(JSON.stringify({ fixture: "work-viewer-heartbeat", ms: performance.now() - start,
      maxHeartbeatGapMs: maxGap, beats, cpuSeconds: report.cleanup.sweepCpuSeconds, checked: report.checked, removed: report.removed }));
  } finally {
    clearInterval(timer);
    store.close();
    restoreEnvironment(env);
  }
}, 45_000);

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

test("the real sweep keeps open-lane roots without reading checkout inventories", async () => {
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
    expect(report).toMatchObject({ checked: 8, removed: 0, liveHeld: 8, errors: 0 });
    expect([...inventories].reduce((sum, inventory) => sum + inventory.walks.length, 0)).toBe(0);
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
  pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "late-link-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: "2026-10-22T12:01:00Z", input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
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

test.each([0, 1, 2, 3, 4])("a restored checkout holds scratch across consumer await boundary %i (zero is the removal control)", async boundary => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-restored-checkout-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "restored-lane", task: "Checkout restoration", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "restored-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: "2026-10-22T12:01:00Z", input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
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
  let observations = 0, restored = false;
  let inventory: InstanceType<typeof RepositoryLinkInventory>;
  try {
    const report = await sweepAttemptTemps(store, { now: () => 2, maxRoots: 1, capBytes: 0,
      state: (owner, current) => { inventory = current; return attemptTempState(owner, current); },
      references: async (original, current, scan) => {
        const clear = await attemptReferencesClear(original, current, scan, async () => true, inventory!);
        if (++observations === boundary) {
          fs.renameSync(repository, repository + "-previous");
          fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
          fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
          restored = true;
        }
        return clear;
      },
      scan: () => ({ ownNamespace: null, processes: [{ pid: 123, namespace: null, stamped: false, paths: [repository] }] }) });
    if (boundary === 0) {
      expect(report).toMatchObject({ removed: 1, errors: 0 });
      expect(observations).toBeGreaterThanOrEqual(4);
      expect(exists(directory)).toBeFalse();
    } else {
      expect(restored).toBeTrue();
      expect(report.removed).toBe(0);
      // Absence now refuses the inventory. The earlier presence mismatch
      // still returns unknown; both paths must preserve the same payload.
      expect(report.held + report.errors).toBe(1);
      if (report.errors) expect(report.outcomes[0]!.reason).toContain("ENOENT");
      expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("retained payload");
      expect(fs.readlinkSync(path.join(repository, "dependency"))).toBe(directory);
    }
  } finally { store.close(); }
});

test.each(["first launch", "rehost"])("production schedules scratch on attempt completion, cancels on reopen and retires after the next completion (%s)", async generation => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-production-")); roots.push(root);
  isolateState(root);
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const start = Date.parse("2026-10-22T12:00:00Z");
  let now = start;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "temp-lane", task: "Temp lifetime", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.cursor = null;
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: pipeline.worktreeDir!, transport: "structured" });
  if (begun.kind !== "created") throw new Error("fixture receipt missing");
  const { conversationId } = begun.receipt;
  registry.rememberMembership(conversationId, { kind: "pipeline", containerId: pipeline.id, role: "builder",
    slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
  const attempt: PipelineStageAttempt = { n: 1, state: "running", launchId: "temp-launch", effectiveRole: role,
    conversationId, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null,
    output: null, verdict: null, error: null };
  pipeline.runs = [{ stageId: "build", attempts: [attempt] }];
  fs.mkdirSync(pipeline.worktreeDir!, { recursive: true });
  savePipelines([pipeline]);
  const newHost = generation === "rehost" ? "replacement-host-id" : attempt.launchId!;
  const stageReceipt = stageGitReceiptDirectory(attempt.launchId!);
  expect(tempOwnerForConversation(registry, conversationId, newHost, stageGitReceiptDirectory("another-attempt")).launchId).toBe(newHost);
  const access = await materializeOwnedStructuredHostAccess({ readOnly: false, sandbox: "full" }, { ...process.env, HOME: root }, null,
    () => tempOwnerForConversation(registry, conversationId, newHost, stageReceipt));
  const sandbox = access.env.LLV_AGENT_SANDBOX_ROOT;
  fs.writeFileSync(path.join(access.env.TMPDIR!, "review-export"), "settled scratch");
  const directories = [access.scratchDirectory!, sandbox!];
  let liveScratch = false;
  const scan = () => ({ ownNamespace: null, processes: liveScratch
    ? [{ pid: 41, namespace: null, stamped: false, paths: [access.scratchDirectory!] }] : [] });
  const tick = (mode = "on") => runAttemptTempSweep({ scan, references }, { NODE_ENV: "test", LLV_TEMP_SWEEP: mode });
  const store = new AttemptTempStore();
  const deadlines = () => directories.map(directory => store.retentionExpiry(directory));
  const finish = () => {
    attempt.state = "passed"; attempt.completedAt = new Date(now).toISOString();
    attempt.output = "done"; attempt.verdict = { status: "pass" };
    savePipelines([pipeline]);
    return now + ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS;
  };
  try {
    expect(directories.map(directory => store.owner(directory)?.launchId ?? null)).toEqual([attempt.launchId, attempt.launchId]);
    await tick(); await tick(); await tick(); // Complete the initial audit.
    expect(deadlines()).toEqual([null, null]);
    now += 60_000;
    const first = finish();
    const scheduled = await tick();
    expect(deadlines()).toEqual([first, first]);
    expect(scheduled).toMatchObject({ checked: 0, inventoryWalks: 0, backfill: { checked: 0 }, recovery: { entries: 0 } });
    expect(directories.map(directory => store.owner(directory)?.released)).toEqual([0, 0]);
    pipeline.cursor = { stageId: "build", state: "committing", input: null, activatedBy: null };
    savePipelines([pipeline]);
    expect((await tick())?.checked).toBe(0);
    expect(deadlines()).toEqual([null, null]);
    pipeline.cursor = null;
    attempt.state = "running"; attempt.completedAt = null; attempt.verdict = null; savePipelines([pipeline]);
    expect((await tick())?.checked).toBe(0);
    expect(deadlines()).toEqual([null, null]);
    now = first + 60_000;
    expect((await tick())?.removed).toBe(0);
    expect(fs.readFileSync(path.join(access.env.TMPDIR!, "review-export"), "utf8")).toBe("settled scratch");
    const second = finish();
    await tick();
    expect(deadlines()).toEqual([second, second]);
    now = second - 1;
    expect((await tick())?.checked).toBe(0);
    now = second;
    const checkout = pipeline.worktreeDir!, saved = checkout + "-saved";
    for (const [index, directory] of directories.entries()) fs.symlinkSync(directory, path.join(checkout, `dependency-${index}`), "dir");
    expect(await tick()).toMatchObject({ checked: 2, removed: 0, liveHeld: 2 });
    fs.renameSync(checkout, saved);
    now += 30 * 60_000;
    expect(await tick()).toMatchObject({ checked: 2, removed: 0, operatorHeld: 2 });
    for (const index of directories.keys()) fs.unlinkSync(path.join(saved, `dependency-${index}`));
    fs.renameSync(saved, checkout);
    now += 30 * 60_000;
    const preview = await tick("dry-run");
    expect(preview).toMatchObject({ removed: 2, reclaimedBytes: 0, cleanup: { reclaimedBytesLastHour: 0 } });
    expect(directories.every(directory => fs.existsSync(directory))).toBeTrue();
    now += 60_000;
    liveScratch = true;
    expect(await tick()).toMatchObject({ checked: 2, removed: 1, liveHeld: 1, errors: 0 });
    expect(fs.existsSync(access.scratchDirectory!)).toBeTrue();
    liveScratch = false;
    now += 30 * 60_000;
    const retired = await tick();
    expect(retired).toMatchObject({ checked: 1, removed: 1, errors: 0 });
    expect(directories.some(directory => fs.existsSync(directory) || store.has(directory))).toBeFalse();
  } finally { store.close(); clock.mockRestore(); }
});

test("scheduled scratch adoption recovers a recorded attempt and holds an ambiguous sibling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-scratch-custody-")); roots.push(root);
  isolateState(root);
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const now = Date.parse("2035-01-15T00:00:00Z"), clock = spyOn(Date, "now").mockReturnValue(now);
  const completedAt = "2035-01-06T00:00:00Z", launchId = "legacy-scratch-launch";
  const lane = finishedLane(root, completedAt);
  lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId,
    effectiveRole: lane.stages[0]!.effectiveRole, conversationId: "fixture", sessionId: null, agentPath: null,
    paneId: null, flowId: null, startedAt: completedAt, completedAt, input: null,
    activatedBy: null, output: "finished", verdict: { status: "pass" }, error: null }] }];
  savePipelines([lane]);
  const known = statePath("scratch", "llv-stage-Stale1"), unknown = statePath("scratch", "llv-stage-Stale2");
  for (const directory of [known, unknown]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "data"), "scratch");
  }
  const store = new AttemptTempStore();
  try {
    store.adopt(now - 1); // Simulate the old production ledger's ownerless rows.
    expect(store.owner(known)?.launchId).toBe("adopted");
    await holdFinishedRoot(known, lane.id, "", [], launchId);
    const report = await runAttemptTempSweep({ references, scan: () => ({ ownNamespace: null, processes: [] }) },
      { NODE_ENV: "test", LLV_TEMP_SWEEP: "on" });
    expect(report).toMatchObject({ adopted: 1, removed: 1, errors: 0 });
    expect(store.has(known)).toBeFalse();
    expect(fs.existsSync(known)).toBeFalse();
    expect(store.owner(unknown)).toMatchObject({ pipelineId: null, launchId: "adopted" });
    expect(fs.readFileSync(path.join(unknown, "data"), "utf8")).toBe("scratch");
  } finally { store.close(); clock.mockRestore(); }
});

test("a failed configuration marker rolls back registration of both attempt roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-register-failure-")); roots.push(root);
  isolateState(root);
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const store = new AttemptTempStore(), write = fs.writeFileSync, directories: string[] = [];
  const marker = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (typeof file === "string" && path.basename(file) === ".delegatus-attempt-owner") {
      directories.push(path.dirname(file));
      if (path.basename(path.dirname(file)).startsWith("llv-stage-config-")) throw new Error("fixture configuration marker refused");
    }
    return write(file, data, options);
  });
  try {
    expect(() => materializeStructuredHostAccess({ sandbox: "full", readOnly: false }, { ...process.env, HOME: root }, null,
      undefined, { pipelineId: "fixture-lane", launchId: "fixture-launch", retainUntilClose: false })).toThrow("fixture configuration marker refused");
    expect(directories).toHaveLength(2);
    expect(directories.map(directory => [store.has(directory), fs.existsSync(directory)])).toEqual([[false, false], [false, false]]);
  } finally { marker.mockRestore(); store.close(); }
});

test.skipIf(process.platform !== "linux").each(["live child", "mount", "linked evidence", "broken git pointer", "unknown checkout", "swap", "last handoff swap"] as const)(
  "an expired production root keeps its data when protected by %s", async protection => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-protection-")); roots.push(root);
    isolateState(root);
    const at = Date.parse("2035-01-15T00:00:00Z");
    const lane = finishedLane(root, "2035-01-13T00:00:00Z"); savePipelines([lane]);
    const directory = statePath("scratch", "llv-stage-parent");
    fs.mkdirSync(path.join(directory, "checkout"), { recursive: true });
    const payload = path.join(directory, "frame.png"); fs.writeFileSync(payload, "protected data");
    const { AttemptTempStore } = await import("./attemptTempRetention");
    const { runAttemptTempSweep } = await import("./attemptTempProduction");
    const store = new AttemptTempStore();
    store.register({ directory, pipelineId: lane.id, launchId: "prior-launch", retainUntilClose: true, createdAt: at - 3 * 86400000 });
    store.close();
    const clock = spyOn(Date, "now").mockReturnValue(at);
    const restore: Array<() => void> = [];
    let scan = (): ProcessScan => ({ ownNamespace: null, processes: [] });
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
    let preserved = payload, swapped = false;
    try {
      if (protection === "live child") {
        child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--hold"],
          { cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        const reader = child.stdout.getReader();
        try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
        finally { reader.releaseLock(); }
        const proc = path.join(root, "proc"); fs.mkdirSync(proc);
        fs.symlinkSync("/proc/self", path.join(proc, "self"));
        fs.symlinkSync(`/proc/${child.pid}`, path.join(proc, String(child.pid)));
        scan = () => scanProcesses(proc, [directory]);
        expect(scan().processes).toHaveLength(1);
      } else if (protection === "mount") {
        const read = fs.readFileSync.bind(fs);
        const mounted = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
          const value = read(file, options as BufferEncoding);
          return file === "/proc/self/mountinfo" ? `${value}\n431 24 0:1 / ${directory}/checkout rw - tmpfs tmpfs rw\n` : value;
        }) as typeof fs.readFileSync);
        restore.push(() => mounted.mockRestore());
      } else if (protection === "linked evidence") nameInReport(payload);
      else if (protection === "broken git pointer") fs.writeFileSync(path.join(directory, "checkout", ".git"), "gitdir: missing\n");
      else if (protection === "unknown checkout") {
        fs.mkdirSync(path.join(directory, "checkout", ".git"));
        fs.writeFileSync(path.join(directory, "checkout", ".git", "config"), "local-only repository data");
      }
      else if (protection === "last handoff swap") {
        const remove = attemptRemoval.removeTreeWithinAttemptBudget;
        const replace = spyOn(attemptRemoval, "removeTreeWithinAttemptBudget").mockImplementation(async (target, started, ...args) =>
          remove(target, () => {
            started();
            const claim = fs.readdirSync(path.dirname(directory)).map(name => path.join(path.dirname(directory), name))
              .find(name => path.basename(name).startsWith(".delegatus-trash-claim-"));
            if (claim && !swapped) {
              const saved = path.join(root, "claimed-original"); fs.renameSync(claim, saved);
              fs.mkdirSync(claim); fs.writeFileSync(path.join(claim, "replacement"), "new owner");
              preserved = path.join(saved, "frame.png"); swapped = true;
            }
          }, ...args));
        restore.push(() => replace.mockRestore());
      } else {
        const rename = fs.renameSync.bind(fs);
        const replace = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          rename(from, to);
          if (from !== directory || !path.basename(String(to)).startsWith(".delegatus-trash-")) return;
          const saved = path.join(root, "original"); rename(to, saved);
          fs.mkdirSync(to); fs.writeFileSync(path.join(String(to), "replacement"), "new owner");
          preserved = path.join(saved, "frame.png"); swapped = true;
        });
        restore.push(() => replace.mockRestore());
      }
      const report = await runAttemptTempSweep({
        scan, ...(protection === "live child" ? {} : { references }),
      }, { NODE_ENV: "test", LLV_TEMP_SWEEP: "on" });
      expect(report).toMatchObject({ checked: 1, removed: 0, reclaimedBytes: 0 });
      const reasons = {
        "live child": "process_reference", mount: "mount_boundary", "linked evidence": "linked_evidence_hold",
        "broken git pointer": "git_boundary", "unknown checkout": "git_boundary",
      } as const;
      if (protection in reasons) expect(report?.outcomes[0]?.reasonCode).toBe(reasons[protection as keyof typeof reasons]);
      expect(fs.readFileSync(preserved, "utf8")).toBe("protected data");
      if (protection === "swap" || protection === "last handoff swap") {
        expect(swapped).toBeTrue();
        const journal = JSON.parse(fs.readFileSync(attemptTempJournalPath(directory), "utf8"));
        expect(fs.readFileSync(path.join(journal.trash, "replacement"), "utf8")).toBe("new owner");
        expect(fs.readFileSync(preserved, "utf8")).toBe("protected data");
      }
    } finally {
      for (const stop of restore.reverse()) stop();
      clock.mockRestore();
      if (child) { child.stdin.end(); await child.exited; }
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

test.each(["due", "upcoming"] as const)("the persisted %s forecast clears after a pin across repeats and a process restart", async timing => {
  const { AttemptTempStore } = await import("./attemptTempRetention");
  const { runAttemptTempSweep } = await import("./attemptTempProduction");
  const { digest } = await import("@/lib/recordedChecks/wire");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-report-pin-")); roots.push(root);
  const priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const now = Date.parse("2026-11-01T00:00:01Z"), clock = spyOn(Date, "now").mockReturnValue(now);
  const pipeline = finishedLane(root, timing === "due" ? "2026-10-25T00:00:00Z" : "2026-10-31T00:00:00Z");
  const expiresAt = Date.parse(pipeline.closedAt!) + 7 * 86400000;
  savePipelines([pipeline]);
  const destination = statePath("evidence", "attempt-temp", digest("report-pin"));
  fs.mkdirSync(destination, { recursive: true });
  plantKeepMarker(path.join(destination, ".delegatus-keep"));
  const store = new AttemptTempStore();
  store.registerCopy({ destination, pipelineId: pipeline.id, launchId: "copy", kind: "lane",
    createdAt: 1, expiresAt, checkedAt: 0, bytes: 4096 });
  store.close();
  const file = statePath("attempt-temp-report.json");
  fs.writeFileSync(file, JSON.stringify({ condition: { mode: "on", overCap: false, failing: false },
    retention: { periodDays: 7, dueBytes: timing === "due" ? 4096 : 0,
      upcomingBytes: timing === "upcoming" ? 4096 : 0, until: expiresAt, partial: false } }));
  try {
    for (let n = 0; n < 2; n++) {
      const report = await runAttemptTempSweep({ scan: () => ({ ownNamespace: null, processes: [] }) },
        { ...process.env, LLV_TEMP_SWEEP: "on" });
      expect(report!.retention).toMatchObject({ dueBytes: 0, upcomingBytes: 0, until: null });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).retention).toEqual(report!.retention);
    }
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--production-report", String(now + 60001)],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    const report = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).retention).toEqual(report.retention);
    expect(fs.existsSync(path.join(destination, ".delegatus-keep"))).toBeTrue();
  } finally { clock.mockRestore(); process.env.LLV_STATE_DIR = priorState; }
});

test("quiet minute ticks refresh CPU metrics without repeating journal lines", async () => {
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
    expect(JSON.parse(fs.readFileSync(report, "utf8")).cleanup).toMatchObject({
      sweepCpuSeconds: expect.any(Number), sweepCpuSecondsLastHour: expect.any(Number),
    });
    const held = path.join(root, "llv-stage-held"); fs.mkdirSync(held); fs.writeFileSync(path.join(held, "data"), Buffer.alloc(8192));
    const store = new AttemptTempStore();
    try {
      store.register({ directory: held, pipelineId: "missing-lane", launchId: "held", retainUntilClose: false, createdAt: Date.now() });
      store.measure(held, 8192);
    }
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
    expect(JSON.parse(fs.readFileSync(report, "utf8")).cleanup.sweepCpuSeconds).toBeGreaterThanOrEqual(0);
    expect(written).toContain("sweepCpuSecondsLastHour");
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
  fs.mkdirSync(pipeline.worktreeDir!, { recursive: true });
  savePipelines([pipeline]);
  const { attemptTempState } = await import("./attemptTempProduction");
  const owner = { directory: path.join(root, "llv-stage-fixture"), pipelineId: pipeline.id, launchId: "state-launch", retainUntilClose: false, createdAt: 1 };
  expect(await attemptTempState(owner)).toBe("live");
  pipeline.runs[0]!.attempts[0]!.retiredLaunches = [{ launchId: "prior-launch", conversationId: null,
    error: "startup retired", retiredAt: "2026-10-22T12:01:00Z" }]; savePipelines([pipeline]);
  const retiredAt = Date.parse("2026-10-22T12:01:00Z"), dueAt = retiredAt + ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS;
  expect(await attemptScratchAuthority({ ...owner, launchId: "prior-launch" }, undefined, () => dueAt - 1)).toMatchObject({ state: "closed", expiresAt: dueAt });
  expect(await attemptScratchAuthority({ ...owner, launchId: "prior-launch" }, undefined, () => dueAt)).toMatchObject({ state: "expired", expiresAt: dueAt });
  expect(await attemptTempState({ ...owner, launchId: "prior-launch", retainUntilClose: true })).toBe("live");
  expect(await attemptTempState({ ...owner, launchId: "prior-launch", createdAt: retiredAt + 1 })).toBe("live");
  expect(await attemptTempState({ ...owner, launchId: "unrecorded-launch" })).toBe("unknown");
  fs.mkdirSync(path.join(pipeline.worktreeDir!, "nested"), { recursive: true });
  fs.symlinkSync(path.join(owner.directory, "packages"), path.join(pipeline.worktreeDir!, "nested/node_modules"), "dir");
  expect(await attemptTempState(owner)).toBe("live");
  pipeline.stages[0]!.effectiveRole = { ...role, access: "read-only" };
  pipeline.stages[0]!.outputs = ["evidence"]; savePipelines([pipeline]);
  expect(await attemptTempState(owner)).toBe("live");
  expect(await attemptTempState({ ...owner, directory: path.join(root, "llv-stage-config-fixture") })).toBe("live");
  for (const terminal of ["completed", "closed"] as const) {
    if (state !== "committing") pipeline.runs[0]!.attempts[0]!.completedAt = "2026-10-22T12:01:00Z";
    pipeline.state = terminal; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z"; savePipelines([pipeline]);
    const { attemptTempAuthority } = await import("./attemptTempProduction");
    expect((await attemptTempAuthority(owner, undefined, () => Date.parse("2026-10-22T13:00:00Z"))).state).toBe(state === "committing" ? "live" : "closed");
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


test.each(["closed", "completed"] as const)("an absent open-lane checkout holds scratch until the lane is %s and its consumer exits", async terminal => {
  const { AttemptTempStore, sweepAttemptTemps } = await import("./attemptTempRetention");
  const { attemptTempState } = await import("./attemptTempProduction");
  const { RepositoryLinkInventory } = await import("./attemptTempFilesystem");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-absent-lane-")); roots.push(root);
  const role = { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } as const;
  const pipeline = buildPipeline({ id: "absent-lane", task: "Checkout lifetime", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null, effectiveRole: role }],
    srcPath: null, srcConversationId: null, now: "2026-10-22T12:00:00Z" });
  pipeline.state = "running";
  pipeline.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId: "absent-launch", effectiveRole: role,
    conversationId: "fixture", sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: "2026-10-22T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] }];
  const repository = pipeline.worktreeDir!; roots.push(repository);
  savePipelines([pipeline]);
  const directory = path.join(root, "llv-stage-absent"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "keep");
  const store = new AttemptTempStore(path.join(root, "owners.sqlite"));
  store.register({ directory, pipelineId: pipeline.id, launchId: "absent-launch", retainUntilClose: false, createdAt: 1 });
  let now = 1000;
  const processes: ProcessScan["processes"] = [];
  const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, state: attemptTempState, references,
    scan: () => ({ ownNamespace: null, processes }) });
  try {
    const owner = store.owner(directory)!;
    expect(await attemptTempState(owner)).toBe("live");
    expect(await sweep()).toMatchObject({ removed: 0, held: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    // Closing a lane releases its own missing-checkout hold. A separate live
    // consumer still owns its link even after the producer lane closes.
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
    processes.push({ pid: 42, namespace: null, stamped: false, paths: [repository] });
    now += 60001;
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    pipeline.runs[0]!.attempts[0]!.completedAt = "2026-10-22T12:01:00Z";
    pipeline.state = terminal; pipeline.cursor = null; pipeline.closedAt = "2026-10-22T12:02:00Z"; savePipelines([pipeline]);
    now += 60001;
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    // The next sweep owns a fresh inventory. No vanished consumer entry or
    // missing terminal checkout survives as a permanent negative-cache hold.
    processes.length = 0; fs.rmSync(repository, { recursive: true });
    const { attemptTempAuthority } = await import("./attemptTempProduction");
    expect((await attemptTempAuthority(owner, new RepositoryLinkInventory(), () => Date.parse("2026-10-22T13:00:00Z"))).state).toBe("closed");
    now += 60001;
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
});
