import fs from "node:fs";
import asyncFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, type RegistryPerformanceDatasetShape } from "@/lib/agent/registryPerformanceDataset";
import { buildPipeline, PIPELINES_SCHEMA_VERSION } from "@/lib/pipelines/store";
import { BACKUP_DIRECTORY, backupDatabase, stateDatabases } from "@/lib/state/durability";
import { databaseFileIdentity } from "@/lib/state/currentDatabase";
import { RuntimeJournal } from "@/runtime-host/journal";
import { RuntimeHost } from "@/runtime-host/host";
import { projectHostedRestart, activeSeat } from "./startupRecipient.fixture";
import { CHECKOUT_MERGER_CAPTURE, type CheckoutMergerCut } from "./checkoutMergerRecovery";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSocketRequest } from "./contracts";
import * as startup from "./startup";
import { startupStructuredHostEntries } from "./startupSnapshot";
import { StartupRowRetries, startupRowRetries } from "./startupRowRetries";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import * as startupStatus from "./startupStatus";

const full = process.env.LLV_STARTUP_CENSUS_REPLAY === "1";
const seed = process.env.LLV_STARTUP_CENSUS_SEED;
const fixtureDate = "2026-10-01T00:00:00.000Z";
const census = {
  archived: (full ? 3580 : 358) + 9,
  failedDead: full ? 61 : 6,
  failedUnhosted: full ? 16 : 2,
  closedStaged: full ? 6 : 1,
  live: full ? 7 : 1,
  idle: full ? 23 : 2,
  unhosted: full ? 17 : 2,
};
const entries = Object.values(census).reduce((sum, rows) => sum + rows, 0);
const shape: RegistryPerformanceDatasetShape = {
  startupCensus: census, conversations: entries, entries, receipts: 0, heldDeliveries: 0,
  deliveryOperationOwners: 0, lineageEdges: 0, memberships: 0, migrationIntents: 0,
  activeEntries: 0, hotTerminalRows: 0, grantEvery: 50, pendingDeliveries: 0,
  uncertainDeliveries: 0, outstandingReceipts: 0, workers: 0, transcripts: 0, projects: 8,
};

test("replay a retained structured-host registry", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "startup-census-replay-"));
  if (seed) {
    try {
      const data = buildRegistryPerformanceDataset(seed, shape, { sessionsRoot: path.join(seed, "sessions") });
      const sha256 = createHash("sha256").update(fs.readFileSync(data.filename)).digest("hex");
      console.log(JSON.stringify({ startupCensusSeed: { sha256, rows: data.rows, coldRows: data.coldRows, seedMs: data.seedMs } }));
    } finally { fs.rmdirSync(scratch); }
    return;
  }
  const fixture = process.env.LLV_STARTUP_CENSUS_DATA
    ? path.join(process.env.LLV_STARTUP_CENSUS_DATA, "agent-registry.sqlite")
    : buildRegistryPerformanceDataset(scratch, shape, { sessionsRoot: path.join(scratch, "sessions") }).filename;
  const sqliteFilename = path.join(scratch, "replay.sqlite");
  fs.copyFileSync(fixture, sqliteFilename);
  const journalPath = path.join(scratch, "runtime.sqlite");
  const previousJournal = process.env.LLV_RUNTIME_JOURNAL;
  process.env.LLV_RUNTIME_JOURNAL = journalPath;
  const journal = new RuntimeJournal(journalPath, { structuredHosts: true });
  const db = new Database(sqliteFilename);
  try {
    const archiveId = db.query<{ value: number }, []>("SELECT MAX(id) AS value FROM registry_archive").get()!.value;
    // Replay a normal boot after the one-time fallback sweep has completed.
    db.query("INSERT INTO registry_meta(key,value) VALUES ('startup_fallback_watermark',?)")
      .run(JSON.stringify({ journal: databaseFileIdentity(journalPath), archiveId }));
  } finally { db.close(); }
  let entryPayloadReads = 0;
  const openRegistry = () => new AgentRegistry(path.join(scratch, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename, onSqliteRowPayloadRead: (collection, count) => {
      if (collection === "entries") entryPayloadReads += count;
    },
  });
  let registry = openRegistry();
  const backend = new RuntimeHost(journal, undefined, undefined, true);
  const requests = new Map<string, number>();
  const runtimeIds = new Set<string>();
  const fallbackIds = new Set<string>();
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const input = await request.json() as RuntimeSocketRequest;
      requests.set(input.method, (requests.get(input.method) ?? 0) + 1);
      if (input.method === "startup-session-evidence" && input.params?.includeEvidence) {
        runtimeIds.add((input.params.conversationIds as string[])[0]!);
      }
      if (input.method === "session-read") fallbackIds.add(String(input.params?.conversationId));
      return Response.json(await backend.handle(input));
    },
  });
  const rpc = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(http.url, { method: "POST", body: JSON.stringify({ id: "census-replay", method, params }) });
    const reply = await response.json() as { ok: boolean; result: T; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "synthetic runtime refused request");
    return reply.result;
  };
  const client: RuntimeHostClient = {
    startupGeneration: async () => "synthetic-runtime",
    startupSessionEvidence: (conversationIds, options) => rpc("startup-session-evidence", {
      conversationIds, includeEvidence: options?.includeEvidence,
      pendingOperationsAfter: options?.pendingOperationsAfter,
    }),
    snapshot: async () => journal.snapshot(),
    readSession: identity => rpc("session-read", { ...identity }),
    append: event => rpc("append", { event }),
    appendSessionFenced: event => rpc("append-session-fenced", { event }),
    command: async command => journal.executeOperation(command),
    operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
    effectBatch: (kinds, afterEventSeq, options) =>
      kinds?.includes("runtime.spawn") && kinds.includes("runtime.compact")
        ? rpc("effect-batch", { kinds, afterEventSeq, conversationId: options?.conversationId }) : Promise.resolve([]),
    transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  } as RuntimeHostClient;

  const cleanups: Array<() => void> = [];
  try {
    const session = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const hostKey = (index: number) => `codex:${session(index)}`;
    const conversation = (index: number) => `conversation_${session(index)}` as const;
    const initial = registry.readOnlySnapshot();
    const row = (index: number) => initial.entries[hostKey(index)]!;
    const interruptions = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
    interruptions.record({
      conversationId: conversation(0), engine: "codex", hostKey: hostKey(0), path: row(0).artifactPath, owner: null,
      claimEpoch: 0, turnRef: null, boundary: "synthetic-interrupted-host", reason: "viewer-restart", recordedAt: fixtureDate,
      checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null,
    });
    const cut: CheckoutMergerCut = {
      engine: "codex", conversationId: conversation(2), sessionId: session(2), path: row(2).artifactPath,
      claimEpoch: 1, process: row(2).hostExitProcess!, writer: null, batch: null,
      capturedAt: fixtureDate, boundary: `checkout-merger:${"a".repeat(32)}`,
    };
    fs.writeFileSync(path.join(scratch, CHECKOUT_MERGER_CAPTURE), JSON.stringify([cut]));
    registry.holdDelivery(conversation(3), "Synthetic held message", "census-held");
    projectHostedRestart(journal, "codex", conversation(4), session(4), row(4).cwd, row(4).artifactPath);
    journal.executeOperation({
      kind: "send", operationId: "census-runtime-send", idempotencyKey: "census-runtime-send",
      conversationId: conversation(4), text: "Synthetic queued message", policy: "queue", turnId: null,
    });
    await new StartupRowRetries(`${registry.filename}.startup-retries`).failed(hostKey(5), "adoption-failed", Date.parse(fixtureDate));
    const alarm = `${registry.filename}.orphan-alarms.json`;
    fs.writeFileSync(alarm, JSON.stringify({ [hostKey(6)]: { ...row(6).key, cwd: row(6).cwd } }));
    const pipeline = buildPipeline({ id: "census-closed-pipeline", task: "Synthetic completed launch owner", project: "fixture", repoDir: scratch,
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-write", promptScaffold: null } }], srcPath: null, srcConversationId: null, now: fixtureDate });
    pipeline.state = "closed";
    pipeline.closedAt = fixtureDate;
    pipeline.cursor = null;
    const unreadable = { ...pipeline, id: "census-read-fenced", stages: [{ id: "build", kind: "future-stage" }] };
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "pipelines.json"),
      JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines: [pipeline, unreadable] }));

    const markerCounts: Record<string, number> = {};
    const spawn = await import("./structuredSpawn");
    if (typeof spawn.settleStaleSpawnMarkers === "function") {
      const database = stateDatabases(scratch).find(candidate => candidate.name === "agent-registry.sqlite")!;
      const backup = backupDatabase({ ...database, filename: sqliteFilename }, {
        backupDirectory: path.join(scratch, BACKUP_DIRECTORY), freeBytes: () => null,
      });
      if (backup.state !== "taken") throw new Error("synthetic replay backup was refused");
      let afterKey: string | undefined;
      for (;;) {
        const batch = await spawn.settleStaleSpawnMarkers(registry, client, { apply: false, journalPath, afterKey });
        if (batch.length === 0) break;
        for (const row of batch) {
          const classAndReason = `${row.group} ${row.reason}`;
          markerCounts[classAndReason] = (markerCounts[classAndReason] ?? 0) + 1;
        }
        afterKey = batch.at(-1)!.key;
      }
    }

    const view = await registry.prepareReadOnlySnapshot();
    const beforeSelection = entryPayloadReads;
    const selected = await startupStructuredHostEntries(view);
    const selectionReads = entryPayloadReads - beforeSelection;
    const seat = activeSeat("census", 1, conversation(1), row(1).artifactPath);

    // The fixture's writes and the standalone selection probe must not warm
    // the Viewer reader used by the timed startup pass.
    registry.close();
    registry = openRegistry();
    entryPayloadReads = 0;

    let censusMs = -1;
    let phaseStarted = 0;
    let membershipRows = 0;
    const progress = spyOn(startupStatus, "markStructuredHostStartupProgress").mockImplementation(value => {
      if (value.phase === "reading structured startup registry") phaseStarted = performance.now();
      else if (phaseStarted && censusMs < 0) censusMs = performance.now() - phaseStarted;
      if (value.membership) membershipRows = Math.max(membershipRows, value.membership.completed + value.membership.remaining);
    });
    const startupBoundary = spyOn(registry, "startupHostSnapshot");
    const retryFiles = `${registry.filename}.startup-retries${path.sep}`;
    const retryProbes = spyOn(asyncFs, "readFile");
    cleanups.push(() => retryProbes.mockRestore(), () => startupBoundary.mockRestore(), () => progress.mockRestore());
    const start = performance.now();
    const eligible: string[] = [];
    const adopted = await startup.adoptStructuredHostsAtStartup({
      registry, client, interruptions,
      orchestratorSeats: () => [seat],
      refreshTranscriptState: async () => {},
      adopt: async (_registry, _options, _env, filter, _processed, hooks) => {
        for (const entry of await startupStructuredHostEntries(hooks?.preparedSnapshot ?? registry.readOnlySnapshot())) {
          if (filter?.(entry)) eligible.push(entry.key.sessionId);
        }
        return [];
      },
      adoptClaude: async () => [],
      schedule: () => ({ unref() {} }),
    });
    const fullPassMs = performance.now() - start;
    const after = registry.readOnlySnapshot();
    const historicalDeferral = typeof startup.pipelineStartupTargetDeferred === "function"
      ? await startup.pipelineStartupTargetDeferred(registry, conversation(7))
      : startup.structuredStartupDeferral()?.hostKeys.includes(hostKey(7)) ?? false;
    const digestInput = {
      eligible: eligible.sort(), adopted: adopted.map(host => host.key.sessionId).sort(),
      retry: startupRowRetries(registry).get(hostKey(5))?.reason ?? null,
      interruption: interruptions.list().map(obligation => obligation.state).sort(),
      alarm: JSON.parse(fs.readFileSync(alarm, "utf8"))[hostKey(6)] !== undefined,
      checkoutEndpoint: after.entries[hostKey(2)]?.structuredHost?.endpoint, historicalDeferral,
      nonReleasedArchived: after.entries[hostKey(8)]?.structuredHost?.endpoint,
    };
    const metrics = {
      selectedRows: selected.length, membershipRows, selectionReads, entryPayloadReads,
      keyedSnapshots: startupBoundary.mock.calls.length,
      retryFileProbes: retryProbes.mock.calls.filter(([filename]) => typeof filename === "string" && filename.startsWith(retryFiles)).length,
      runtimeReads: runtimeIds.size, fallbackReads: fallbackIds.size,
      fallbackAppends: requests.get("append") ?? 0,
      censusMs, fullPassMs, requests: Object.fromEntries(requests),
      digest: createHash("sha256").update(JSON.stringify({ ...digestInput, nonReleasedArchived: undefined })).digest("hex"),
      outcomes: digestInput, markerCounts,
    };
    console.log(JSON.stringify({ startupCensusReplay: metrics }));
    expect(after.entries[hostKey(8)]).toBeDefined();
    expect(eligible).toContain(session(3));
    expect(eligible).toContain(session(4));
    expect(censusMs).toBeGreaterThan(0);
    expect(historicalDeferral).toBe(true);
    if (process.env.LLV_STARTUP_CENSUS_BASE === "1") expect(selected).toHaveLength(entries);
    else {
      expect(selected).toHaveLength(entries - census.archived);
      expect(selectionReads).toBe(0);
      expect(runtimeIds.has(conversation(0))).toBe(true);
      expect(runtimeIds.has(conversation(1))).toBe(true);
      expect(runtimeIds.has(conversation(2))).toBe(true);
      expect(runtimeIds.has(conversation(3))).toBe(true);
      expect(runtimeIds.has(conversation(4))).toBe(true);
      expect(runtimeIds.has(conversation(5))).toBe(true);
      expect(runtimeIds.has(conversation(6))).toBe(true);
      expect(runtimeIds.has(conversation(9))).toBe(false);
      expect(fallbackIds.has(conversation(9))).toBe(false);
    }
  } finally {
    for (const cleanup of cleanups) cleanup();
    await bindStructuredDeliveryQueue([], { registry, client: null });
    http.stop(true);
    registry.close();
    journal.close();
    if (previousJournal === undefined) delete process.env.LLV_RUNTIME_JOURNAL;
    else process.env.LLV_RUNTIME_JOURNAL = previousJournal;
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}, 240_000);
