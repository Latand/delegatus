import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { AgentStateService } from "@/lib/agentState/service";
import { entryRevision, subjectId } from "@/lib/agentState/store";
import { clearAgentObservations } from "@/lib/agentState/projectionCache";
import { fixtureRecords, fixtureRegistry, FIXTURE_NOW, FIXTURE_SESSION, FIXTURE_TURN } from "@/lib/agentState/testFixture";
import { captureProcessIdentity, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { fixtureReport, ownFixtureTree, stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { determined, undetermined } from "./determinable";
import type { EngineHost } from "./engineHost";
import * as control from "./structuredHostControl";
import * as delivery from "./structuredDeliveryController";
import { statePath } from "@/lib/configDir";
import { buildPipeline, loadPipelinesForRetirement, savePipelines } from "@/lib/pipelines/store";
import { durableRuntimeEventTailSeq, FileRuntimeEventStore } from "./eventStore";
import { runStructuredHostRetirementSweep, type StructuredHostRetirementDependencies } from "./structuredHostRetirement";

const identities: ProcessIdentity[] = [];
const children: ChildProcess[] = [];
const roots: string[] = [];
const originalTerminate = control.terminateStructuredHostTree;
const originalStateDirectory = process.env.LLV_STATE_DIR;
afterEach(async () => {
  if (originalStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDirectory;
  for (const identity of identities.splice(0).reverse()) await stopFixtureIdentity(identity);
  // Kernel exit can precede the ChildProcess exit notification. Reap the
  // original handles before the file's ownership guardian judges teardown.
  for (const child of children.splice(0)) await stopFixtureProcess(child);
  clearAgentObservations();
  setAgentRegistryForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

for (const engine of ["codex", "claude"] as const) {
  for (const [boundary, change] of [
    ["none", "none"], ["open-turn", "none"],
    ["measurement", "resume"], ["capture", "resume"], ["release", "resume"],
    ["measurement", "unrelated"], ["capture", "unrelated"], ["release", "unrelated"],
  ] as const) {
    test(`${engine}: recent passed stage retirement, ${change} at ${boundary}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-host-lifecycle-"));
      roots.push(root);
      process.env.LLV_STATE_DIR = path.join(root, "state");
      const child = ownFixtureTree(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }));
      children.push(child);
      const identity = captureProcessIdentity(child.pid!);
      identities.push(identity);
      const file = fixtureRegistry(root, engine, identity, null);
      const entry = file.entries[`${engine}:${FIXTURE_SESSION}`]!;
      entry.status = "idle";
      entry.structuredHostOperationId = null;
      entry.structuredHost!.activeTurnRef = null;
      const records = fixtureRecords(engine);
      const openTurn = boundary === "open-turn";
      const sweepAt = FIXTURE_NOW;
      const native = [...records.open, ...(openTurn ? [] : records.close)].map(row => JSON.stringify(row)).join("\n") + "\n";
      fs.writeFileSync(entry.artifactPath!, native);
      fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
      const filename = path.join(root, "registry.json");
      fs.writeFileSync(filename, JSON.stringify(file));
      const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
      setAgentRegistryForTests(registry);
      const conversation = Object.values(file.conversations)[0]!;
      const lane = buildPipeline({ id: "stage-lifecycle", task: "Fixture", project: "fixture", repoDir: "/fixture", srcPath: null, srcConversationId: null,
        now: new Date(FIXTURE_NOW - 1000).toISOString(), stages: [{ id: "review", kind: "run", prompt: "Review", next: null,
          effectiveRole: { roleId: null, engine, model: null, effort: null, access: "read-only", promptScaffold: null } }] });
      lane.state = "running";
      lane.runs[0]!.attempts = [{ n: 1, state: "passed", effectiveRole: lane.stages[0]!.effectiveRole, launchId: null, conversationId: conversation.id,
        sessionId: FIXTURE_SESSION, agentPath: entry.artifactPath, paneId: null, flowId: null, startedAt: lane.createdAt,
        completedAt: new Date(FIXTURE_NOW).toISOString(), input: null, activatedBy: null, output: null, error: null, verdict: { status: "pass", findings: [] } }];
      const unrelated = buildPipeline({ id: "unrelated-lane", task: "Unrelated", project: lane.project, repoDir: lane.repoDir,
        srcPath: null, srcConversationId: null, now: lane.createdAt, stages: [], state: "draft" });
      savePipelines([lane, unrelated]);
      const writePipeline = () => {
        if (change === "resume") lane.runs[0]!.attempts[0]!.state = "running";
        else unrelated.stateDetail = "Unrelated update";
        savePipelines([lane, unrelated]);
      };
      const service = new AgentStateService({ registry, now: () => sweepAt, owns: () => true,
        process: value => procBackend.pidAlive(value.pid) ? "alive" : "dead", memory: () => null, release: "fixture", publish: async () => true });
      const holds = spyOn(delivery, "hasStructuredDeliveryHost").mockReturnValue(false);
      await service.request();
      let signals = 0;
      const terminate = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) => originalTerminate(ref, {
        ...dependencies, graceMs: 50, deadlineMs: 2000,
        persistCapturedTree: async captured => {
          const result = await dependencies!.persistCapturedTree!(captured);
          if (boundary === "capture") writePipeline();
          return result;
        },
        terminateOwnedHost: async () => { if (boundary === "release") writePipeline(); return false; },
        signal: (pid, signal) => { signals++; process.kill(pid, signal); },
      }));
      try {
        const report = await runStructuredHostRetirementSweep({ snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
          publicationState: () => "ready", now: () => sweepAt, handoffRows: () => determined([]), durableEventTail: () => determined(0),
          realtimeBound: () => determined(false), orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
          readCursor: () => null, writeCursor: () => {}, treePss: async () => {
            await Promise.resolve();
            if (boundary === "measurement") writePipeline();
            return { bytes: null, measuredProcesses: 0 };
          } });
        expect(fs.readFileSync(entry.artifactPath!, "utf8")).toBe(native);
        expect(loadPipelinesForRetirement()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
        if (!openTurn && change !== "resume") {
          expect(report.failed).toEqual([]);
          expect(report.retired).toMatchObject([{ reason: "stage verdict", idleMs: 0 }]);
          expect(signals).toBeGreaterThan(0);
          expect(registry.hostEntry(entry.key)).toMatchObject({ status: "dead", structuredHost: null });
          expect(JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")).retired[0].reason).toBe("stage verdict");
          expect(JSON.parse(fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n").at(-1)!).retired[0].reason).toBe("stage verdict");
        } else {
          expect(report.retired).toEqual([]);
          if (openTurn) {
            const nativeId = engine === "codex" ? FIXTURE_TURN : "native-prompt-one";
            expect(registry.readOnlySnapshot().agentStates[subjectId(entry)]?.facts.turn)
              .toMatchObject({ determined: true, value: { state: "open", nativeId } });
            expect(registry.hostEntry(entry.key)?.structuredHost?.activeTurnRef).toBeNull();
            expect(report.refused).toMatchObject([{ clause: "turn-settled", reason: `turn ${nativeId} is in flight` }]);
          } else {
            const reason = "the pipeline no longer releases this host for prompt retirement";
            if (boundary === "measurement") expect(report.refused).toMatchObject([{ clause: "transcript-idle", reason, changed: true }]);
            else expect(report.failed).toMatchObject([{ error: `scope retirement target changed: verdict transcript-idle: ${reason}` }]);
          }
          expect(signals).toBe(0);
          expect(procBackend.pidAlive(identity.pid)).toBe(true);
        }
      } finally { terminate.mockRestore(); holds.mockRestore(); service.stop(); registry.close(); }
    });
  }
}

for (const [engine, eventDebt] of [["codex", false], ["claude", false], ["codex", true], ["claude", true]] as const) {
  for (const change of ["released-owner", "capture-release", "capture-replacement", "capture-release-epoch", "capture-release-writer", "missing-identity", "already-reconciled", "live-owner", "new-generation", "reopened-turn",
    "live-child", "empty-diagnostics-live-child", "loaded-scope", "unknown-scope", "unknown-identity", "scope-owner", "scope-turn",
    "admission-owner", "admission-turn", "admission-boot", "reused-pids", "settled-scope", "live-status", "released-columns", "released-columns-live-work",
    ...(eventDebt ? ["unverified-owner", "locally-owned", "released-claim-epoch", "released-writer-epoch"] as const : [])] as const) {
    test(`${engine}: concurrent close after capture, ${change}${eventDebt ? ", unflushed events" : ""}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-close-"));
      roots.push(root);
      const script = path.join(root, "host.mjs");
      fs.writeFileSync(script, 'import { spawn } from "node:child_process"; spawn("sleep", ["60"], { detached: true, stdio: "ignore" }).unref(); setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [script], { stdio: "ignore" });
      children.push(child);
      const identity = captureProcessIdentity(child.pid!);
      identities.push(identity);
      let tree: ProcessIdentity[] = [];
      for (let attempt = 0; attempt < 200 && tree.length < 2; attempt++) {
        await Bun.sleep(10);
        tree = descendantPids(identity.pid, procBackend.ppidMap()).map(pid => captureProcessIdentity(pid));
      }
      identities.push(...tree.filter(value => value.pid !== identity.pid));
      expect(tree.length).toBeGreaterThanOrEqual(2);
      const file = fixtureRegistry(root, engine, identity,
        { pid: 2_147_483_647, startIdentity: "fixture-owner", bootEpoch: identity.bootEpoch });
      const entry = file.entries[`${engine}:${FIXTURE_SESSION}`]!;
      entry.structuredHostOperationId = null;
      entry.structuredHost!.activeTurnRef = null;
      entry.status = change === "live-status" ? "live" : "idle";
      if (change.startsWith("released-columns")) entry.structuredHost!.activeFlags = ["structured-image-v1"];
      if (change !== "missing-identity") entry.structuredHost!.scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: identity.bootEpoch! };
      const events = new FileRuntimeEventStore(path.join(root, "events"));
      if (eventDebt) for (const seq of [1, 2]) events.append(FIXTURE_SESSION,
        { kind: "delta", turnId: "fixture-turn", text: "retained output", seq });
      const eventsBefore = events.load(FIXTURE_SESSION);
      const records = fixtureRecords(engine);
      fs.writeFileSync(entry.artifactPath!, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
      fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
      const filename = path.join(root, "registry.json");
      fs.writeFileSync(filename, JSON.stringify(file));
      const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
      setAgentRegistryForTests(registry);
      const service = new AgentStateService({ registry, now: () => FIXTURE_NOW + 24 * 3_600_000,
        owns: () => true, process: value => procBackend.pidAlive(value.pid) ? "alive" : "dead",
        memory: () => null, release: "fixture", publish: async () => true });
      await service.request();
      const retire = spyOn(registry, "terminateStructuredHost");
      let runtimeCalls = 0;
      let signals = 0;
      let closed = false;
      let admitted = false;
      const admit = registry.deliveryWriteOrBusy.bind(registry);
      const admission = spyOn(registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, write) => {
        if (correlation.label === "registry.idle-stop-capture" && change.startsWith("capture-")) {
          // Exit and release while the capture waits for writer admission.
          await Promise.resolve();
          for (const member of [...tree].reverse()) await stopFixtureIdentity(member);
          expect(registry.releaseStructuredHostClaim(entry.key, entry.claimOwner!, entry.claimEpoch)).toBe(true);
          if (change !== "capture-release") registry.agentStateWrite(state => {
            const current = state.entries[`${engine}:${FIXTURE_SESSION}`]!;
            if (change === "capture-replacement") current.claimOwner = "replacement-owner";
            if (change === "capture-release-epoch") current.claimEpoch++;
            if (change === "capture-release-writer") current.structuredHost!.writerClaimEpoch++;
          });
          closed = true;
        }
        if (correlation.label === "registry.idle-reconcile-gone") {
          await Promise.resolve();
          admitted = true;
          if (change === "admission-owner") registry.agentStateWrite(state => { state.entries[`${engine}:${FIXTURE_SESSION}`]!.claimOwner = "replacement-owner"; });
          if (change === "admission-turn") registry.agentStateWrite(state => { Object.values(state.conversations)[0]!.turn.state = "busy"; Object.values(state.conversations)[0]!.turn.observedAt = new Date(FIXTURE_NOW + 1).toISOString(); });
        }
        return admit(correlation, write);
      });
      const outcomes: control.StructuredHostTerminationOutcome[] = [];
      const terminate = spyOn(control, "terminateStructuredHostTree").mockImplementation(async (ref, dependencies) => {
        const outcome = await originalTerminate(ref, { ...dependencies,
          persistCapturedTree: async captured => {
            const accepted = await dependencies!.persistCapturedTree!(captured);
            if (change.startsWith("capture-")) { expect(accepted).toBe(false); return false; }
            expect(accepted).toBe(true);
            expect(captured).toHaveLength(tree.length);
            for (const member of tree.filter(value => !["live-child", "empty-diagnostics-live-child"].includes(change) || value.pid === identity.pid).reverse()) {
              await stopFixtureIdentity(member);
              for (let attempt = 0; attempt < 200 && procBackend.pidAlive(member.pid); attempt++) await Bun.sleep(10);
              expect(procBackend.pidAlive(member.pid)).toBe(false);
            }
            expect(procBackend.pidAlive(identity.pid)).toBe(false);
            closed = true;
            if (change.startsWith("released-columns")) registry.setStructuredHost(entry.key, {
              ...registry.hostEntry(entry.key)!.structuredHost!, activeTurnRef: null, pendingAttention: [],
              activeFlags: change === "released-columns-live-work" ? ["live-work"] : [],
            }, "dead");
            if (change !== "missing-identity" && change !== "already-reconciled") expect(registry.releaseStructuredHostClaim(entry.key, entry.claimOwner!, entry.claimEpoch)).toBe(true);
            if (change === "empty-diagnostics-live-child") registry.agentStateWrite(state => {
              state.entries[`${engine}:${FIXTURE_SESSION}`]!.structuredTerminationSurvivors = [];
            });
            if (change === "already-reconciled") expect(registry.terminateStructuredHost(entry.key, identity, captured, {
              process: identity, claimOwner: entry.claimOwner, claimEpoch: entry.claimEpoch,
              writerClaimEpoch: entry.structuredHost!.writerClaimEpoch,
            }, entry.structuredHost!.scope)).toBe(true);
            if (change === "released-claim-epoch") registry.agentStateWrite(state => { state.entries[`${engine}:${FIXTURE_SESSION}`]!.claimEpoch++; });
            if (change === "released-writer-epoch") registry.agentStateWrite(state => { state.entries[`${engine}:${FIXTURE_SESSION}`]!.structuredHost!.writerClaimEpoch++; });
            if (change === "live-owner") registry.agentStateWrite(state => { state.entries[`${engine}:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`; });
            if (change === "new-generation") registry.agentStateWrite(state => { Object.values(state.conversations)[0]!.generations.push({ ...Object.values(state.conversations)[0]!.generations[0]!, id: "successor-generation" }); });
            if (change === "reopened-turn") registry.agentStateWrite(state => { Object.values(state.conversations)[0]!.turn.state = "busy"; Object.values(state.conversations)[0]!.turn.observedAt = new Date(FIXTURE_NOW + 1).toISOString(); });
            return true;
          },
          terminateOwnedHost: async () => { runtimeCalls++; return false; },
          stopScope: async (_scope, options) => { options.authorize(); },
          retireRegistryEntry: change === "settled-scope" ? async () => false : undefined,
          signal: () => { signals++; }, graceMs: 20, deadlineMs: 1000,
        });
        // Scope failures can omit live members from their diagnostics. The
        // sweep still owes proof for the full capture it received earlier.
        if (change === "settled-scope") {
          expect(registry.settleStructuredTerminationSurvivors(entry.key, identity, tree, "fixture", entry.structuredHost!.scope!)).toBe(true);
        }
        const reported = change === "empty-diagnostics-live-child" && !outcome.ok ? { ...outcome, remaining: [], survivors: [] } : outcome;
        outcomes.push(reported);
        return reported;
      });
      try {
        const options: StructuredHostRetirementDependencies = {
          snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
          publicationState: () => "ready", now: () => FIXTURE_NOW + 24 * 3_600_000,
          handoffRows: () => determined([]), durableEventTail: sessionId => durableRuntimeEventTailSeq(sessionId, path.join(root, "events")), realtimeBound: () => determined(false),
          orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
          scopeLoadState: async () => {
            await Promise.resolve();
            if (change === "scope-owner") registry.agentStateWrite(state => { state.entries[`${engine}:${FIXTURE_SESSION}`]!.claimOwner = "replacement-owner"; });
            if (change === "scope-turn") registry.agentStateWrite(state => { Object.values(state.conversations)[0]!.turn.observedAt = new Date(FIXTURE_NOW + 1).toISOString(); });
            if (change === "unknown-scope") throw new Error("fixture scope observation unavailable");
            return change === "loaded-scope" ? "loaded" : "not-found";
          },
          pidAlive: change === "unknown-identity" ? pid => closed ? undetermined("fixture process presence unavailable") : determined(procBackend.pidAlive(pid))
            : change === "reused-pids" ? pid => determined(closed || procBackend.pidAlive(pid)) : undefined,
          processIdentity: change === "reused-pids" ? pid => determined(closed ? "replacement-start" : procBackend.processIdentity(pid)!) : undefined,
          bootEpoch: change === "admission-boot" ? () => admitted ? determined("replacement-boot") : determined(systemBootEpoch()!) : undefined,
          ownerProcess: change === "unverified-owner" ? () => closed ? "unverified" : "dead" : undefined,
          owned: change === "locally-owned" ? () => closed : undefined,
          treePss: () => ({ bytes: null, measuredProcesses: 0 }),
          readCursor: () => null, writeCursor: () => {},
        };
        const report = await runStructuredHostRetirementSweep(options);
        expect(outcomes).toHaveLength(1);
        if (change === "missing-identity") expect(outcomes[0]).toMatchObject({ ok: false,
          error: `scope retirement target changed: verdict process-identity: no kernel identity can be observed for pid ${identity.pid}` });
        expect(runtimeCalls).toBe(0);
        expect(signals).toBe(0);
        if (change === "capture-replacement") {
          expect(report.failed).toEqual([]);
          expect(report.refused).toMatchObject([{ changed: true, clause: "process-identity",
            reason: "scope retirement target changed: claimOwner" }]);
        }
        if (!["released-owner", "capture-release", "missing-identity", "already-reconciled", "reused-pids", "settled-scope", "live-status", "released-columns"].includes(change)) {
          expect(report.gone).toEqual([]);
          expect(report.retired).toEqual([]);
          expect(retire).not.toHaveBeenCalled();
          expect(report.failed.length + report.refused.length).toBe(1);
          expect(registry.hostEntry(entry.key)!.structuredHost).not.toBeNull();
          if (["live-child", "empty-diagnostics-live-child"].includes(change)) expect(tree.some(value => procBackend.pidAlive(value.pid))).toBe(true);
          return;
        }
        expect(report.failed).toEqual([]);
        expect(report.refused).toEqual([]);
        expect(report.gone).toHaveLength(1);
        expect(report.retired).toEqual([]);
        expect(retire).toHaveBeenCalledTimes(1);
        expect(registry.hostEntry(entry.key)).toMatchObject({ status: "dead", claimOwner: null, structuredHost: null });
        const unflushed = eventDebt ? { cursor: 0, tail: 2, ownerPid: 2_147_483_647,
          reason: "the owner process 2147483647 is dead, so events 1-2 can never be flushed" } : undefined;
        expect(report.gone![0]!.unflushedEvents).toEqual(unflushed);
        const stored = JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8"));
        const journal = JSON.parse(fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n").at(-1)!);
        expect(stored.gone[0].unflushedEvents).toEqual(unflushed);
        expect(journal.gone[0].unflushedEvents).toEqual(unflushed);
        expect(events.load(FIXTURE_SESSION)).toEqual(eventsBefore);
        const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
        try {
          expect(reopened.hostEntry(entry.key)).toMatchObject({ status: "dead", claimOwner: null, structuredHost: null });
          const replay = await runStructuredHostRetirementSweep({ ...options, snapshot: () => reopened.readOnlySnapshot() });
          expect(replay).toMatchObject({ gone: [], retired: [], failed: [], refused: [] });
          expect(retire).toHaveBeenCalledTimes(1);
        } finally { reopened.close(); }
      } finally { terminate.mockRestore(); admission.mockRestore(); retire.mockRestore(); service.stop(); registry.close(); }
    });
  }
}

for (const [engine, scoped] of [["codex", true], ["codex", false], ["claude", true], ["claude", false]] as const) {
  for (const boundary of ["measurement", "pre-authorize", "admission", "capture", "release", "scope"] as const) {
    if (!scoped && boundary === "scope") continue;
    for (const change of boundary === "measurement" || boundary === "pre-authorize" ? ["conversation-turn"] as const
      : ["none", "held", "dead-owner", "publication", "entry missing", "process identity", "pid", "claimEpoch", "claimOwner", "writerClaimEpoch", "scope", "turn", "conversation-turn", "flags", "attention", "seat", "queue", "transcript", "moved-transcript", "replaced-transcript", "refresh-unchanged", "busy-memory", ...(boundary === "admission" ? ["seat-restored"] as const : [])] as const) {
      test(`${engine} ${scoped ? "scope" : "tree"}: central-state retirement after ${boundary}, ${change}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-lifecycle-"));
        roots.push(root);
        const script = path.join(root, "host.mjs");
        fs.writeFileSync(script, 'import { spawn } from "node:child_process"; const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); child.unref(); console.log(JSON.stringify({pid:child.pid})); setInterval(() => {}, 1000);');
        const child = ownFixtureTree(spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
        children.push(child);
        child.unref();
        const report = await fixtureReport<{ pid: number }>(child, "retirement host", [], 4_000);
        const identity = captureProcessIdentity(child.pid!);
        identities.push(identity);
        const descendant = captureProcessIdentity(report.pid);
        expect(descendant.startIdentity).not.toBeNull();
        const tree = [identity.pid, descendant.pid];
        identities.push(descendant);
        const owner = change === "held" ? captureProcessIdentity(process.pid) : change === "dead-owner"
          ? { pid: 2_147_483_647, startIdentity: "fixture-dead-owner", bootEpoch: identity.bootEpoch } : null;
        const file = fixtureRegistry(root, engine, identity, owner);
        const entry = file.entries[`${engine}:${FIXTURE_SESSION}`]!;
        entry.structuredHostOperationId = null;
        entry.structuredHost!.activeTurnRef = null;
        entry.status = "idle";
        if (scoped) entry.structuredHost!.scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: identity.bootEpoch ?? null };
        const records = fixtureRecords(engine);
        fs.writeFileSync(entry.artifactPath!, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
        const now = FIXTURE_NOW + 24 * 3_600_000;
        fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
        const filename = path.join(root, "registry.json");
        fs.writeFileSync(filename, JSON.stringify(file));
        const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
        setAgentRegistryForTests(registry);
        let released = 0;
        let changed = false;
        let signalsAtChange = 0;
        const holds = spyOn(delivery, "hasStructuredDeliveryHost").mockImplementation(() => change === "held");
        const service = new AgentStateService({ registry, now: () => now, owns: () => true,
          process: value => procBackend.pidAlive(value.pid) ? "alive" : "dead", memory: () => change === "held" && !released ? { activeTurnRef: null, pendingAttention: [], eventCursor: 0 } : null,
          release: "fixture", publish: async () => true });
        await service.request();
        const unexpectedHostCall = () => { throw new Error("unexpected busy fixture host operation"); };
        const busyHost: EngineHost = {
          attach: unexpectedHostCall, send: unexpectedHostCall, interrupt: unexpectedHostCall,
          answer: unexpectedHostCall, health: unexpectedHostCall, release: unexpectedHostCall,
          agentStateMemory: () => ({ activeTurnRef: "reopened-turn", pendingAttention: [], eventCursor: 0 }),
        };
        const host = spyOn(delivery, "structuredDeliveryHostForConversation").mockImplementation(() =>
          changed && change === "busy-memory" ? busyHost : null);
        const mutate = () => {
          changed = true;
          signalsAtChange = signals.length;
          if (change === "conversation-turn") {
            const before = entryRevision(registry.hostEntry(entry.key)!);
            registry.reconcileConversations([{ engine, accountId: null, path: entry.artifactPath!,
              launchProfile: Object.values(file.conversations)[0]!.generations[0]!.launchProfile,
              turn: { state: "busy", source: "lifecycle", terminalAt: null },
              observedAt: new Date(now + 1).toISOString() }]);
            expect(entryRevision(registry.hostEntry(entry.key)!)).toBe(before);
            expect(Object.values(registry.readOnlySnapshot().conversations)[0]!.turn).toMatchObject({
              state: "busy", source: "lifecycle", terminalAt: null,
            });
            return;
          }
          registry.agentStateWrite(state => {
            const current = state.entries[`${engine}:${FIXTURE_SESSION}`]!;
            if (change === "moved-transcript" || change === "replaced-transcript") {
              const moved = path.join(root, "moved.jsonl");
              fs.copyFileSync(current.artifactPath!, moved);
              fs.utimesSync(moved, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
              if (change === "replaced-transcript") fs.renameSync(moved, current.artifactPath!);
              else {
                current.artifactPath = moved;
                for (const row of Object.values(state.conversations)) for (const generation of row.generations)
                  if (generation.id === FIXTURE_SESSION) generation.path = moved;
              }
            }
            if (change === "entry missing") delete state.entries[`${engine}:${FIXTURE_SESSION}`];
            if (change === "pid") current.structuredHost!.process!.pid = 2_147_483_647;
            if (change === "process identity") current.structuredHost!.process!.startIdentity = "replacement";
            if (change === "claimEpoch") current.claimEpoch++;
            if (change === "claimOwner") current.claimOwner = "replacement-owner";
            if (change === "writerClaimEpoch") current.structuredHost!.writerClaimEpoch++;
            if (change === "scope") current.structuredHost!.scope = { unit: "delegatus-agent-replacement.scope", bootEpoch: identity.bootEpoch ?? null };
            if (change === "turn") current.structuredHost!.activeTurnRef = "reopened-turn";
            if (change === "flags") current.structuredHost!.activeFlags = ["live-work"];
            if (change === "attention") current.structuredHost!.pendingAttention = ["question"];
          });
          if (change === "transcript") fs.appendFileSync(entry.artifactPath!, JSON.stringify(records.open[0]) + "\n");
        };
        const refresh = async () => {
          if (["moved-transcript", "replaced-transcript", "refresh-unchanged"].includes(change)) {
            await service.reconcile(registry.hostEntry(entry.key)!);
            expect(registry.readOnlySnapshot().agentStates?.[subjectId(entry)]?.facts.revision)
              .toBe(entryRevision(registry.hostEntry(entry.key)!));
          }
        };
        const admit = registry.deliveryWriteOrBusy.bind(registry);
        const admission = spyOn(registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, write) => {
          if (boundary === "admission" && correlation.label === "registry.idle-stop-capture") {
            await Promise.resolve();
            mutate();
            await refresh();
          }
          return admit(correlation, write);
        });
        const outcomes: control.StructuredHostTerminationOutcome[] = [];
        const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
        let snapshotReads = 0;
        const terminate = spyOn(control, "terminateStructuredHostTree").mockImplementation(async (ref, dependencies) => {
          const outcome = await originalTerminate(ref, { ...dependencies,
            // Isolate the two revision changes. The capture case uses the real durable capture.
            persistCapturedTree: async identities => {
              const accepted = await dependencies!.persistCapturedTree!(identities);
              if (!accepted && change === "seat-restored") changed = false;
              if (boundary === "capture") { mutate(); await refresh(); }
              return accepted;
            },
            terminateOwnedHost: async () => {
              released++;
              if (boundary === "release") { mutate(); await refresh(); }
              return true;
            },
            stopScope: async (_scope, options) => {
              await options.authorizeAsync?.();
              if (boundary === "scope") { mutate(); await refresh(); }
              options.authorize();
            },
            signal: (pid, signal) => { signals.push({ pid, signal }); process.kill(pid, signal); },
            graceMs: 50, deadlineMs: 2000,
          });
          outcomes.push(outcome);
          return outcome;
        });
        try {
          const report = await runStructuredHostRetirementSweep({
            snapshot: () => {
              // Planning and the post-measurement eligibility check see the
              // original turn. Reopen on the first read after that check.
              if (++snapshotReads === 3 && boundary === "pre-authorize") mutate();
              return registry.readOnlySnapshot();
            }, requireAgentState: true,
            publicationState: () => changed && change === "publication" ? "unbound" : "ready", now: () => now,
            handoffRows: () => determined([]), durableEventTail: () => determined(changed && change === "queue" ? 1 : 0),
            realtimeBound: () => determined(false),
            orchestratorSeatConversations: () => determined(new Set<string>(changed && ["seat", "seat-restored"].includes(change) ? Object.keys(file.conversations) : [])),
            revokedSeatConversations: () => determined(new Set<string>()),
            readCursor: () => null, writeCursor: () => {}, record: () => {},
            treePss: async () => {
              await Promise.resolve();
              if (boundary === "measurement") mutate();
              return { bytes: null, measuredProcesses: 0 };
            }, graceMs: 50,
          });
          if (boundary === "measurement") {
            expect(changed).toBe(true);
            expect(report.retired).toEqual([]);
            expect(report.failed).toEqual([]);
            expect(report.refused).toMatchObject([{ clause: "turn-settled", reason: "conversation turn changed", changed: true }]);
            expect(outcomes).toEqual([]);
            expect(released).toBe(0);
            expect(signals).toEqual([]);
            expect(tree.every(pid => procBackend.pidAlive(pid))).toBe(true);
            return;
          }
          if (change !== "none" && change !== "held" && change !== "dead-owner" && change !== "refresh-unchanged") {
            expect(report.retired).toEqual([]);
            if (boundary === "scope" && change === "claimOwner") {
              expect(report.failed).toEqual([]);
              expect(report.refused).toMatchObject([{ clause: "process-identity", changed: true,
                reason: "scope retirement target changed: claimOwner" }]);
              expect(outcomes[0]).toMatchObject({ ok: false, status: 409,
                error: "scope retirement target changed: claimOwner" });
              expect(registry.hostEntry(entry.key)!.claimOwner).toBe("replacement-owner");
              expect(signals).toHaveLength(signalsAtChange);
              return;
            }
            if (boundary === "scope" && ["process identity", "pid"].includes(change)) {
              expect(report.refused).toMatchObject([{ clause: "process-identity", changed: true }]);
              expect(outcomes[0]).toMatchObject({ ok: false, status: 409, error: "scope retirement target changed: process identity" });
              return;
            }
            expect(report.failed).toHaveLength(1);
            const condition = ["turn", "conversation-turn", "flags", "attention", "seat", "queue", "busy-memory", "seat-restored"].includes(change) ? "verdict" : ["transcript", "moved-transcript", "replaced-transcript"].includes(change) ? "transcript" : change === "pid" ? "process identity" : change;
            expect(report.failed[0]!.error).toContain(`scope retirement target changed: ${condition}`);
            expect(outcomes[0]!.ok).toBe(false);
            if (!outcomes[0]!.ok) expect(report.failed[0]!.error).toContain(outcomes[0]!.error);
            expect(outcomes[0]).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(condition) });
            expect(signals).toHaveLength(signalsAtChange);
            if (["moved-transcript", "replaced-transcript", "transcript"].includes(change)) expect(report.failed[0]!.error).toContain("transcript");
            if (boundary !== "scope") expect(released).toBe(["pre-authorize", "admission", "capture"].includes(boundary) ? 0 : 1);
            if (change === "conversation-turn") {
              expect(changed).toBe(true);
              expect(signals).toHaveLength(signalsAtChange);
              expect(report.failed[0]!.error).toContain("verdict turn-settled: conversation turn changed");
              expect(outcomes[0]).toMatchObject({ ok: false, status: 409,
                error: "scope retirement target changed: verdict turn-settled: conversation turn changed" });
              expect(released).toBe(["pre-authorize", "admission", "capture"].includes(boundary) ? 0 : 1);
            }
            if (boundary !== "scope") {
              expect(tree.every(pid => procBackend.pidAlive(pid))).toBe(true);
              expect(report.failed[0]!.remaining).toContain(identity.pid);
            }
            return;
          }
          expect({ failed: report.failed, outcomes, alive: tree.filter(pid => procBackend.pidAlive(pid)), released }).toMatchObject({ failed: [], released: 1 });
          expect(report.retired).toHaveLength(1);
          expect(signals.length).toBeGreaterThan(0);
          for (const pid of tree) expect(procBackend.pidAlive(pid)).toBe(false);
        } finally { terminate.mockRestore(); admission.mockRestore(); host.mockRestore(); holds.mockRestore(); service.stop(); registry.close(); }
      });
    }
  }
}
