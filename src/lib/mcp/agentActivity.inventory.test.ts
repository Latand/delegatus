import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { systemScheduler } from "@/lib/deadline";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { historyHeadlessFlows, installHistoryProjection, readHistoryProjection } from "@/lib/state/historyProjection";
import type { FileEntry } from "@/lib/types";
import { fleetRegistry, fleetRow, FLEET_NOW } from "./agentFleet.fixture";
import { viewerMcpBindings, type ViewerMcpDomainDependencies } from "./bindings";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "activity-inventory-"));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const row = fleetRow("inventory");
  const initial = fleetRegistry([row]);
  initial.version = 2;
  initial.conversations[row.conversationId!] = {
    id: row.conversationId!, engine: row.engine, projectOwnership: { project: row.project }, continuityPaths: [], abandonedContinuityPaths: [],
    providerForkPaths: [], supersededBy: null,
    generations: [{ id: row.conversationId!, path: row.transcriptPath, accountId: "account-one", launchProfile: emptyLaunchProfile(),
      createdAt: new Date(FLEET_NOW).toISOString(), archivedAt: null, historyHash: null, host: null }],
  } as never;
  const registryFile = path.join(directory, "registry.json");
  fs.writeFileSync(registryFile, JSON.stringify(initial));
  const registry = new AgentRegistry(registryFile, undefined, undefined, { sqliteMode: "sqlite" });
  cleanup.push(() => registry.close());
  setAgentRegistryForTests(registry);
  cleanup.push(() => setAgentRegistryForTests(null));
  const filename = path.join(directory, "state.sqlite");
  const db = new Database(filename);
  cleanup.push(() => db.close());
  db.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT,value_json TEXT,row_order INTEGER,PRIMARY KEY(collection,row_key))");
  db.exec("BEGIN IMMEDIATE");
  installHistoryProjection(db, directory);
  db.exec("COMMIT");
  const putFlow = () => db.query("INSERT OR REPLACE INTO state_rows VALUES ('flows','flow_inventory',?,0)").run(JSON.stringify({
    id: "flow_inventory", project: "project-one", template: "implement-review-loop", cwd: "/repo", implementerPath: "/sessions/implementer.jsonl",
    baseRef: "a".repeat(40), roles: { implementer: { engine: "claude", model: null, effort: null }, reviewer: { engine: "claude", model: null, effort: null } },
    reviewerMode: "headless", rounds: [{ reviewerPath: row.transcriptPath, reviewerConversationId: row.conversationId,
      reviewerPid: 100, reviewerIdentity: "fixture-start" }],
  }));
  putFlow();
  const pending = () => (db.query("SELECT count(*) AS n FROM history_pending").get() as { n: number }).n;
  const sources = productionLivenessSources();
  sources.now = () => FLEET_NOW;
  sources.probe = { now: () => FLEET_NOW, pidAlive: () => true, processIdentity: () => "fixture-start" };
  sources.pipelines = () => [];
  let projected = 0;
  sources.flows = Object.assign(() => [], { forLiveness: options => readHistoryProjection(connection => {
    const flows = historyHeadlessFlows(connection);
    projected += flows.length;
    return flows;
  }, { ...options, filename, collections: ["flows"] }) } satisfies Pick<NonNullable<typeof sources.flows>, "forLiveness">);
  const file = { path: row.transcriptPath, conversationId: row.conversationId, project: row.project, title: row.title,
    engine: row.engine, kind: "session", mtime: FLEET_NOW / 1000, size: 100 } as FileEntry;
  sources.selectInventory = async () => ({ entries: [file], scanned: 1, matched: 1, hostedSeen: new Set([file.path]), generation: 1,
    cacheStatus: "hit", freshScan: false, selectionMs: 0 });
  sources.describeTranscript = async () => ({ ...file, engine: "claude", mtimeMs: FLEET_NOW, sizeBytes: 100,
    conversationId: row.conversationId, activity: null, activityReason: null });
  sources.transcriptIdentity = async () => "inventory-file";
  sources.transcriptEvidence = async () => ({ turn: "busy", lastRecordTs: FLEET_NOW });
  sources.workProcesses = () => [];
  sources.readHostTurnRecord = () => ({ state: "absent" });
  let journaled = 0;
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => sources,
    refreshLifecycleJournal: () => { journaled++; return { appended: 0, skipped: 0, throttled: false }; },
  } as unknown as ViewerMcpDomainDependencies);
  let elapsed = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
  cleanup.push(() => clock.mockRestore());
  return { registry, sources, bindings, pending, putFlow, projected: () => projected, journaled: () => journaled,
    advance: (ms: number) => { elapsed += ms; } };
}

for (const args of [{}, { compact: true }]) {
  test(`compact inventory retains the 800ms answer policy (${JSON.stringify(args)})`, async () => {
    const f = fixture();
    const prepare = spyOn(f.registry, "prepareReadOnlySnapshot");
    cleanup.push(() => prepare.mockRestore());
    const select = f.sources.selectInventory!;
    f.sources.selectInventory = async (...options) => {
      const selection = await select(...options);
      f.advance(801);
      return selection;
    };
    const answer = await f.bindings.agent_activity(args);
    expect(prepare).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ evidence: "pending", unverifiedCount: 1, conversations: [{ verified: false }] });
    expect(f.pending()).toBe(0);
  });
}

test("compact cold registry exhaustion preserves pending history and refuses the read", async () => {
  const f = fixture();
  const original = f.registry.readOnlySnapshot.bind(f.registry);
  const snapshot = spyOn(f.registry, "readOnlySnapshot").mockImplementation(() => { f.advance(1_200); return original(); });
  cleanup.push(() => snapshot.mockRestore());
  await expect(f.bindings.agent_activity({})).rejects.toThrow("history projection preparation exceeded its deadline");
  expect(f.pending()).toBe(1);
  expect(f.journaled()).toBe(0);
});

for (const target of [{ conversationId: "conversation_inventory" }, { transcriptPath: "/sessions/inventory.jsonl" }, { path: "/sessions/inventory.jsonl" }]) {
  test(`full targeted reads keep their existing registry path (${JSON.stringify(target)})`, async () => {
    const f = fixture();
    const prepare = spyOn(f.registry, "prepareReadOnlySnapshot");
    const keyed = spyOn(f.registry, "livenessConversationSnapshot");
    const whole = spyOn(f.registry, "readOnlySnapshot");
    cleanup.push(() => { prepare.mockRestore(); keyed.mockRestore(); whole.mockRestore(); });
    expect(await f.bindings.agent_activity({ full: true, ...target })).toMatchObject({ count: 1 });
    expect(prepare).not.toHaveBeenCalled();
    if ("conversationId" in target) {
      expect(keyed).toHaveBeenCalledWith(target.conversationId);
      expect(whole).not.toHaveBeenCalled();
    } else expect(whole).toHaveBeenCalledTimes(1);
  });
}

for (const args of [{}, { full: true }, { compact: false }]) {
  for (const unavailable of ["stale-catalog", "pending-catalog", "unselected", "undescribed", "unreadable", "pending-evidence"] as const) {
    test(`inventory keeps ${unavailable} explicitly incomplete (${JSON.stringify(args)})`, async () => {
      const f = fixture();
      const select = f.sources.selectInventory!;
      f.sources.selectInventory = async (...options) => {
        const selected = await select(...options);
        if (unavailable === "stale-catalog") selected.cacheStatus = "stale";
        if (unavailable === "pending-catalog") selected.cacheStatus = "pending";
        if (unavailable === "unselected") selected.matched = 2;
        if (unavailable === "undescribed") { selected.entries = []; selected.hostedSeen = new Set(); }
        if (unavailable === "pending-evidence") f.advance(8_001);
        return selected;
      };
      if (unavailable === "undescribed") f.sources.describeTranscript = async () => null;
      if (unavailable === "unreadable") f.sources.transcriptEvidence = async () => null;
      const answer = await f.bindings.agent_activity(args);
      if (unavailable === "stale-catalog") expect(answer).toMatchObject({ catalog: "stale" });
      else if (unavailable === "pending-catalog") expect(answer).toMatchObject({ catalog: "pending" });
      else if (unavailable === "unselected" || unavailable === "undescribed") expect(answer).toMatchObject({ unselectedCount: 1 });
      else if (unavailable === "unreadable") {
        expect(answer).toMatchObject({ conversations: [{ verified: false, turnState: "unknown" }] });
        if (args.full || args.compact === false) expect(answer).toMatchObject({ selection: { unreadable: 1 } });
      } else {
        expect(answer).toMatchObject({ evidence: "pending", unverifiedCount: 1, conversations: [{ verified: false }] });
      }
    });
  }
}

function deadlineClock() {
  const timers = new Map<number, { fire: () => void; ms: number }>();
  let next = 0;
  const set = spyOn(systemScheduler, "setTimeout").mockImplementation((fire, ms) => {
    const id = ++next;
    timers.set(id, { fire, ms });
    return id;
  });
  const clear = spyOn(systemScheduler, "clearTimeout").mockImplementation(id => { timers.delete(id as number); });
  cleanup.push(() => { set.mockRestore(); clear.mockRestore(); });
  return {
    timers,
    expire: (last = false) => {
      const entries = [...timers.entries()];
      const [id, timer] = last ? entries.at(-1)! : entries[0]!;
      timers.delete(id);
      timer.fire();
    },
  };
}

for (const args of [{ full: true }, { compact: false }]) {
  test(`explicit full inventory prepares cooperatively before pending history (${JSON.stringify(args)})`, async () => {
    const f = fixture();
    const original = f.registry.prepareReadOnlySnapshot.bind(f.registry);
    let heartbeat = false;
    const prepare = spyOn(f.registry, "prepareReadOnlySnapshot").mockImplementation(async (...options) => {
      await new Promise<void>(resolve => setImmediate(() => { heartbeat = true; resolve(); }));
      f.advance(1_200);
      const snapshot = await original(...options);
      // A write during preparation must still be projected before answering.
      f.putFlow();
      return snapshot;
    });
    const synchronous = f.registry.readOnlySnapshot.bind(f.registry);
    const sync = spyOn(f.registry, "readOnlySnapshot").mockImplementation(() => { f.advance(1_200); return synchronous(); });
    cleanup.push(() => { prepare.mockRestore(); sync.mockRestore(); });
    expect(f.pending()).toBe(1);
    const answer = await f.bindings.agent_activity({ ...args, liveOnly: true });
    expect(heartbeat).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    expect(f.pending()).toBe(0);
    expect(f.projected()).toBe(1);
    expect(answer).toMatchObject({ count: 1, unselectedCount: 0, selection: { budget: "complete", recoveryPending: 0 },
      conversations: [{ verified: true, evidenceSource: "transcript", host: { state: "alive" } }] });
    expect(answer).not.toHaveProperty("evidence");
    expect(answer).not.toHaveProperty("catalog");
  });
}

for (const end of ["cancel", "caller-deadline", "inventory-deadline", "preparation-deadline"] as const) {
  test(`full inventory ${end} stops real preparation and releases its lifetime`, async () => {
    const f = fixture();
    const clock = deadlineClock();
    const now = spyOn(Date, "now").mockReturnValue(FLEET_NOW);
    cleanup.push(() => now.mockRestore());
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    cleanup.push(() => { added.mockRestore(); removed.mockRestore(); });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let cleaned = false;
    const original = f.registry.prepareReadOnlySnapshot.bind(f.registry);
    const preparation = spyOn(f.registry, "prepareReadOnlySnapshot").mockImplementation(async (...options) => {
      try {
        const work = original(...options);
        started();
        return await work;
      } finally { cleaned = true; }
    });
    cleanup.push(() => preparation.mockRestore());
    const read = f.bindings.agent_activity({ full: true }, {
      signal: controller.signal,
      ...(end === "caller-deadline" ? { deadlineAt: FLEET_NOW + 300 } : {}),
    });
    const outcome = read.then(value => ({ value }), error => ({ error }));
    await ready;
    expect(clock.timers.size).toBe(2);
    expect([...clock.timers.values()].map(timer => timer.ms)).toEqual(end === "caller-deadline" ? [300, 300] : [8_000, 8_000]);
    if (end === "cancel") controller.abort(new Error("caller left"));
    else clock.expire(end === "preparation-deadline");
    expect(await outcome).toMatchObject({ error: { message: end === "cancel" ? "caller left"
      : end === "preparation-deadline" ? "full inventory registry preparation exceeded its deadline" : "agent_activity full inventory deadline exceeded" } });
    expect(cleaned).toBe(true);
    expect(clock.timers.size).toBe(0);
    expect(removed.mock.calls.filter(call => call[0] === "abort").map(call => call[1]))
      .toEqual(added.mock.calls.filter(call => call[0] === "abort").map(call => call[1]));
    expect(f.pending()).toBe(1);
    expect(f.projected()).toBe(0);
    expect(f.journaled()).toBe(0);
    // A cancelled owner leaves the same registry usable by a subsequent read.
    expect(await f.bindings.agent_activity({ full: true })).toMatchObject({ count: 1 });
    expect(f.pending()).toBe(0);
    expect(clock.timers.size).toBe(0);
  });
}

test("cancellation as registry preparation returns prevents history and journal work", async () => {
  const f = fixture();
  const controller = new AbortController();
  const prepare = f.sources.prepareRegistrySnapshot!;
  f.sources.prepareRegistrySnapshot = async signal => {
    const snapshot = await prepare(signal);
    controller.abort(new Error("caller revoked after preparation"));
    return snapshot;
  };
  const outcome = await f.bindings.agent_activity({ full: true }, { signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  expect(outcome).toMatchObject({ error: { message: "caller revoked after preparation" } });
  expect(f.pending()).toBe(1);
  expect(f.projected()).toBe(0);
  expect(f.journaled()).toBe(0);
});

test("registry preparation refusal preserves its reason without a synchronous fallback", async () => {
  const f = fixture();
  const prepare = spyOn(f.registry, "prepareReadOnlySnapshot").mockRejectedValue(new Error("registry view unavailable"));
  const synchronous = spyOn(f.registry, "readOnlySnapshot");
  cleanup.push(() => { prepare.mockRestore(); synchronous.mockRestore(); });
  await expect(f.bindings.agent_activity({ full: true })).rejects.toThrow("registry view unavailable");
  expect(synchronous).not.toHaveBeenCalled();
  expect(f.pending()).toBe(1);
  expect(f.projected()).toBe(0);
  expect(f.journaled()).toBe(0);
});
