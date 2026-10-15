import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";

import { AgentRegistry, type AgentRegistrySqliteMode, type SpawnLauncher } from "@/lib/agent/registry";
import { failedLaunchRepairQuery } from "@/lib/agent/sqliteRegistryStore";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { claimPass, patchPass, readPass } from "@/lib/memory/curation/store";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { emptySeatTickState } from "@/lib/monitor/types";
import { writeSeatTickState } from "@/lib/monitor/seatTickState";
import { appendLifecycleEvents, lifecycleJournalPath, queryLifecycleEvents, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { pruneSpawnNotices, readSpawnNoticeTurn, settleSpawnNotices } from "@/lib/spawnNotice/store";
import { LAUNCH_FAILURE_NOTICE_WINDOW_MS } from "@/lib/tasks/launchFailureReporting";
import { closeStateMutationActivationForTests, openStateMutationActivation, stateMutationRefusal } from "@/lib/state/stateMutationBarrier";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import {
  ADMISSION_RETRY_DEADLINE_MS,
  STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
  recoverPendingStructuredSpawns,
  reconcileStructuredSpawnReplay,
  spawnStructuredConversation,
  terminalizeStaleStructuredSpawns,
} from "./structuredSpawn";

const DEAD_RUNTIME_CLIENT = {
  operationStatus: async () => null,
  snapshot: async () => ({ revision: 0, sessions: [] }),
  effectBatch: async () => [],
} as unknown as RuntimeHostClient;

function registry(sqliteMode: AgentRegistrySqliteMode = "off"): AgentRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminalize-"));
  return new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode });
}

function staleStructuredReceipt(store: AgentRegistry, attempt: string, launcher?: SpawnLauncher) {
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: attempt,
    requestDigest: "d".repeat(64),
    launcher,
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  return begun.receipt;
}

function stagedStructuredReceipt(store: AgentRegistry, attempt: string) {
  const receipt = staleStructuredReceipt(store, attempt);
  const key = { engine: "codex" as const, sessionId: `session-${attempt}` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live",
      process: { pid: process.pid, startIdentity: `host-${attempt}` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${attempt}`,
    pendingAction: "spawn",
  });
  return { receipt, key };
}

const AGED = () => Date.now() + STALE_STRUCTURED_SPAWN_TIMEOUT_MS + 60_000;
const originalStateDir = process.env.LLV_STATE_DIR;

for (const cutoff of ["abort", "release"] as const)
for (const boundary of ["message", "launch", "session", "snapshot", "effect", "effect-page"] as const)
test(`recovery cancellation at ${boundary} evidence preserves the launch and host (${cutoff})`, async () => {
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `cancel-${boundary}-${cutoff}`);
  store.holdDelivery(receipt.conversationId, "Original instruction", `spawn_${receipt.launchId}`, "text");
  const before = structuredClone(store.readOnlySnapshot());
  const cancellation = new AbortController();
  let active = true;
  let entered!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<void>(resolve => { resume = resolve; });
  const heldRead = async <T>(value: T): Promise<T> => {
    entered();
    await response;
    // Some readers answer after retirement; others reject their aborted RPC.
    if (cutoff === "abort") throw new Error("runtime host request cancelled");
    return value;
  };
  let effects = 0;
  let cleanups = 0;
  const client = {
    ...DEAD_RUNTIME_CLIENT,
    operationStatus: async (id: string) => (boundary === "message" && id.startsWith("spawn_message_"))
      || (boundary === "launch" && id === receipt.launchId) ? heldRead(null) : null,
    ...(boundary !== "snapshot" ? { readSession: async () => boundary === "session" ? heldRead(null) : null } : {}),
    snapshot: async () => boundary === "snapshot" ? heldRead({ sessions: [] }) : { sessions: [] },
    effectBatch: async () => {
      effects++;
      if (boundary === "effect") return heldRead([]);
      if (boundary === "effect-page") return effects === 1
        ? Array.from({ length: 100 }, (_, i) => ({ eventSeq: i + 1, payload: {} })) : heldRead([]);
      return [];
    },
  } as unknown as RuntimeHostClient;
  const work = reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED, signal: cancellation.signal,
    assertActive: () => { if (!active) throw Error("release retired"); },
    releaseHost: async () => { cleanups++; return true; },
    terminateHostProcess: async () => { cleanups++; return true; },
  }).then(() => null, error => error);
  try {
    await Promise.race([reading, work.then(() => { throw Error("recovery ended before evidence read"); })]);
    if (cutoff === "abort") cancellation.abort(Error("release retired"));
    else active = false;
    resume();
    expect((await work)?.message).toBe("release retired");
    const after = store.readOnlySnapshot();
    expect(after.receipts[receipt.launchId]).toEqual(before.receipts[receipt.launchId]);
    expect(after.heldDeliveries).toEqual(before.heldDeliveries);
    expect(after.entries[`codex:${key.sessionId}`]).toEqual(before.entries[`codex:${key.sessionId}`]);
    expect(cleanups).toBe(0);
    const artifactPath = before.receipts[receipt.launchId]!.artifactPath!;
    fs.writeFileSync(artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Original instruction" } }) + "\n");
    expect(await reconcileStructuredSpawnReplay(receipt.launchId, store, DEAD_RUNTIME_CLIENT, { now: AGED }))
      .toMatchObject({ launchId: receipt.launchId, conversationId: receipt.conversationId, state: "completed" });
  } finally { resume(); await work; store.close(); }
});

test.each(["abort", "release"] as const)("terminal recovery rechecks %s after a peer-held registry lock", async cutoff => {
  const store = registry("sqlite");
  const { receipt, key } = stagedStructuredReceipt(store, `terminal-cancel-${cutoff}`);
  store.holdDelivery(receipt.conversationId, "Original instruction", `spawn_${receipt.launchId}`, "text");
  const before = structuredClone(store.readOnlySnapshot());
  const peer = new Database(path.join(path.dirname(store.filename), "agent-registry.sqlite"));
  const cancellation = new AbortController();
  let active = true;
  let locked = false;
  let timerAdvanced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanups = 0;
  try {
    const outcome = await reconcileStructuredSpawnReplay(receipt.launchId, store, {
      ...DEAD_RUNTIME_CLIENT,
      effectBatch: async () => {
        peer.exec("BEGIN IMMEDIATE"); locked = true;
        timer = setTimeout(() => {
          timerAdvanced = true;
          if (cutoff === "abort") cancellation.abort(Error("release retired"));
          else active = false;
          peer.exec("ROLLBACK"); locked = false;
        }, 100);
        return [];
      },
    }, {
      now: AGED, signal: cancellation.signal,
      assertActive: () => { if (!active) throw Error("release retired"); },
      releaseHost: async () => { cleanups++; return true; },
    }).then(() => null, error => error);
    expect(outcome?.message).toBe("release retired");
    expect(timerAdvanced).toBe(true);
    expect(cleanups).toBe(0);
    const after = store.readOnlySnapshot();
    expect(after.receipts[receipt.launchId]).toEqual(before.receipts[receipt.launchId]);
    expect(after.heldDeliveries).toEqual(before.heldDeliveries);
    expect(after.entries[`codex:${key.sessionId}`]).toEqual(before.entries[`codex:${key.sessionId}`]);
  } finally {
    clearTimeout(timer);
    if (locked) peer.exec("ROLLBACK");
    peer.close(); store.close();
  }
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
});

test.each(["starting", "host-verified"] as const)("an abandoned transport-null %s receipt terminalizes without losing its replay identity", async state => {
  const store = registry();
  const receipt = store.beginSpawn("codex", "/repo", { title: "Legacy abandoned launch" });
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  raw.receipts[receipt.launchId].state = state;
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(reopened.snapshot().receipts[receipt.launchId]?.transport).toBeNull();
  const result = await terminalizeStaleStructuredSpawns(reopened, DEAD_RUNTIME_CLIENT, { now: AGED });
  expect(result.terminalized).toEqual([receipt.launchId]);
  expect(reopened.snapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", conversationId: receipt.conversationId });
  expect(await terminalizeStaleStructuredSpawns(reopened, DEAD_RUNTIME_CLIENT, { now: AGED }))
    .toEqual({ examined: 0, terminalized: [], recovered: [] });
});

test.each(["operation","effect","session","unavailable","young"] as const)("a transport-null launch preserves %s evidence", async evidence => {
  const store = registry();
  const receipt = store.beginSpawn("codex","/repo",{ title: "Preserved legacy launch" });
  const client = { ...DEAD_RUNTIME_CLIENT,
    operationStatus: async () => {
      if (evidence === "unavailable") throw new RuntimeHostUnavailableError("fixture unavailable");
      return evidence === "operation" ? { receipt: { status: "pending" } } : null;
    },
    effectBatch: async () => evidence === "effect" ? [{ eventSeq: 1,payload: { operationId: receipt.launchId } }] : [],
    snapshot: async () => ({ revision: 0,sessions: evidence === "session" ? [{ conversationId: receipt.conversationId }] : [] }),
  } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(store,client,{ now: evidence === "young" ? Date.now : AGED });
  expect(result.terminalized).toEqual([]);
  expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("starting");
});

test("transport-null cleanup rechecks foreground settlement after its asynchronous evidence reads", async () => {
  const store = registry();
  const receipt = store.beginSpawn("codex","/repo",{ title: "Foreground settlement race" });
  const client = { ...DEAD_RUNTIME_CLIENT,operationStatus: async () => {
    const raw = JSON.parse(fs.readFileSync(store.filename,"utf8"));
    raw.receipts[receipt.launchId].state = "completed";
    fs.writeFileSync(store.filename,JSON.stringify(raw));
    return null;
  } } as unknown as RuntimeHostClient;
  expect((await terminalizeStaleStructuredSpawns(store,client,{ now: AGED })).terminalized).toEqual([]);
  expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("completed");
});

test("orphan starting entries converge after the grace while receipt and claim evidence stay intact", async () => {
  const store = registry();
  for (const name of ["orphan","receipt","claim","operation","young"]) {
    store.upsert({ key: { engine: "codex",sessionId: `orphan-${name}` },artifactPath: `/sessions/orphan-${name}.jsonl`,cwd: "/repo",accountId: null,
      status: "starting",host: null,claimEpoch: 0,claimOwner: name === "claim" ? "fixture-owner" : null,pendingAction: "spawn" });
  }
  const receipt = store.beginSpawn("codex","/repo",{ title: "Correlated starting launch" });
  const raw = JSON.parse(fs.readFileSync(store.filename,"utf8"));
  raw.receipts[receipt.launchId].artifactPath = "/sessions/orphan-receipt.jsonl";
  raw.entries["codex:orphan-operation"].structuredHostOperationId = "fixture-operation";
  raw.entries["codex:orphan-young"].updatedAt = new Date(AGED()).toISOString();
  fs.writeFileSync(store.filename,JSON.stringify(raw));
  await terminalizeStaleStructuredSpawns(store,null,{ now: AGED });
  const snapshot = store.snapshot();
  expect(snapshot.entries["codex:orphan-orphan"]).toMatchObject({ status: "dead",pendingAction: null });
  for (const name of ["receipt","claim","operation","young"]) expect(snapshot.entries[`codex:orphan-${name}`]?.status).toBe("starting");
});

test("a runtime-host transport failure becomes actionable on the structured spawn card", async () => {
  const store = registry();
  const cwd = path.dirname(store.filename);
  const launchProfile = emptyLaunchProfile({ title: "Stale launch fixture", cwd });
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "work",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  let admissionAttempts = 0;
  let clock = 0;
  const unavailableClient = {
    command: async () => {
      admissionAttempts += 1;
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    transitionOperation: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
  } as unknown as RuntimeHostClient;

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "runtime-host-card", engine: "codex", launchProfile },
    account: { engine: "codex", accountId: "work", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    ["prompt"]: "run",
    registry: store,
    client: unavailableClient,
  }, {
    startHost: async () => { throw new Error("runtime admission must precede host start"); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  })).rejects.toThrow("runtime host request timed out");

  /* Admission retries until its deadline (#2058), then gives up. */
  expect(admissionAttempts).toBeGreaterThan(3);
  expect(clock).toBeLessThanOrEqual(ADMISSION_RETRY_DEADLINE_MS);
  const failed = store.snapshot().receipts[begun.receipt.launchId];
  if (!failed) throw new Error("failed structured spawn receipt was unavailable");
  const actionableFailure = "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
  expect(failed).toMatchObject({ state: "failed", error: actionableFailure });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    initialMessage: "failed",
    retrySafe: true,
    error: actionableFailure,
  });
});

test("a stale dead-evidence structured launch converges to durable retry-safe failed exactly once", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "stale_20260719_a1");
  const before = store.snapshot();
  const receiptCount = Object.keys(before.receipts).length;
  const conversationCount = Object.keys(before.conversations).length;

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(first.examined).toBe(1);
  expect(first.terminalized).toEqual([receipt.launchId]);
  expect(first.recovered).toEqual([]);

  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain("no session");
  expect(failed.conversationId).toBe(receipt.conversationId);

  /* Idempotence: a second pass is a no-op — terminal receipts are skipped. */
  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(second).toEqual({ examined: 0, terminalized: [], recovered: [] });

  /* No-loss: no receipt or conversation row is ever deleted by convergence. */
  const after = store.snapshot();
  expect(Object.keys(after.receipts)).toHaveLength(receiptCount);
  expect(Object.keys(after.conversations)).toHaveLength(conversationCount);
});

test.each(["off", "sqlite"] as const)("a refused pre-acceptance launch stays silent after %s registry restart and repeated repair sweeps", async sqliteMode => {
  const store = registry(sqliteMode);
  const receipt = staleStructuredReceipt(store, "silent-refusal-20261014", { conversationId: "conversation_refusing_launcher", notify: true });
  expect(store.failStructuredSpawn(receipt.launchId, "launch refused before acceptance", { announce: false }).claimed).toBe(true);
  expect(store.snapshot().receipts[receipt.launchId]?.failureAnnouncementSuppressed).toBe(true);

  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode });
  await terminalizeStaleStructuredSpawns(reopened, null, { now: AGED });
  await terminalizeStaleStructuredSpawns(reopened, null, { now: AGED });

  expect(queryLifecycleEvents({ type: "spawn_failed" }).events.filter(event => event.conversationId === receipt.conversationId)).toEqual([]);
  expect(readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`)).toBeNull();
});

test("an old failed receipt with no report rows stays silent on restart and repeated passes", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "historical-unreported", { conversationId: "conversation_old_launcher", notify: true });
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  Object.assign(raw.receipts[receipt.launchId], { state: "failed", error: "runtime host request timed out", createdAt: "2026-10-01T12:00:00.000Z" });
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  await terminalizeStaleStructuredSpawns(reopened, null);
  await terminalizeStaleStructuredSpawns(reopened, null);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId, type: "spawn_failed" }).events).toEqual([]);
  expect(readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`)).toBeNull();
  expect(reopened.snapshot().receipts[receipt.launchId]?.failureAnnouncementSuppressed).toBe(true);
});

test.each(["fresh", "boundary", "expired"] as const)("a current receipt with a %s failure uses the failure time and age bound", async age => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, `failure-age-${age}`, { conversationId: "conversation_age_launcher", notify: true });
  const now = Date.now();
  const failedAt = new Date(now - (age === "fresh" ? 1_000 : LAUNCH_FAILURE_NOTICE_WINDOW_MS + (age === "expired" ? 1 : 0))).toISOString();
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  Object.assign(raw.receipts[receipt.launchId], { state: "failed", error: "host lost", failureRepairState: "pending",
    failureReporting: { failedAt, lifecycle: false, notice: false, task: false } });
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  await terminalizeStaleStructuredSpawns(reopened, null, { now: () => now });
  const events = queryLifecycleEvents({ conversationId: receipt.conversationId, type: "spawn_failed" }).events;
  const notice = readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`);
  expect(events).toHaveLength(age === "expired" ? 0 : 1);
  if (age === "expired") expect(notice).toBeNull();
  else {
    expect(events[0]?.at).toBe(failedAt);
    expect(notice?.endedAt).toBe(failedAt);
  }
  expect(reopened.spawnReceipt(receipt.launchId)?.failureRepairState).toBe("handled");
});

test("a bounded silent backfill converges archived historical failures without reporting", async () => {
  const store = registry();
  const base = staleStructuredReceipt(store, "backfill-seed", { conversationId: "conversation_backfill_launcher", notify: true });
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  raw.receipts = Object.fromEntries(Array.from({ length: 140 }, (_, index) => {
    const row = { ...raw.receipts[base.launchId], launchId: `historical-${index}`, clientAttemptId: `old-${index}`,
      state: "failed", createdAt: "2026-10-01T12:00:00.000Z", error: "old refusal" };
    delete row.failureReporting;
    return [row.launchId, row];
  }));
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  let receiptReads = 0;
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "sqlite",
    onSqliteRowPayloadRead: (collection, count) => { if (collection === "receipts") receiptReads += count; } });
  expect(Object.values(reopened.snapshot().receipts).filter(row => row.failureAnnouncementSuppressed)).toHaveLength(0);
  await terminalizeStaleStructuredSpawns(reopened, null, { actuationCap: 64 });
  expect(Object.values(reopened.snapshot().receipts).filter(row => row.failureAnnouncementSuppressed)).toHaveLength(64);
  expect(reopened.archiveInactiveRows(256)).toBeGreaterThan(0);
  const db = new Database(store.filename.replace(/\.json$/, ".sqlite"), { readonly: true });
  try {
    for (const legacy of [true, false]) {
      const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${failedLaunchRepairQuery(legacy)}`).all(3).map(row => row.detail).join("\n");
      expect(plan).toContain("USING INDEX registry_rows_failure_repair");
      expect(plan).not.toContain("USE TEMP B-TREE");
      expect(plan).not.toContain("SCAN");
    }
  } finally { db.close(); }
  expect(reopened.backfillFailedLaunchReporting(3)).toBe(3);
  expect(reopened.failedSpawnReceipts(2)).toHaveLength(2);
  for (let pass = 0; pass < 5; pass++) await terminalizeStaleStructuredSpawns(reopened, null);
  expect(reopened.backfillFailedLaunchReporting(3)).toBe(0);
  expect(Object.values(reopened.snapshot().receipts).filter(row => row.failureRepairState === "handled")).toHaveLength(140);
  receiptReads = 0;
  for (let pass = 0; pass < 3; pass++) {
    expect(reopened.backfillFailedLaunchReporting(3)).toBe(0);
    expect(reopened.failedSpawnReceipts(2)).toEqual([]);
  }
  expect(receiptReads).toBe(0);
  expect(queryLifecycleEvents({ conversationId: base.conversationId, type: "spawn_failed" }).events).toEqual([]);
  expect(readSpawnNoticeTurn(base.conversationId, `launch:${base.launchId}`)).toBeNull();
});

test("a reader without the release fence cannot backfill operator-shaped state", () => {
  const store = registry();
  const previousHome = process.env.HOME;
  const previousOwner = process.env.LLV_STATE_OWNER;
  const operatorHome = path.join(path.parse(os.tmpdir()).root, "fixture-operator");
  try {
    process.env.HOME = operatorHome;
    process.env.LLV_STATE_OWNER = "mcp";
    Object.defineProperty(store, "filename", { value: path.join(operatorHome, ".config", "delegatus", "state", "agent-registry.json") });
    expect(() => store.backfillFailedLaunchReporting()).toThrow("failed launch announcement backfill");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = previousOwner;
  }
});

test("failure backfill waits for activation and stops when the Viewer loses traffic", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-backfill-fence-"));
  const directory = path.join(sandbox, "config", "delegatus", "state");
  const previous = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    LLV_STATE_OWNER: process.env.LLV_STATE_OWNER, PORT: process.env.PORT };
  try {
    process.env.LLV_STATE_DIR = directory;
    const store = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const base = staleStructuredReceipt(store, "fence-seed", { conversationId: "conversation_fence_launcher", notify: true });
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
    raw.receipts = Object.fromEntries(Array.from({ length: 70 }, (_, index) => {
      const row = { ...raw.receipts[base.launchId], launchId: `fenced-${index}`, clientAttemptId: `fenced-attempt-${index}`,
        state: "failed", error: "historical refusal" };
      delete row.failureReporting;
      return [row.launchId, row];
    }));
    fs.writeFileSync(store.filename, JSON.stringify(raw));
    const target = path.join(directory, "viewer-release.json");
    fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:32101" }));
    process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
    delete process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_OWNER = "viewer";
    process.env.PORT = "32102";
    closeStateMutationActivationForTests();
    expect(viewerReleaseOwnsTraffic()).toBe(false);
    expect(stateMutationRefusal(directory)).not.toBeNull();
    const before = JSON.parse(fs.readFileSync(store.filename, "utf8"));
    const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
    expect(JSON.parse(fs.readFileSync(store.filename, "utf8"))).toEqual(before);
    expect(() => reopened.backfillFailedLaunchReporting()).toThrow();
    process.env.LLV_STATE_OWNER = "mcp";
    new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
    expect(JSON.parse(fs.readFileSync(store.filename, "utf8"))).toEqual(before);

    process.env.LLV_STATE_OWNER = "viewer";
    process.env.PORT = "32101";
    expect(() => reopened.backfillFailedLaunchReporting()).toThrow();
    process.env.LLV_STATE_DIR = directory;
    expect(() => reopened.backfillFailedLaunchReporting()).toThrow("current Viewer release");
    delete process.env.LLV_STATE_DIR;
    openStateMutationActivation();
    await terminalizeStaleStructuredSpawns(reopened, null, { actuationCap: 64 });
    expect(Object.values(reopened.snapshot().receipts).filter(row => row.failureAnnouncementSuppressed)).toHaveLength(64);
    const activated = fs.readFileSync(store.filename, "utf8");
    fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:32102" }));
    expect(() => reopened.backfillFailedLaunchReporting()).toThrow("current Viewer release");
    expect(fs.readFileSync(store.filename, "utf8")).toBe(activated);
    expect(queryLifecycleEvents({ type: "spawn_failed" }).events.filter(row => row.conversationId === base.conversationId)).toEqual([]);
    expect(readSpawnNoticeTurn(base.conversationId, `launch:${base.launchId}`)).toBeNull();
  } finally {
    closeStateMutationActivationForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test.each(["off", "sqlite"] as const)("a fresh loss stays handled when both report lookups miss after %s restart", async sqliteMode => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-reconnect-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  const store = registry(sqliteMode);
  const receipt = staleStructuredReceipt(store, "reconnect-repass", { conversationId: "conversation_current_launcher", notify: true });
  expect(store.failStructuredSpawn(receipt.launchId, "accepted launch lost").claimed).toBe(true);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId, type: "spawn_failed" }).events).toHaveLength(1);
  const turn = `launch:${receipt.launchId}`;
  expect(readSpawnNoticeTurn(receipt.conversationId, turn)).not.toBeNull();
  settleSpawnNotices(receipt.conversationId, [turn], { state: "sent", recipientConversationId: "conversation_current_launcher", clientMessageId: "notice-fixture", operationId: null }, new Date().toISOString());
  pruneSpawnNotices(new Date(Date.now() + 1_000).toISOString());
  fs.rmSync(lifecycleJournalPath(), { force: true });
  expect(readSpawnNoticeTurn(receipt.conversationId, turn)).toBeNull();
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode });
  await terminalizeStaleStructuredSpawns(reopened, null);
  await terminalizeStaleStructuredSpawns(reopened, null);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId, type: "spawn_failed" }).events).toEqual([]);
  expect(readSpawnNoticeTurn(receipt.conversationId, turn)).toBeNull();
});

test.each(["off", "sqlite"] as const)("a reported failure does not emit another wake after journal retention and %s registry restart", async sqliteMode => {
  const store = registry(sqliteMode);
  const receipt = staleStructuredReceipt(store, "retained-failure-20261014", { conversationId: "conversation_retained_launcher", notify: true });
  expect(store.failStructuredSpawn(receipt.launchId, "accepted launch was lost").claimed).toBe(true);
  const firstSeq = readLifecycleJournal().lastSeq;
  appendLifecycleEvents(Array.from({ length: 10_001 }, (_, index) => ({
    key: `delivery:${receipt.launchId}:${index}:expired`,
    type: "delivery_expired" as const,
    at: new Date(AGED()).toISOString(),
  })));
  const afterRetention = readLifecycleJournal().lastSeq;
  expect(afterRetention).toBeGreaterThan(firstSeq);

  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode });
  await terminalizeStaleStructuredSpawns(reopened, null, { now: AGED });
  expect(readLifecycleJournal().lastSeq).toBe(afterRetention);
  expect(readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`)).not.toBeNull();
});

test("a refused first lifecycle append is repaired once by the next sweep", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "repaired-first-append-20261014", { conversationId: "conversation_repair_launcher", notify: true });
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminalize-report-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  const journalPath = lifecycleJournalPath();
  fs.mkdirSync(journalPath, { recursive: true });
  try {
    expect(store.failStructuredSpawn(receipt.launchId, "accepted launch was lost").claimed).toBe(true);
    fs.rmSync(journalPath, { recursive: true });

    const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
    await terminalizeStaleStructuredSpawns(reopened, null, { now: AGED });
    const events = queryLifecycleEvents({ type: "spawn_failed" }).events.filter(event => event.conversationId === receipt.conversationId);
    expect(events).toHaveLength(1);
    expect(readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`)).not.toBeNull();

    await terminalizeStaleStructuredSpawns(reopened, null, { now: AGED });
    expect(queryLifecycleEvents({ type: "spawn_failed" }).events.filter(event => event.conversationId === receipt.conversationId)).toHaveLength(1);
  } finally {
    process.env.LLV_STATE_DIR = originalStateDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test.each(["missing", "corrupt"] as const)("a %s queued payload cannot keep an ownerless receipt alive past the setup bound", async (condition) => {
  const store = registry();
  const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: `partial_queue_${condition}_20260824`,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo",
      title: `Pinned account quota is exhausted — queued until ${retryAt}`,
    }),
  });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw new Error("expected queued receipt creation");
  if (condition === "corrupt") {
    store.queuePinnedSpawn(begun.receipt.launchId, {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
      spec: {
        engine: "claude",
        command: "claude",
        cwd: "/repo",
        windowName: "queued-pin",
        launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
      },
      ["prompt"]: "continue",
      imageRefs: [],
      parentArtifactPath: null,
      pipelineSourceConversationId: null,
    }, `Pinned account quota is exhausted — queued until ${retryAt}`);
  }
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner);
  if (condition === "corrupt") {
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
      receipts: Record<string, { queuedPinnedSpawn?: unknown }>;
    };
    raw.receipts[begun.receipt.launchId]!.queuedPinnedSpawn = {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
    };
    fs.writeFileSync(store.filename, JSON.stringify(raw));
  }

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "starting",
    admissionOwner: null,
    queuedPinnedSpawn: null,
  });

  const result = await terminalizeStaleStructuredSpawns(restarted, DEAD_RUNTIME_CLIENT, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [begun.receipt.launchId], recovered: [] });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    queuedPinnedSpawn: null,
  });
});

test.each(["missing", "corrupt"] as const)("a %s tmux queue payload cannot keep an ownerless receipt alive past the setup bound", async (condition) => {
  const store = registry();
  const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "tmux",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: `partial_tmux_queue_${condition}_20260824`,
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected tmux receipt creation");
  if (condition === "corrupt") {
    store.queuePinnedSpawn(begun.receipt.launchId, {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
      spec: {
        engine: "claude",
        command: "claude",
        cwd: "/repo",
        windowName: "queued-pin",
        launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
      },
      ["prompt"]: "continue",
      imageRefs: [],
      parentArtifactPath: null,
      pipelineSourceConversationId: null,
    }, `Pinned account quota is exhausted — queued until ${retryAt}`);
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
      receipts: Record<string, { queuedPinnedSpawn?: unknown }>;
    };
    raw.receipts[begun.receipt.launchId]!.queuedPinnedSpawn = {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
    };
    fs.writeFileSync(store.filename, JSON.stringify(raw));
  }

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    transport: "tmux",
    state: "starting",
    admissionOwner: null,
    queuedPinnedSpawn: null,
  });

  const beforeBound = await terminalizeStaleStructuredSpawns(restarted, null, {
    now: () => Date.parse(begun.receipt.createdAt) + STALE_STRUCTURED_SPAWN_TIMEOUT_MS - 1,
  });
  expect(beforeBound).toEqual({ examined: 0, terminalized: [], recovered: [] });

  const result = await terminalizeStaleStructuredSpawns(restarted, null, { now: AGED });
  expect(result).toEqual({ examined: 1, terminalized: [begun.receipt.launchId], recovered: [] });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    admissionOwner: null,
    queuedPinnedSpawn: null,
    error: `tmux spawn interrupted before durable queue publication or pane binding: ${begun.receipt.launchId}`,
  });

  expect(await terminalizeStaleStructuredSpawns(restarted, null, { now: AGED }))
    .toEqual({ examined: 0, terminalized: [], recovered: [] });
});

test("startup recovery still terminalizes a dead non-queued ownerless receipt", async () => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: "non_queued_ownerless_20260824",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw new Error("expected ownerless receipt setup");
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner);

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const { RuntimeJournal } = await import("../../runtime-host/journal");
  const journal = new RuntimeJournal(path.join(path.dirname(store.filename), "recovery-runtime.sqlite"), { structuredHosts: true });
  try {
    await recoverPendingStructuredSpawns(restarted, { ...DEAD_RUNTIME_CLIENT, snapshot: async () => journal.snapshot() });
  } finally { journal.close(); restarted.close(); }

  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    queuedPinnedSpawn: null,
    error: `structured spawn interrupted before runtime admission: ${begun.receipt.launchId}`,
  });
});

test.each(["codex", "claude"] as const)("an overdue %s placeholder still fails when runtime effect history is unavailable", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `effect_history_outage_${engine}`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const artifactPath = path.join(path.dirname(store.filename), `${engine}-effect-outage.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine, sessionId: `${engine}-effect-outage` },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const client = {
    operationStatus: async () => null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
    effectBatch: async () => { throw new Error("runtime effect history is unavailable"); },
  } as unknown as RuntimeHostClient;

  const beforeDeadline = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: () => Date.parse(receipt.createdAt) + STALE_STRUCTURED_SPAWN_TIMEOUT_MS - 1,
  });
  expect(beforeDeadline).toMatchObject({ state: "path-pending", initialMessage: "pending", error: null });

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({
    state: "failed",
    error: expect.stringContaining("runtime effect history remained unavailable"),
  });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
});

test("a live admission owner loses an overdue deferred launch at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "live_owner_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("a terminal runtime operation preserves its reason through generic stale reconciliation", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "terminal_operation_reason");
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "failed" as const,
        reason: "synthetic terminal spawn failure",
        at: receipt.createdAt,
        revision: 2,
      },
      replayed: false,
    } : null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    error: "synthetic terminal spawn failure",
  });
});

test("a receipt younger than the pass timeout is never touched", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "fresh_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT);
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("starting");
});

test("a staged launch whose host entry stays claimed still fails at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "claimed_20260719_a1");
  const staged = store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe1" },
    artifactPath: "/sessions/019f7b8a_9f75_7dc0_b231_17f7eadd7fe1.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "worker:live",
    pendingAction: "spawn",
  });
  expect(staged.kind).toBe("settled");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("reconciliation never releases a host after concurrent spawn completion", async () => {
  const store = registry();
  const { receipt } = stagedStructuredReceipt(store, "concurrent_completion");
  let released = 0;
  let operationStatus = "queued";
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: operationStatus,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => {
      expect(store.finalizeStructuredSpawn(receipt.launchId).kind).toBe("settled");
      return { revision: 1, sessions: [] };
    },
    transitionOperation: async () => {
      operationStatus = "failed";
      throw new Error("a completed launch must not be failed");
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "completed", initialMessage: "delivered", error: null });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("completed");
  expect(operationStatus).toBe("queued");
  expect(released).toBe(0);
});

test("reconciliation preserves a newer same-key host owner", async () => {
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, "newer_same_key_owner");
  const previous = store.snapshot().entries[`codex:${key.sessionId}`]!;
  const { updatedAt: _updatedAt, ...newerEntry } = previous;
  let released = 0;
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "queued" as const,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => ({ revision: 1, sessions: [] }),
    transitionOperation: async (operationId: string) => {
      store.upsert({
        ...newerEntry,
        structuredHostOperationId: "newer-launch-operation",
        structuredHost: {
          ...newerEntry.structuredHost!,
          process: { pid: process.pid, startIdentity: "newer-host" },
        },
        claimOwner: "structured-host:newer",
      });
      return {
        operationId,
        replayed: false,
        receipt: {
          operationId,
          idempotencyKey: receipt.launchId,
          conversationId: receipt.conversationId,
          kind: "spawn" as const,
          status: "failed" as const,
          reason: "stale launch superseded",
          at: receipt.createdAt,
          revision: 2,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "failed", initialMessage: "failed" });
  expect(store.snapshot().entries[`codex:${key.sessionId}`]).toMatchObject({
    status: "idle",
    structuredHostOperationId: "newer-launch-operation",
    claimOwner: "structured-host:newer",
    structuredHost: { process: { startIdentity: "newer-host" } },
  });
  expect(released).toBe(0);
});

test("issue 533: host loss after recoverable timeout reaches retry-safe failure despite the same process staying live", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "recoverable_timeout_host_loss");
  const key = { engine: "codex" as const, sessionId: "session-timeout-host-loss" };
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath: "/sessions/timeout-host-loss.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server", endpoint: "stdio:released", process: null,
      eventCursor: 1, protocolVersion: null, writerClaimEpoch: 0,
      activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  store.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner!);

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    admissionOwner: null,
    error: expect.stringContaining("no session"),
  });
  expect(spawnResponseForReceipt(store.snapshot().receipts[receipt.launchId]!)).toMatchObject({
    state: "failed",
    retrySafe: true,
  });
});

test("issue 1074: a stale materialized launch is recovered from its late transcript on the reaper tick", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "materialized_incident_placeholder");
  const sessionId = "materialized-incident-session";
  const artifactPath = path.join(path.dirname(store.filename), `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "delayed initial message" },
  }) + "\n");
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:incident",
      process: { pid: process.pid, startIdentity: "incident-host" },
      eventCursor: 3,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:incident",
    pendingAction: "spawn",
  });
  store.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "path-pending",
    artifactLifecycle: "materialized",
  });

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [], recovered: [receipt.launchId] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "completed",
    artifactLifecycle: "materialized",
    completionMode: "route-recovered",
    error: null,
  });
});

test.each(["codex", "claude"] as const)("issue 1074: a stale %s registering host fails at the generic setup bound", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `registering_${engine}_incident`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const key = { engine, sessionId: `${engine}-registering-session` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:registering",
      process: { pid: process.pid, startIdentity: `${engine}-incident-host` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}-incident`,
    pendingAction: "spawn",
  });
  let operationStatus = "queued";
  let operationReason: string | null = null;
  let released = 0;
  const terminated: Array<{ pid: number; startIdentity: string | null }> = [];
  const operationResult = () => ({
    operationId: receipt.launchId,
    replayed: false,
    receipt: {
      operationId: receipt.launchId,
      idempotencyKey: receipt.launchId,
      conversationId: receipt.conversationId,
      kind: "spawn" as const,
      status: operationStatus,
      reason: operationReason,
      at: receipt.createdAt,
      revision: operationStatus === "queued" ? 1 : 2,
    },
  });
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? operationResult() : null,
    transitionOperation: async (_operationId: string, status: string, details?: { reason?: string | null }) => {
      operationStatus = status;
      operationReason = details?.reason ?? null;
      return operationResult();
    },
    snapshot: async () => ({
      sessions: [{
        conversationId: receipt.conversationId,
        sessionKey: key,
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: "registering",
        turn: "idle",
        provenance: "structured",
        revision: 1,
        attentionIds: [],
        recentReceipts: [],
        accountId: "work",
        parentConversationId: null,
        cwd: "/repo",
        artifactPath,
        capabilities: { steer: engine === "codex", structuredAttention: true },
        activeTurnId: null,
      }],
    }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, {
    now: AGED,
    reconcile: (launchId, registry, runtimeClient, options) => reconcileStructuredSpawnReplay(
      launchId,
      registry,
      runtimeClient,
      {
        ...options,
        releaseHost: async () => {
          released += 1;
          return false;
        },
        terminateHostProcess: async (expected) => {
          terminated.push(expected);
          return true;
        },
      },
    ),
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(released).toBe(1);
  expect(terminated).toEqual([{ pid: process.pid, startIdentity: `${engine}-incident-host` }]);
  expect(operationStatus).toBe("failed");
  expect(operationReason ?? "").toContain("durable setup remained incomplete");
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({ state: "failed", error: operationReason });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
});

test("the actuation cap bounds one cycle and the remainder converges on the next", async () => {
  const store = registry();
  const receipts = [
    staleStructuredReceipt(store, "capped_20260719_a1"),
    staleStructuredReceipt(store, "capped_20260719_a2"),
    staleStructuredReceipt(store, "capped_20260719_a3"),
  ];

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    actuationCap: 2,
  });
  expect(first.examined).toBe(2);
  expect(first.terminalized).toHaveLength(2);

  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    actuationCap: 2,
  });
  expect(second.examined).toBe(1);
  expect(second.terminalized).toHaveLength(1);
  for (const receipt of receipts) {
    expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  }
});

function queuedOwnerFixture(transport: "tmux" | "structured", curator?: { id: string; project: string; receiptProject?: string }, attemptId?: string, mode: AgentRegistrySqliteMode = "off") {
  const store = registry(mode);
  const cwd = path.dirname(store.filename);
  const profile = emptyLaunchProfile({ cwd, title: curator ? "Role memory curation" : "Owner queue fixture",
    ...(curator ? { project: curator.project, role: "curator" as never } : {}) });
  const begun = store.beginSpawnRequest({ engine: "claude", cwd, transport, ownStartingActuation: true, accountPin: true, accountId: "account-a",
    ...(curator ? { role: "curator", explicitProject: curator.receiptProject ?? curator.project } : {}),
    clientAttemptId: attemptId ?? curator?.id ?? `relay-owner-queued-${transport}`, launchProfile: profile });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw Error("queued owner fixture unavailable");
  const prompt = "Owner queue fixture instruction";
  store.queuePinnedSpawn(begun.receipt.launchId, { version: 1, retryAt: new Date(0).toISOString(), accountId: "account-a", locale: "en",
    spec: { engine: "claude", command: "claude", cwd, windowName: "owner-fixture", launchProfile: profile },
    prompt, imageRefs: [], parentArtifactPath: null, pipelineSourceConversationId: null }, "Owner queue fixture");
  store.releaseSpawnActuation(begun.receipt.launchId, begun.receipt.admissionOwner);
  return { store, cwd, receipt: begun.receipt };
}

test("startup defers due queued host setup and the controller retains the original launch", async () => {
  const { store, cwd, receipt } = queuedOwnerFixture("structured", undefined, "queued-startup-fixture");
  const { RuntimeJournal } = await import("../../runtime-host/journal");
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = { ...DEAD_RUNTIME_CLIENT, snapshot: async () => journal.snapshot() };
  const before = store.readOnlySnapshot().receipts[receipt.launchId];
  let launches = 0;
  let publications = 0;
  let release!: () => void;
  const heldSetup = new Promise<void>(resolve => { release = resolve; });
  const cancellation = new AbortController();
  let entered!: () => void;
  const setupEntered = new Promise<void>(resolve => { entered = resolve; });
  const options = {
    signal: cancellation.signal,
    resolveSpawnAccount: () => ({ engine: "claude" as const, accountId: "account-a", kind: "managed" as const, home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" as const } }),
    resolvePinnedSpawnAdmission: async () => ({ kind: "admissible" as const, basis: "current" as const, stale: false, retryAt: null }),
    spawnStructuredConversation: async (input: Parameters<typeof spawnStructuredConversation>[0]) => {
      launches++;
      expect(input.receipt.launchId).toBe(receipt.launchId);
      await input.authorize?.();
      entered();
      await heldSetup;
      await input.authorize?.();
      publications++;
      return { state: "running" } as never;
    },
  };
  let controllerPass: Promise<unknown> | undefined;
  let startup: Promise<void> | undefined;
  let startupBound: ReturnType<typeof setTimeout> | undefined;
  try {
    startup = recoverPendingStructuredSpawns(store, client, options);
    await Promise.race([
      startup,
      setupEntered.then(() => { throw Error("startup retained full queued host setup"); }),
      new Promise<never>((_, reject) => {
        startupBound = setTimeout(() => reject(Error("startup made no progress")), 4_000);
      }),
    ]);
    clearTimeout(startupBound);
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toEqual(before);
    controllerPass = terminalizeStaleStructuredSpawns(store, client, options);
    await setupEntered;
    cancellation.abort(Error("retiring Viewer"));
    release();
    await controllerPass;
    expect(launches).toBe(1);
    expect(publications).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({
      state: "starting", admissionOwner: null, clientAttemptId: receipt.clientAttemptId,
      queuedPinnedSpawn: before.queuedPinnedSpawn,
    });
  } finally {
    clearTimeout(startupBound);
    release();
    await startup?.catch(() => {});
    await controllerPass;
    journal.close(); store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);

for (const cutoff of ["abort", "fence", "new-epoch"] as const)
test.each(["tmux", "structured"] as const)(`cancelled queued %s admission cannot start a new launch (${cutoff})`, async transport => {
  const { store, cwd, receipt } = queuedOwnerFixture(transport, undefined, `queued-cancellation-${transport}`);
  const original = store.readOnlySnapshot().receipts[receipt.launchId];
  const cancellation = new AbortController();
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
      signal: cancellation.signal,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => {
        if (cutoff === "abort") cancellation.abort(Error("retiring Viewer"));
        else {
          const { publishHotStateAuthority } = await import("@/lib/state/hotStateAuthority");
          publishHotStateAuthority(cwd, cutoff === "fence" ? "fencing" : "sqlite", "a".repeat(40));
        }
        return { kind: "admissible", basis: "current", stale: false, retryAt: null };
      },
      spawnStructuredConversation: async () => { launches++; throw Error("unexpected launch"); },
      spawnTmuxAgent: async () => { launches++; throw Error("unexpected launch"); },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({
      state: "starting", admissionOwner: null, queuedPinnedSpawn: original.queuedPinnedSpawn,
      clientAttemptId: receipt.clientAttemptId,
    });
  } finally { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("cancelled queued admission releases its claim asynchronously under a peer registry lock", async () => {
  const { store, cwd, receipt } = queuedOwnerFixture("structured", undefined, "queued-cancel-lock", "sqlite");
  const peer = new Database(path.join(cwd, "agent-registry.sqlite"));
  const cancellation = new AbortController();
  let locked = false;
  let timerAdvanced = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
      signal: cancellation.signal,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => {
        peer.exec("BEGIN IMMEDIATE"); locked = true;
        releaseTimer = setTimeout(() => {
          timerAdvanced = true;
          peer.exec("ROLLBACK"); locked = false;
        }, 100);
        cancellation.abort(Error("retiring Viewer"));
        return { kind: "admissible", basis: "current", stale: false, retryAt: null };
      },
      spawnStructuredConversation: async () => { throw Error("unexpected launch"); },
    });
    expect(timerAdvanced).toBe(true);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "starting", admissionOwner: null });
  } finally {
    clearTimeout(releaseTimer);
    if (locked) peer.exec("ROLLBACK");
    peer.close(); store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a newly failed accepted queue retains its reporting obligation until the next pass", async () => {
  const { store, receipt } = queuedOwnerFixture("structured");
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  raw.receipts[receipt.launchId].launcher = { conversationId: "conversation_queue_launcher", notify: true };
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  expect(await store.retireQueuedSpawnOffLoop(receipt.launchId, "accepted queue lost its owner")).toBe(true);
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  await terminalizeStaleStructuredSpawns(reopened, null);
  await terminalizeStaleStructuredSpawns(reopened, null);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId, type: "spawn_failed" }).events).toHaveLength(1);
  expect(readSpawnNoticeTurn(receipt.conversationId, `launch:${receipt.launchId}`)?.outcome).toBe("lost");
});

function claimedCurator(project: string) {
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope, rule: "Inspect the scope before changing stored guidance.",
      why: "The rule is a durable curation fixture.", state: "active", hints: [],
      source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
      createdAt: new Date().toISOString(), changedAt: new Date().toISOString() });
    const prior = tx.get(`s:${scope}`);
    tx.put({ kind: "scope", scope, revision: prior?.kind === "scope" ? prior.revision + 1 : 1,
      history: prior?.kind === "scope" ? prior.history : [], active: [...(prior?.kind === "scope" ? prior.active : []), id] });
  });
  return claimPass({ project, repoDir: "/repo", now: Date.now() })!;
}

function curatorSources(store: AgentRegistry, project: string, state: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" }) {
  const now = Date.now();
  const seatFile = path.join(path.dirname(store.filename), "curator-seat.jsonl");
  fs.writeFileSync(seatFile, "");
  const seat = store.ensureConversation("codex", seatFile, "account-a");
  const sources = {
    ...defaultSeatTickSources(),
    now: () => now,
    registry: () => store,
    settings: () => defaultSeatTickSettings(project),
    seatFor: () => ({ active: state.seat === "missing" ? null : { conversationId: seat.id, seatEpoch: 1,
      designatedAt: new Date(now - 24 * 60 * 60_000).toISOString(), path: seatFile }, pending: null, history: [] }) as never,
    liveness: async () => state.seat === "dead" ? [{ conversationId: seat.id, host: { state: "dead", pid: null, kind: "structured" }, lifecycle: "gone" }] as never
      : [{ conversationId: seat.id, host: { state: "alive", pid: process.pid, kind: "structured" }, lifecycle: "waiting" }] as never,
  };
  writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: 1,
    lastWakeAt: new Date(now - (state.wake === "stale" ? 30 * 24 * 60 : 1) * 60_000).toISOString() });
  return sources;
}

function queuedCuratorFixture(transport: "tmux" | "structured", eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" }, foreignReceipt = false) {
  const project = `repo-curator-${crypto.randomUUID()}`;
  const pass = claimedCurator(project);
  const { store, cwd, receipt } = queuedOwnerFixture(transport, { id: pass.id, project, ...(foreignReceipt ? { receiptProject: `${project}-foreign` } : {}) });
  patchPass(pass.id, { state: "running", launchedAt: new Date().toISOString(), conversationId: receipt.conversationId, launchId: receipt.launchId });
  return { project, pass, store, cwd, receipt, sources: curatorSources(store, project, eligibility) };
}

for (const transport of ["tmux", "structured"] as const)
for (const writerRefused of [false, true]) test(`queued ${transport} owner cutoff retires its prompt and fences recovery (writer refused: ${writerRefused})`, async () => {
  const { store, cwd, receipt } = queuedOwnerFixture(transport);
  const { settleOwnerFirstPrompt } = await import("@/lib/externalRelay/ownerRun");
  const writer = spyOn(store, "retireQueuedSpawnOffLoop");
  if (writerRefused) writer.mockResolvedValue(false);
  let launches = 0;
  try {
    expect(await settleOwnerFirstPrompt(receipt.clientAttemptId!, receipt.conversationId, store)).toMatchObject({ confirmed: !writerRefused });
    if (writerRefused) expect(store.readOnlySnapshot().receipts[receipt.launchId]!.queuedPinnedSpawn).not.toBeNull();
    else expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      resolveSpawnAccount: () => { throw Error("revoked queue must not resolve an account"); },
      spawnTmuxAgent: async () => { launches++; throw Error("revoked owner tmux launch"); },
      spawnStructuredConversation: async () => { launches++; throw Error("revoked owner structured launch"); },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    writer.mockRestore();
    expect(await settleOwnerFirstPrompt(receipt.clientAttemptId!, receipt.conversationId, store)).toEqual({ confirmed: true, pending: false });
  } finally { writer.mockRestore(); store.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

for (const transport of ["tmux", "structured"] as const)
for (const ineligible of ["missing", "dead", "stale"] as const) test(`queued ${transport} curator recovery abandons a ${ineligible} seat without starting a process`, async () => {
  const eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" } = {
    seat: ineligible === "missing" ? "missing" : ineligible === "dead" ? "dead" : "live",
    wake: ineligible === "stale" ? "stale" : "recent",
  };
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, eligibility);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; throw Error("ineligible curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery rechecks its seat after account admission`, async () => {
  const eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" } = { seat: "live", wake: "recent" };
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, eligibility);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => {
        eligibility.seat = "missing";
        return { kind: "admissible", basis: "current", stale: false, retryAt: null };
      },
      spawnTmuxAgent: async () => { launches++; throw Error("seat-change curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery actuates when its seat and delivered wake remain eligible`, async () => {
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, { seat: "live", wake: "recent" });
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; return { paneId: "%curator-fixture", display: "curator-fixture" }; },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(1);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]?.state).not.toBe("failed");
    expect(readPass(pass.id)?.state).toBe("running");
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery refuses a foreign-project receipt`, async () => {
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, { seat: "live", wake: "recent" }, true);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; throw Error("foreign-project curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)?.project).toBe(pass.project);
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} owner recovery rechecks authorization after account admission waits`, async () => {
  const { store, cwd, receipt } = queuedOwnerFixture(transport);
  const saved = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(cwd, "relay-state");
  const { reserveRun, updateRelayStore } = await import("@/lib/externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  updateRelayStore(s => ({ ...s, relays: [{ id: "relay_fixture", paused: false, credential: crypto.randomUUID(),
    targets: [{ id: "target_fixture", enabled: true, ownerTier: true }] } as typeof s.relays[number]] }));
  reserveRun({ requestId: `queued-${transport}`, leaseId: "lease_fixture", relayId: "relay_fixture", targetId: "target_fixture",
    ownerTurn: { clientAttemptId: receipt.clientAttemptId! }, conversationId: receipt.conversationId, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null, runDir: "", startedAt: new Date().toISOString() }, 1);
  let admissions = 0, launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => { admissions++; await Promise.resolve();
        updateRelayStore(s => ({ ...s, relays: s.relays.map(r => ({ ...r, paused: true })) }));
        return { kind: "admissible", basis: "current", stale: false, retryAt: null }; },
      spawnTmuxAgent: async () => { launches++; throw Error("revoked owner launch"); },
      spawnStructuredConversation: async () => { launches++; throw Error("revoked owner launch"); },
    });
    expect(admissions).toBe(1); expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
  } finally { store.close(); fs.rmSync(cwd, { recursive: true, force: true });
    if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved; }
});


test.each((["uncertain", "delivered"] as const).flatMap(phase =>
  (["absent", "user", "live", "claim", "unknown-claim", "pipeline", "pipeline-alias", "no-entry", "user-no-entry", "young"] as const).map(evidence => [phase, evidence] as const),
))("a lost %s first message converges without relaunching (%s)", async (phase, evidence) => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `lost-${phase}-${evidence}`);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  const start = Date.parse(row.createdAt);
  row.admissionOwner = null;
  row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase, startedAt: start, nextTryAt: start,
    checks: 1, reason: "no rollout found for thread id", stopped: evidence !== "young" });
  const host = raw.entries[`codex:${key.sessionId}`];
  host.claimOwner = null;
  host.status = evidence === "live" ? "idle" : "dead";
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  host.structuredHost.process = evidence === "live" ? captureProcessIdentity(process.pid) : null;
  if (evidence === "claim") host.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  if (evidence === "unknown-claim") host.claimOwner = "unverified-fixture-claim";
  if (evidence === "user" || evidence === "user-no-entry") fs.writeFileSync(row.artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Start the work" } }) + "\n");
  if (evidence === "pipeline") raw.memberships[receipt.conversationId] = [{ kind: "pipeline", containerId: "fixture-lane", stageId: "build", slot: "run", role: "builder" }];
  if (evidence === "no-entry" || evidence === "user-no-entry") delete raw.entries[`codex:${key.sessionId}`];
  if (evidence === "pipeline-alias") {
    const canonical = "conversation_fixture_pipeline_alias";
    raw.conversationAliases[receipt.conversationId] = canonical;
    raw.conversations[canonical] = { ...raw.conversations[receipt.conversationId], id: canonical };
    raw.memberships[canonical] = [{ kind: "pipeline", containerId: "fixture-lane", stageId: "build", slot: "run", role: "builder" }];
  }
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const runtimeWrites: string[] = [];
  const client = { ...DEAD_RUNTIME_CLIENT,
    transitionOperation: async (_id: string, state: string) => { runtimeWrites.push(state); },
    command: async () => { throw new Error("lost work must never relaunch or resend"); },
  } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + (evidence === "young" ? 1 : STAGED_RECOVERY_BUDGET_MS) });
  const settled = restarted.snapshot().receipts[receipt.launchId]!;
  expect([evidence, settled.state]).toEqual([evidence, evidence === "absent" || evidence === "no-entry" ? "failed" : evidence === "user" || evidence === "user-no-entry" ? "completed" : "path-pending"]);
  if (evidence === "absent" || evidence === "no-entry") {
    expect(settled.error).toContain("lost before its first turn");
    expect(settled.error).toContain("no rollout found for thread id");
    expect(result.terminalized).toEqual([receipt.launchId]);
    expect(runtimeWrites).toEqual(["failed"]);
  }
});


test.each(["starting", "unpublished"] as const)("an accepted %s launch lost before its first rollout reports from the stale sweep", async phase => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const { pendingSpawnNotices } = await import("@/lib/spawnNotice/store");
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const store = registry();
  const receipt = phase === "starting" ? staleStructuredReceipt(store, "lost-starting-sweep")
    : stagedStructuredReceipt(store, "lost-unpublished-sweep").receipt;
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  row.launcher = { conversationId: "conversation_fixture_launching_seat", notify: true };
  row.admissionOwner = null;
  const start = Date.parse(row.createdAt);
  if (phase === "unpublished") {
    row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase, startedAt: start, nextTryAt: start,
      checks: 1, reason: "runtime host disappeared", stopped: true });
    const host = raw.entries[`codex:${row.key.sessionId}`];
    host.claimOwner = null;
    host.status = "dead";
    host.structuredHost.process = null;
  }
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const result = await terminalizeStaleStructuredSpawns(restarted, { ...DEAD_RUNTIME_CLIENT,
    transitionOperation: async () => {},
  } as unknown as RuntimeHostClient, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  expect(result.terminalized).toEqual([receipt.launchId]);
  expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  expect(pendingSpawnNotices().filter(row => row.childConversationId === receipt.conversationId)).toHaveLength(1);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId }).events.map(event => event.type)).toEqual(["spawn_failed"]);
});

test.each(["new-owner", "late-transcript", "survivor"] as const)("a lost staged launch rechecks %s after the runtime read before failing", async race => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `lost-race-${race}`);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  const start = Date.parse(row.createdAt);
  row.admissionOwner = null;
  row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase: "uncertain", startedAt: start,
    nextTryAt: start, checks: 1, reason: "host gone", stopped: true });
  const host = raw.entries[`codex:${key.sessionId}`];
  host.claimOwner = null;
  host.structuredHost.process = null;
  host.status = "dead";
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const client = { ...DEAD_RUNTIME_CLIENT, operationStatus: async () => {
    if (race === "late-transcript") fs.writeFileSync(row.artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Start the work" } }) + "\n");
    else {
      const latest = JSON.parse(fs.readFileSync(store.filename, "utf8"));
      if (race === "survivor") latest.entries[`codex:${key.sessionId}`].structuredTerminationSurvivors = [captureProcessIdentity(process.pid)];
      else latest.entries[`codex:${key.sessionId}`].claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
      fs.writeFileSync(store.filename, JSON.stringify(latest));
    }
    return null;
  }, transitionOperation: async () => { throw new Error("the stale observation cannot fail the runtime"); } } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  expect(result.terminalized).toEqual([]);
  expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("path-pending");
  if (race === "late-transcript") {
    await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
    expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("completed");
  }
});

test.each(["uncertain", "delivered"] as const)("a staged %s launch stays non-retryable while a retained descendant may live, then fails after cleanup", async phase => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { spawnResponseForReceipt } = await import("@/lib/agent/spawnResponse");
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `survivor-${phase}`);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  const start = Date.parse(row.createdAt);
  row.admissionOwner = null;
  row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase, startedAt: start, nextTryAt: start,
    checks: 1, reason: "no rollout found for thread id", stopped: true });
  const entry = raw.entries[`codex:${key.sessionId}`];
  entry.claimOwner = null;
  entry.status = "dead";
  entry.structuredHost.process = null;
  entry.structuredTerminationSurvivors = [captureProcessIdentity(process.pid)];
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const client = { ...DEAD_RUNTIME_CLIENT, transitionOperation: async () => {} } as unknown as RuntimeHostClient;
  await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  const held = restarted.snapshot().receipts[receipt.launchId]!;
  expect(held.state).toBe("path-pending");
  expect(spawnResponseForReceipt(held).retrySafe).toBe(false);

  const cleaned = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  delete cleaned.entries[`codex:${key.sessionId}`].structuredTerminationSurvivors;
  fs.writeFileSync(store.filename, JSON.stringify(cleaned));
  await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});
