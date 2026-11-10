import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { FileEntry } from "@/lib/types";

import { runReaperCycle, terminalizeStaleUndeliverableHeldDeliveries } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalEnabled === undefined) delete process.env.LLV_REAPER_ENABLED;
  else process.env.LLV_REAPER_ENABLED = originalEnabled;
});

function runtimeHost(pathname: string): TranscriptHost {
  return {
    tmuxServerPid: 900,
    paneId: "%41",
    panePid: 1041,
    agentPid: 2041,
    display: "agents:41.0",
    windowName: "worker-41",
    engine: "codex",
    cwd: "/repo",
    agentArgv: ["codex", "resume", pathname],
    agentIdentity: "2041:one",
    launchId: null,
    claimedPaths: [pathname],
    primaryPath: pathname,
  };
}

function runtimeFile(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "worker",
    engine: "codex",
    kind: "conversation",
    fmt: "codex",
    parent: null,
    mtime,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

test("a sticky owner-authored verdict prevents later full transcript rescans (issue #493)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-sticky-authorship-"));
  const pathname = path.join(directory, "rollout-019f4906-3f67-0b72-0fbc-9ec3b5ad13ac.jsonl");
  const now = Date.parse("2026-07-20T18:00:00.000Z");
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "sticky authorship" });
  registry.reconcileConversations([{
    engine: "codex",
    path: pathname,
    accountId: "default",
    launchProfile: profile,
    turn: { state: "idle", source: "assistant", terminalAt: new Date(now - 60_000).toISOString() },
    observedAt: new Date(now - 60_000).toISOString(),
  }]);

  try {
    fs.writeFileSync(pathname, JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now - 60_000).toISOString(),
      payload: { type: "user_message", message: "keep this conversation visible" },
    }) + "\n");
    await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, fs.statSync(pathname).mtimeMs / 1000)],
      now,
    });

    fs.writeFileSync(pathname, JSON.stringify({
      type: "event_msg",
      timestamp: new Date(now).toISOString(),
      payload: { type: "agent_message", message: "x".repeat(128 * 1024) },
    }) + "\n");
    await runReaperCycle({
      registry,
      hosts: [runtimeHost(pathname)],
      files: [runtimeFile(pathname, fs.statSync(pathname).mtimeMs / 1000)],
      now: now + 1_000,
    });

    const state = JSON.parse(fs.readFileSync(path.join(directory, "reaper-state.json"), "utf8")) as {
      scannedAt?: Record<string, number>;
      userAuthoredPaths?: Record<string, true>;
    };
    expect(state.userAuthoredPaths?.[pathname]).toBe(true);
    expect(state.scannedAt?.[pathname]).toBeUndefined();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stale migration convergence scales linearly with a production-shaped registry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-migration-scale-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename);
  const conversation = registry.ensureConversation("codex", "/registry-scale-0.jsonl", "source");
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "registry-scale",
    expectedRevision: registry.engineRouting("codex").revision,
  });
  const delivery = registry.holdDelivery(conversation.id, "fixture", "registry-scale-0");
  registry.recordDeliveryOutcome(delivery.id, "delivered");

  try {
    const snapshot = registry.snapshot() as any;
    const conversationTemplate = snapshot.conversations[conversation.id];
    const deliveryTemplate = snapshot.heldDeliveries[delivery.id];
    for (let index = 1; index < 2_500; index += 1) {
      const conversationId = `conversation_10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const generationId = `native_10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      snapshot.conversations[conversationId] = {
        ...structuredClone(conversationTemplate),
        id: conversationId,
        generations: [{
          ...structuredClone(conversationTemplate.generations[0]),
          id: generationId,
          path: `/registry-scale-${index}.jsonl`,
        }],
        migration: null,
      };
      const deliveryId = `held_registry_scale_${index}`;
      snapshot.heldDeliveries[deliveryId] = {
        ...structuredClone(deliveryTemplate),
        id: deliveryId,
        conversationId,
        clientMessageId: `registry-scale-${index}`,
      };
    }
    fs.writeFileSync(filename, JSON.stringify(snapshot));
    const seeded = new AgentRegistry(filename);
    const startedAt = performance.now();

    await terminalizeStaleUndeliverableHeldDeliveries(seeded, Date.now() + 6 * 60_000);

    /* A benchmark: the measurement is reported, and how fast a shared runner
       happened to be is not asserted (#1761). */
    console.log(JSON.stringify({ probe: "stale-migration-convergence-2500", ms: Math.round(performance.now() - startedAt) }));
    expect(seeded.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("a hygiene pass with nothing to converge reads no archived history again, whatever the intent count", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-idle-hygiene-"));
  const deliveries = 640;
  const intents = 12;
  const dataset = buildRegistryPerformanceDataset(directory, {
    ...scaledRegistryPerformanceShape(0.02),
    heldDeliveries: deliveries, deliveryOperationOwners: deliveries, migrationIntents: intents, hotTerminalRows: 0,
  });
  /* The archive a long-lived installation carries is larger than the store's
     row cache, so a pass that enumerates it reads it from disk every time.
     Settled deliveries are rewritten with a large body and archived again. */
  const peer = new Database(dataset.filename);
  peer.query(`UPDATE registry_rows SET value_json=json_set(value_json,'$.text',?)
    WHERE collection='heldDeliveries' AND json_extract(value_json,'$.state')='delivered'`).run("retained delivery body ".repeat(4_500));
  peer.close();
  const reads = new Map<string, number>();
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, {
    sqliteMode: "sqlite", sqliteFilename: dataset.filename,
    onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
  });
  try {
    while (registry.archiveInactiveRows(10_000) > 0) { /* until the rewritten rows are cold again */ }
    const census = new Database(dataset.filename, { readonly: true });
    const archived = census.query<{ rows: number; bytes: number }, []>(`SELECT COUNT(*) AS rows, SUM(LENGTH(a.value_json)) AS bytes
      FROM registry_cold c JOIN registry_archive a ON a.id=c.archive_id WHERE c.collection='heldDeliveries'`).get()!;
    census.close();
    expect(archived.rows).toBeGreaterThan(deliveries - 40);
    expect(archived.bytes).toBeGreaterThan(56 * 1024 * 1024);
    await registry.prepareReadOnlySnapshot();
    const pass = async () => {
      reads.clear();
      const terminalized = await terminalizeStaleUndeliverableHeldDeliveries(registry, Date.now(), {}, []);
      const candidates = registry.failedSpawnDeliveryCandidates();
      return { terminalized, candidates, deliveries: reads.get("heldDeliveries") ?? 0, conversations: reads.get("conversations") ?? 0 };
    };

    const first = await pass();
    const second = await pass();

    console.log(JSON.stringify({ probe: "idle-hygiene-archive-reads", first, second }));
    expect(first.terminalized).toEqual([]);
    expect(first.candidates).toBe(false);
    expect(first.deliveries).toBeLessThan(intents * archived.rows);
    expect(second).toEqual({ terminalized: [], candidates: false, deliveries: 0, conversations: 0 });
  } finally {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
