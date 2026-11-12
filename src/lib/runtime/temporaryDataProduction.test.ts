import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeEnvelope } from "@/lib/recordedChecks/wire";
import type { AgentRegistry } from "@/lib/agent/registry";
import { TemporaryDataStore, type TemporaryDataCandidate } from "./temporaryDataStore";
import { discoverTemporaryData, finishedAgent, temporaryDataAuthority, type TemporaryRegistry } from "./temporaryDataProduction";
import { sweepTemporaryData, TEMPORARY_DATA_RETENTION_MS as WEEK } from "./temporaryDataRetention";
import { AttemptTempStore, type EvidenceCopy } from "./attemptTempRetention";
import { preserveAttemptEvidence } from "./attemptTempEvidence";

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
