import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { writeEnvelope } from "@/lib/recordedChecks/wire";
import type { AgentRegistry } from "@/lib/agent/registry";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { discoverTemporaryData, finishedAgent, temporaryDataAuthority, type TemporaryRegistry } from "./temporaryDataProduction";
import { sweepTemporaryData, TEMPORARY_DATA_RETENTION_MS as WEEK } from "./temporaryDataRetention";
import { AttemptTempStore, type EvidenceCopy } from "./attemptTempRetention";
import { preserveAttemptEvidence } from "./attemptTempEvidence";
import { sweepEvidenceCopies } from "./attemptEvidenceCopies";
import { savePipelines } from "@/lib/pipelines/store";
import { finishedLane, nameInReport } from "./attemptTempRetention.testSupport";

const NOW = Date.UTC(2035, 0, 15), roots: string[] = [], stores: TemporaryDataStore[] = [];
type Facts = ReturnType<AgentRegistry["temporaryDataFacts"]>;
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "temporary-production-")); roots.push(root);
  const evidence = path.join(root, "evidence"), journals = path.join(root, "journals"), transcript = path.join(root, "transcript.jsonl");
  fs.mkdirSync(evidence); fs.mkdirSync(journals); fs.writeFileSync(transcript, "transcript");
  const store = new TemporaryDataStore(path.join(root, "retention.sqlite")); stores.push(store);
  let facts = { receipt: { launchId: "agent-fixed", state: "completed", key: { engine: "codex", sessionId: "session-fixed" } },
    entry: { key: { engine: "codex", sessionId: "session-fixed" }, status: "dead", artifactPath: transcript, updatedAt: new Date(NOW - WEEK - 1).toISOString(), claimOwner: null, pendingAction: null }, pipelines: [] } as unknown as Facts;
  const registry: TemporaryRegistry = {
    temporaryDataFacts: input => input.key && input.key.engine !== "codex" ? { receipt: null, entry: null, pipelines: [] } : structuredClone(facts),
    temporaryDataReceiptKeys: after => after ? [] : ["agent-fixed"],
    spawnReceipt: () => facts.receipt,
    spawnReceiptForHost: () => facts.receipt,
  };
  const candidate = (directory: string, kind: TemporaryDataCandidate["kind"], owner = "agent-fixed") => {
    const stat = fs.lstatSync(directory);
    const row: TemporaryDataCandidate = { directory, scope: kind === "journal" ? journals : evidence, kind, owner,
      identity: `${stat.dev}:${stat.ino}`, adoptedAt: NOW - WEEK - 1, checkedAt: 0, bytes: 0, reason: "fixture" };
    store.register(row); return row;
  };
  const source = { owner: () => null, copy: () => null };
  const sweep = () => sweepTemporaryData(store, { now: () => NOW, mounts: () => [], claim: async () => () => {},
    references: async () => true, authority: async row => temporaryDataAuthority(row, registry, source, () => NOW) });
  return { root, evidence, journals, transcript, store, registry, candidate, source, sweep, facts: () => facts, setFacts: (next: Facts) => { facts = next; } };
}

test.each(["expired", "live", "resuming", "missing-transcript", "young"])("a %s host journal respects session and transcript fences", async state => {
  const f = fixture(), file = path.join(f.journals, "session-fixed.jsonl"); fs.writeFileSync(file, '{"kind":"session-status","status":"dead","seq":1}\n');
  fs.utimesSync(file, new Date(NOW - WEEK - 1), new Date(NOW - WEEK - 1));
  if (state === "live") f.setFacts({ ...f.facts(), entry: { ...f.facts().entry!, status: "live" } });
  if (state === "resuming") f.setFacts({ ...f.facts(), receipt: { ...f.facts().receipt!, state: "starting" } });
  if (state === "missing-transcript") fs.unlinkSync(f.transcript);
  if (state === "young") fs.utimesSync(file, new Date(NOW - WEEK + 1), new Date(NOW - WEEK + 1));
  f.candidate(file, "journal", "session-fixed");
  const report = await f.sweep();
  expect(report.removed).toBe(state === "expired" ? 1 : 0); expect(fs.existsSync(file)).toBe(state !== "expired");
});

test.each(["dead", "live"] as const)("discovery and a restarted ledger retain journal ownership for a %s host", async status => {
  const f = fixture(), file = path.join(f.journals, "session-fixed.jsonl");
  fs.writeFileSync(file, "retained host events\n");
  fs.utimesSync(file, new Date(NOW - WEEK - 1), new Date(NOW - WEEK - 1));
  f.setFacts({ ...f.facts(), entry: { ...f.facts().entry!, status } });
  for (let pass = 0; pass < 3; pass++) discoverTemporaryData(f.store, f.registry, () => NOW, 1000, () => 0, f);
  expect(f.store.get(file)?.kind).toBe("journal");
  const filename = f.store.filename;
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const restarted = new TemporaryDataStore(filename); stores.push(restarted);
  const report = await sweepTemporaryData(restarted, { now: () => NOW, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async row => temporaryDataAuthority(row, f.registry, f.source, () => NOW) });
  expect(report.removed).toBe(status === "dead" ? 1 : 0);
  expect(fs.existsSync(file)).toBe(status !== "dead");
});

test.each(["running", "paused"])("a dead host journal stays protected by its %s lane", async () => {
  const f = fixture(), file = path.join(f.journals, "session-fixed.jsonl");
  fs.writeFileSync(file, "retained host events\n");
  fs.utimesSync(file, new Date(NOW - WEEK - 1), new Date(NOW - WEEK - 1));
  f.setFacts({ ...f.facts(), pipelines: ["open-lane"] });
  const row = f.candidate(file, "journal", "session-fixed");
  const authority = temporaryDataAuthority(row, f.registry, f.source, () => NOW,
    () => ({ expiresAt: null, reason: "open-lane", revision: "open", current: () => true }));
  expect(authority.expiresAt).toBeNull(); expect(authority.reason).toBe("open-lane");
});

test.each(["expired", "live", "young"])("%s agent evidence uses host termination rather than directory age", async state => {
  const f = fixture(), directory = path.join(f.evidence, "agent-captures"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "screen.png"), "capture");
  if (state === "live") f.setFacts({ ...f.facts(), entry: { ...f.facts().entry!, status: "idle" } });
  if (state === "young") f.setFacts({ ...f.facts(), entry: { ...f.facts().entry!, updatedAt: new Date(NOW - WEEK + 1).toISOString() } });
  f.candidate(directory, "agent-evidence"); expect((await f.sweep()).removed).toBe(state === "expired" ? 1 : 0);
});

test("registry or transcript drift invalidates a previously observed journal authority", () => {
  const f = fixture(), file = path.join(f.journals, "session-fixed.jsonl"); fs.writeFileSync(file, "journal");
  const row = f.candidate(file, "journal", "session-fixed"), authority = temporaryDataAuthority(row, f.registry, f.source, () => NOW);
  expect(authority.current()).toBeTrue(); fs.writeFileSync(f.transcript, "new transcript content"); expect(authority.current()).toBeFalse();
});

test.each(["expired", "live", "resuming"])("a closed lane retains %s host evidence until the host is finished", async state => {
  const f = fixture(), directory = path.join(f.evidence, "agent-captures"); fs.mkdirSync(directory);
  f.setFacts({ ...f.facts(), pipelines: ["lane-fixed"],
    entry: { ...f.facts().entry!, status: state === "live" ? "live" : "dead" },
    receipt: { ...f.facts().receipt!, state: state === "resuming" ? "starting" : "completed" } });
  f.candidate(directory, "agent-evidence");
  const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async row => temporaryDataAuthority(row, f.registry, f.source, () => NOW,
      () => ({ expiresAt: NOW - 1, reason: "expired", revision: "closed-lane", current: () => true })) });
  expect(report.removed).toBe(state === "expired" ? 1 : 0); expect(fs.existsSync(directory)).toBe(state !== "expired");
});

test.each([1, 2])("a copy ledger rebound at reference fence %s retains its data", async fence => {
  const f = fixture(), original = path.join(f.root, "old-scratch"), identity = "17:23";
  const name = createHash("sha256").update(original).update("\0").update(identity).digest("hex"), directory = path.join(f.evidence, name);
  fs.mkdirSync(directory); writeEnvelope(path.join(directory, "manifest.json"), { original, identity, launchId: "legacy-fixed" });
  f.candidate(directory, "ownerless-copy", name);
  f.registry.spawnReceipt = () => null; f.registry.temporaryDataFacts = () => ({ receipt: null, entry: null, pipelines: [] });
  let copy: EvidenceCopy | null = null, observations = 0;
  const source = { owner: () => null, copy: () => copy };
  const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {},
    references: async () => { if (++observations === fence) copy = { destination: directory, pipelineId: "new-lane", launchId: "legacy-fixed",
      kind: "lane", createdAt: NOW, expiresAt: null, checkedAt: NOW, bytes: 0 }; return true; },
    authority: async row => temporaryDataAuthority(row, f.registry, source, () => NOW) });
  expect(report.removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
});

test("a real evidence writer cannot replace live copy-ledger ownership with a finished manifest owner", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR, state = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = state;
  const original = path.join(f.root, "original-scratch"); fs.mkdirSync(original); fs.writeFileSync(path.join(original, "capture.png"), "capture");
  const sourceStat = fs.lstatSync(original), sourceIdentity = `${sourceStat.dev}:${sourceStat.ino}`;
  const ledger = new AttemptTempStore(path.join(f.root, "attempt-temp.sqlite"));
  let destination = "";
  try {
    for (const launchId of ["live-agent", "finished-agent"]) {
      const saved = await preserveAttemptEvidence(original, original, sourceIdentity, { pipelineId: null, launchId,
        register: value => ledger.registerCopy({ destination: value, pipelineId: null, launchId, kind: "agent",
          createdAt: NOW - WEEK - 1, expiresAt: null, checkedAt: 0, bytes: 0 }) });
      destination = saved.destination!;
    }
    const stat = fs.lstatSync(destination), scope = path.join(state, "evidence"), candidate = {
      directory: destination, scope, kind: "ownerless-copy" as const, owner: path.basename(destination),
      identity: `${stat.dev}:${stat.ino}`, adoptedAt: NOW - WEEK - 1, checkedAt: 0, bytes: 0, reason: "fixture",
    };
    f.store.register(candidate);
    const finished = { receipt: { launchId: "finished-agent", state: "completed" },
      entry: { status: "dead", updatedAt: new Date(NOW - WEEK - 1).toISOString() }, pipelines: [] } as unknown as Facts;
    const live = { receipt: { launchId: "live-agent", state: "running" },
      entry: { status: "live", updatedAt: new Date(NOW).toISOString() }, pipelines: [] } as unknown as Facts;
    const registry: TemporaryRegistry = { temporaryDataFacts: input => input.launchId === "live-agent" ? live : finished,
      temporaryDataReceiptKeys: () => [], spawnReceipt: () => null, spawnReceiptForHost: () => null };
    const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {},
      references: async () => true, authority: async row => temporaryDataAuthority(row, registry, ledger, () => NOW) });
    expect(ledger.copy(destination)?.launchId).toBe("live-agent");
    expect(report.removed).toBe(0); expect(fs.existsSync(destination)).toBeTrue();
    expect(report.kept["copy-owner-conflict"]).toBe(1);
  } finally {
    ledger.close();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a closed lane preserves the journal's seven-day last-event clock", async () => {
  const f = fixture(), file = path.join(f.journals, "session-fixed.jsonl"); fs.writeFileSync(file, "journal");
  fs.utimesSync(file, new Date(NOW - WEEK - 1), new Date(NOW - WEEK - 1));
  f.setFacts({ ...f.facts(), pipelines: ["lane-fixed"] }); f.candidate(file, "journal", "session-fixed");
  const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async row => temporaryDataAuthority(row, f.registry, f.source, () => NOW,
      () => ({ expiresAt: NOW + WEEK, reason: "young", revision: "closed-lane", current: () => true })) });
  expect(report.removed).toBe(1);
});

test("a pending action and an unproven process identity keep a nominally dead host", () => {
  const f = fixture();
  expect(finishedAgent(f.facts())).toBe(NOW - WEEK - 1);
  expect(finishedAgent({ ...f.facts(), entry: { ...f.facts().entry!, pendingAction: "resume" } })).toBeNull();
  expect(finishedAgent({ ...f.facts(), entry: { ...f.facts().entry!, paneAgent: { pid: 100001, startIdentity: null } } }, () => false)).toBeNull();
});

test("a nominally dead wrapper retains unfinished domain, scope and exit custody", () => {
  const f = fixture(), process = { pid: 100001, startIdentity: "fixture" };
  const cases = [
    { structuredTerminationSurvivors: [process] }, { pendingHostExits: [{ process, launchId: "agent-fixed" }] },
    { structuredHost: { scope: { unit: "fixture.scope", bootEpoch: "fixture" } } },
    { structuredHost: { memory: { unit: "fixture.scope" } } },
    { structuredHost: { signalDomain: { retired: false, monitor: process, bubblewrap: process, init: process, native: process } } },
  ];
  for (const custody of cases) expect(finishedAgent({ ...f.facts(), entry: { ...f.facts().entry!, ...custody } } as Facts, () => true)).toBeNull();
  expect(finishedAgent(f.facts(), () => true)).toBe(NOW - WEEK - 1);
});

test.each(["expired", "grace", "open-lane", "invalid-manifest"])("a legacy copy with %s ownership is classified safely", async state => {
  const f = fixture(), original = path.join(f.root, "old-scratch"), identity = "17:23";
  const name = createHash("sha256").update(original).update("\0").update(identity).digest("hex"), directory = path.join(f.evidence, name);
  fs.mkdirSync(directory); writeEnvelope(path.join(directory, "manifest.json"), { original, identity, launchId: "legacy-fixed" });
  const row = f.candidate(directory, "ownerless-copy", name);
  f.registry.spawnReceipt = () => null;
  f.registry.temporaryDataFacts = () => ({ receipt: null, entry: null, pipelines: state === "open-lane" ? ["lane-fixed"] : [] });
  if (state === "grace") { f.store.forget(directory); f.store.register({ ...row, adoptedAt: NOW - WEEK + 1 }); }
  if (state === "invalid-manifest") writeEnvelope(path.join(directory, "manifest.json"), { original, identity: "wrong" });
  const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async row => temporaryDataAuthority(row, f.registry, f.source, () => NOW,
      () => ({ expiresAt: null, reason: "open-lane", revision: "open", current: () => true })) });
  expect(report.removed).toBe(state === "expired" ? 1 : 0); expect(fs.existsSync(directory)).toBe(state !== "expired");
});

test("an unattributed adopted copy ignores a launch copied from a replacement source identity", async () => {
  const f = fixture(), original = path.join(f.root, "old-scratch"), identity = "17:23";
  const name = createHash("sha256").update(original).update("\0").update(identity).digest("hex"), directory = path.join(f.evidence, name);
  fs.mkdirSync(directory); writeEnvelope(path.join(directory, "manifest.json"), { original, identity });
  const row = f.candidate(directory, "ownerless-copy", name), adoptedRow = { ...row, adoptedAt: NOW };
  f.store.forget(directory); f.store.register(adoptedRow);
  let copy: EvidenceCopy = { destination: directory, pipelineId: null, launchId: "replacement-agent", kind: "unattributed",
    createdAt: NOW, expiresAt: null, checkedAt: NOW, bytes: 0 };
  const source = { owner: () => ({ directory: original, identity: "99:88", launchId: "replacement-agent", pipelineId: null,
    retainUntilClose: false, createdAt: NOW, released: 0, checkedAt: NOW, bytes: 0 }), copy: () => copy };
  const replacement: Facts = { receipt: { launchId: "replacement-agent", state: "completed" },
    entry: { status: "dead", updatedAt: new Date(NOW - WEEK * 3).toISOString() }, pipelines: [] } as unknown as Facts;
  f.registry.temporaryDataFacts = () => replacement;
  const authority = temporaryDataAuthority(adoptedRow, f.registry, source, () => NOW);
  expect(authority.expiresAt).toBe(NOW + WEEK); expect(authority.reason).toBe("adoption-grace");
  expect(authority.current()).toBeTrue(); copy = { ...copy, launchId: "other-generation" };
  expect(authority.current()).toBeFalse();
});

test("legacy copy adoption keeps seven-day grace when its replacement source has another identity", async () => {
  const f = fixture(), priorState = process.env.LLV_STATE_DIR, state = path.join(f.root, "state");
  process.env.LLV_STATE_DIR = state;
  const original = path.join(f.root, "llv-stage-source"); fs.mkdirSync(original); fs.writeFileSync(path.join(original, "capture.png"), "capture");
  const sourceStat = fs.lstatSync(original), sourceIdentity = `${sourceStat.dev}:${sourceStat.ino}`;
  const ledger = new AttemptTempStore(path.join(state, "attempt-temp.sqlite"));
  try {
    const saved = await preserveAttemptEvidence(original, original, sourceIdentity);
    fs.renameSync(original, original + "-old"); fs.mkdirSync(original);
    ledger.register({ directory: original, pipelineId: null, launchId: "replacement-agent", createdAt: NOW - WEEK * 3,
      retainUntilClose: true });
    expect(ledger.owner(original)?.identity).not.toBe(sourceIdentity);
    const adoption = await sweepEvidenceCopies(ledger, { now: () => NOW, state: async () => "orphan", references: async () => true,
      scan: () => ({ ownNamespace: null, processes: [] }) }, { agentCopiesManagedSeparately: true });
    const directory = saved.destination!, stat = fs.lstatSync(directory), scope = path.join(state, "evidence");
    f.store.register({ directory, scope, kind: "ownerless-copy", owner: path.basename(directory), identity: `${stat.dev}:${stat.ino}`,
      adoptedAt: NOW, checkedAt: 0, bytes: 0, reason: "legacy-adoption" });
    const replacement: Facts = { receipt: { launchId: "replacement-agent", state: "completed" },
      entry: { status: "dead", updatedAt: new Date(NOW - WEEK * 3).toISOString() }, pipelines: [] } as unknown as Facts;
    f.registry.temporaryDataFacts = () => replacement;
    const authority = temporaryDataAuthority(f.store.get(directory)!, f.registry, ledger, () => NOW);
    const report = await sweepTemporaryData(f.store, { now: () => NOW, mounts: () => [], claim: async () => () => {},
      references: async () => true, authority: async row => temporaryDataAuthority(row, f.registry, ledger, () => NOW) });
    expect(adoption.adopted).toBe(1); expect(ledger.copy(directory)?.launchId).toBe("legacy");
    expect(authority.expiresAt).toBe(NOW + WEEK); expect(authority.reason).toBe("adoption-grace");
    expect(report.removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
  } finally {
    ledger.close();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  }
});

async function runLegacyCopyTick(at: number, live = "") {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--legacy-copy-tick", String(at), live],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, errors).toBe(0);
  return JSON.parse(output);
}

test("the one-time copy pass resumes in a new process and keeps ambiguous, live and linked copies", async () => {
  const f = fixture(), state = path.join(f.root, "state"), previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  const finishedAt = new Date(NOW - WEEK - 60_000).toISOString();
  const lane = finishedLane(f.root, finishedAt), launchId = "finished-copy-launch";
  lane.runs = [{ stageId: "build", attempts: [{ n: 1, state: "passed", launchId,
    effectiveRole: lane.stages[0]!.effectiveRole, conversationId: "fixture", sessionId: null, agentPath: null,
    paneId: null, flowId: null, startedAt: finishedAt, completedAt: finishedAt,
    input: null, activatedBy: null, output: "finished", verdict: { status: "pass" }, error: null }] }];
  savePipelines([lane]);
  const ledger = new AttemptTempStore(), temporary = new TemporaryDataStore();
  const rows = Array.from({ length: 10 }, (_, index) => {
    const original = path.join(state, "scratch", `llv-stage-${String(index).padStart(6, "0")}`), identity = "17:23";
    const name = createHash("sha256").update(original).update("\0").update(identity).digest("hex");
    return { original, identity, name, directory: path.join(state, "evidence", "attempt-temp", name) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const finished = rows[0]!.directory, ambiguous = rows[1]!.directory, live = rows[2]!.directory, linked = rows[3]!.directory;
  const laterAmbiguous = rows[9]!.directory, adoptedAt = NOW - 60_000, expiresAt = adoptedAt + WEEK;
  try {
    for (const { original, identity, name, directory } of rows) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "frame.png"), "preserved fixture");
      const unconfirmed = directory === ambiguous || directory === laterAmbiguous;
      writeEnvelope(path.join(directory, "manifest.json"), { original, identity, pipelineId: lane.id,
        launchId: unconfirmed ? "unconfirmed-copy-launch" : launchId });
      ledger.registerCopy({ destination: directory, pipelineId: null, launchId: "legacy", kind: "unattributed",
        createdAt: NOW - WEEK * 2, expiresAt: null, checkedAt: 0, bytes: 4096 });
      const stat = fs.lstatSync(directory);
      temporary.register({ directory, scope: path.join(state, "evidence"), kind: "ownerless-copy", owner: name,
        identity: `${stat.dev}:${stat.ino}`, adoptedAt: unconfirmed ? adoptedAt : NOW,
        checkedAt: NOW + WEEK, bytes: 4096, reason: "deferred" });
    }
    nameInReport(path.join(linked, "frame.png"));
    const tick = (at: number) => runLegacyCopyTick(at, live);
    expect(await tick(NOW)).toMatchObject({ removed: 5, errors: 0 });
    expect(fs.existsSync(finished)).toBeFalse(); expect(fs.existsSync(rows[8]!.directory)).toBeTrue();
    expect(temporary.meta("unattributed-copies-v1")).toBe(rows[7]!.directory);
    expect(await tick(NOW + 1)).toMatchObject({ removed: 1, errors: 0 });
    expect(temporary.meta("unattributed-copies-v1")).toBe("done");
    expect(ledger.unattributedCopies()).toEqual({ count: 4, bytes: 4 * 4096 });
    expect(await tick(NOW + 2)).toMatchObject({ checked: 0, removed: 0 });
    for (const directory of [ambiguous, live, linked, laterAmbiguous])
      expect(fs.readFileSync(path.join(directory, "frame.png"), "utf8")).toBe("preserved fixture");
    for (const directory of [ambiguous, laterAmbiguous])
      expect(temporary.get(directory)).toMatchObject({ adoptedAt, checkedAt: expiresAt, reason: "adoption-grace" });
    expect(await tick(expiresAt - 1)).toMatchObject({ removed: 0, errors: 0 });
    expect(await tick(expiresAt)).toMatchObject({ removed: 2, errors: 0 });
    for (const directory of [ambiguous, laterAmbiguous]) expect(fs.existsSync(directory)).toBeFalse();
    for (const directory of [live, linked]) expect(fs.existsSync(directory)).toBeTrue();
  } finally {
    temporary.close(); ledger.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
}, 15_000);

test("the one-time copy pass reports a persistent ledger error and advances after three restarted ticks", async () => {
  const f = fixture(), state = path.join(f.root, "state"), previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = state;
  const ledger = new AttemptTempStore(), temporary = new TemporaryDataStore();
  const evidence = path.join(state, "evidence"), parent = path.join(evidence, "attempt-temp");
  const rows = ["fixture-a", "fixture-b"].map(name => {
    const original = path.join(state, "scratch", name), identity = "17:23";
    const digest = createHash("sha256").update(original).update("\0").update(identity).digest("hex");
    return { original, identity, directory: path.join(parent, digest) };
  }).sort((a, b) => a.directory.localeCompare(b.directory));
  const blocked = rows[0]!.directory, later = rows[1]!.directory;
  try {
    for (const { directory, original, identity } of rows) {
      fs.mkdirSync(directory, { recursive: true });
      writeEnvelope(path.join(directory, "manifest.json"), { original, identity });
      const stat = fs.lstatSync(directory);
      ledger.registerCopy({ destination: directory, pipelineId: null, launchId: "legacy", kind: "unattributed",
        createdAt: NOW, expiresAt: null, checkedAt: 0, bytes: 0 });
      temporary.register({ directory, scope: evidence, kind: "ownerless-copy", owner: path.basename(directory),
        identity: `${stat.dev}:${stat.ino}`, adoptedAt: NOW, checkedAt: NOW + WEEK, bytes: 0,
        reason: directory === blocked ? "copy-queue-fixture" : "deferred" });
    }
    const db = new Database(temporary.filename);
    try {
      db.exec(`CREATE TRIGGER refuse_copy_queue BEFORE UPDATE OF kind ON candidates
        WHEN OLD.reason = 'copy-queue-fixture'
        BEGIN SELECT RAISE(ABORT, 'fixture ledger write failed'); END;`);
    } finally { db.close(); }
    const original = temporary.get(blocked);
    for (const failures of [1, 2, 3]) {
      const skipped = failures === 3;
      expect(await runLegacyCopyTick(NOW + failures)).toMatchObject({ removed: 0, errors: 0 });
      const report = JSON.parse(fs.readFileSync(path.join(state, "temporary-data-report.json"), "utf8"));
      expect(report).toMatchObject({ legacyCopiesQueued: skipped ? 1 : 0, legacyCopyQueueError: true,
        legacyCopyQueueErrors: [{ directory: blocked, code: "SQLITE_CONSTRAINT_TRIGGER",
          message: "fixture ledger write failed", failures, skipped }] });
      expect(temporary.get(later)?.kind).toBe(skipped ? "legacy-attempt-copy" : "ownerless-copy");
    }
    expect(temporary.meta("unattributed-copies-v1")).toBe("done");
    expect(temporary.get(blocked)).toEqual(original);
    expect(fs.existsSync(blocked)).toBeTrue();
    expect(fs.existsSync(later)).toBeTrue();
  } finally {
    temporary.close(); ledger.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  }
}, 15_000);

test("production retention requires an injected container observer in tests", async () => {
  const f = fixture(), original = path.join(f.root, "missing-source"), identity = "17:23";
  const name = createHash("sha256").update(original).update("\0").update(identity).digest("hex");
  const calls = path.join(f.root, "docker-calls"), bin = path.join(f.root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`, { mode: 0o700 });
  const statePaths = [path.join(f.root, "state-refused"), path.join(f.root, "state-injected")];
  const directories = statePaths.map(state => {
    const directory = path.join(state, "evidence", "attempt-temp", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ original, identity, pipelineId: null, launchId: null, files: [] }));
    const stat = fs.lstatSync(directory), seeded = new TemporaryDataStore(path.join(state, "temporary-data.sqlite"));
    seeded.register({ directory, scope: path.join(state, "evidence"), kind: "ownerless-copy", owner: name, identity: `${stat.dev}:${stat.ino}`,
      adoptedAt: Date.now() - WEEK - 1, checkedAt: 0, bytes: 0, reason: "fixture" }); seeded.close();
    const old = new Date(Date.now() - WEEK * 2), pending = [directory];
    while (pending.length) {
      const current = pending.pop()!, entry = fs.lstatSync(current);
      if (entry.isDirectory()) pending.push(...fs.readdirSync(current).map(child => path.join(current, child)));
      fs.utimesSync(current, old, old);
    }
    return directory;
  });
  const script = path.join(f.root, "run-sweep.ts");
  fs.writeFileSync(script, `import { runTemporaryDataSweep } from ${JSON.stringify(path.resolve("src/lib/runtime/temporaryDataProduction.ts"))};\n`+
    `const observer = process.env.FIXTURE_OBSERVER === "1" ? async () => true : undefined;\n`+
    `console.log(JSON.stringify(await runTemporaryDataSweep({ scan: () => ({ ownNamespace: null, processes: [] }), `+
    `...(observer ? { containerReferences: observer } : {}) })));\n`);
  const run = async (state: string, observer: boolean) => {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, HOME: path.join(f.root, "home"),
      XDG_CONFIG_HOME: path.join(f.root, "config"), TMPDIR: f.root, LLV_STATE_DIR: state, NODE_ENV: "test",
      LLV_TEMP_SWEEP: "on", PATH: `${bin}:${process.env.PATH ?? ""}`, DOCKER_HOST: `unix://${path.join(f.root, "missing.sock")}`,
      FIXTURE_OBSERVER: observer ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit: await child.exited, stdout, stderr };
  };
  for (const directoryName of ["home", "config"]) fs.mkdirSync(path.join(f.root, directoryName));
  const refused = await run(statePaths[0]!, false);
  expect(refused.exit).not.toBe(0); expect(refused.stderr).toContain("default Docker reference observer");
  expect(fs.existsSync(calls)).toBeFalse(); expect(fs.existsSync(directories[0]!)).toBeTrue();
  const injected = await run(statePaths[1]!, true);
  expect(injected.exit).toBe(0); expect(JSON.parse(injected.stdout.trim()).removed).toBe(1);
  expect(fs.existsSync(calls)).toBeFalse(); expect(fs.existsSync(directories[1]!)).toBeFalse();
});

test("discovery preserves worktree backup content and the adoption clock across pages", () => {
  const f = fixture(), lane = path.join(f.evidence, "lane-fixed"); fs.mkdirSync(path.join(lane, "worktree"), { recursive: true });
  fs.writeFileSync(path.join(lane, "worktree", "only.txt"), "only copy"); fs.writeFileSync(path.join(lane, "worktree-backup.json"), "manifest");
  fs.writeFileSync(path.join(lane, "screen.png"), "expendable");
  let now = NOW;
  for (let i = 0; i < 10; i++) { discoverTemporaryData(f.store, f.registry, () => now, performance.now() + 1000, () => performance.now(), f); now += 3600001; }
  const rows = f.store.due(now, 100);
  expect(rows.map(row => path.basename(row.directory))).toEqual(["screen.png"]);
  expect(rows[0]!.adoptedAt).toBeLessThan(now - 3600001);
  expect(fs.readFileSync(path.join(lane, "worktree", "only.txt"), "utf8")).toBe("only copy");
});

test("discovery and sweep reserve interrupted lifecycle journals, including adopted rows", async () => {
  const f = fixture(), lane = path.join(f.evidence, "lane-fixed"); fs.mkdirSync(lane);
  const journal = path.join(lane, `.delegatus-sweep-${"a".repeat(64)}.json`);
  fs.writeFileSync(journal, JSON.stringify({ directory: path.join(lane, "captures"), trash: path.join(lane, ".delegatus-trash-captures-fixed"),
    uid: process.getuid?.() ?? 0, identity: "1:2", disposable: true }));
  let now = NOW;
  for (let i = 0; i < 10; i++) { discoverTemporaryData(f.store, f.registry, () => now, performance.now() + 1000, () => performance.now(), f); now += 3600001; }
  expect(f.store.get(journal)).toBeNull();
  const stat = fs.lstatSync(journal), row: TemporaryDataCandidate = { directory: journal, scope: f.evidence, kind: "lane-evidence", owner: "lane-fixed",
    identity: `${stat.dev}:${stat.ino}`, adoptedAt: NOW - WEEK - 1, checkedAt: 0, bytes: 0, reason: "legacy-adoption" };
  f.store.register(row);
  const report = await sweepTemporaryData(f.store, { now: () => now, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async () => ({ expiresAt: now - 1, reason: "expired", revision: "fixture", current: () => true }) });
  expect(fs.existsSync(journal)).toBeTrue(); expect(report.removed).toBe(0);
  expect(report.kept["lifecycle-control"]).toBe(1); expect(f.store.get(journal)?.reason).toBe("lifecycle-control");
});

test("an absent namespace is retried and restored data is discovered", () => {
  const f = fixture(); fs.rmdirSync(f.journals); let now = NOW;
  discoverTemporaryData(f.store, f.registry, () => now, performance.now() + 1000, () => performance.now(), f);
  fs.mkdirSync(f.journals); fs.writeFileSync(path.join(f.journals, "session-fixed.jsonl"), "journal"); now += 3600001;
  discoverTemporaryData(f.store, f.registry, () => now, performance.now() + 1000, () => performance.now(), f);
  expect(f.store.get(path.join(f.journals, "session-fixed.jsonl"))?.owner).toBe("session-fixed");
});

test("an expired empty lane evidence folder is removed while backup folders remain", async () => {
  const f = fixture(), empty = path.join(f.evidence, "empty-lane"), backedUp = path.join(f.evidence, "backup-lane");
  fs.mkdirSync(empty); fs.mkdirSync(path.join(backedUp, "worktree"), { recursive: true });
  fs.writeFileSync(path.join(backedUp, "worktree", "only-copy"), "preserve");
  let now = NOW;
  for (let i = 0; i < 10; i++) { discoverTemporaryData(f.store, f.registry, () => now, performance.now() + 1000, () => performance.now(), f); now += 3600001; }
  const report = await sweepTemporaryData(f.store, { now: () => now, mounts: () => [], claim: async () => () => {}, references: async () => true,
    authority: async () => ({ expiresAt: now - 1, reason: "expired", revision: "fixture", current: () => true }) });
  expect(report.removed).toBe(1); expect(fs.existsSync(empty)).toBeFalse();
  expect(fs.readFileSync(path.join(backedUp, "worktree", "only-copy"), "utf8")).toBe("preserve");
});
