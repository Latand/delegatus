import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { normalizeRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import type { FileEntry } from "@/lib/types";
import { AgentFeed, type AgentRow } from "./agentFeed";

function retainedAttempts() {
  const project = `repo-${"a".repeat(32)}`;
  let historyReads = 0;
  const pipelines = Object.freeze(Array.from({ length: 500 }, (_, n) => {
    const attempts = Object.freeze(Array.from({ length: 100 }, (_, a) => Object.freeze({
      conversationId: a === 0 && n < 100 ? `active-${n}` : `archived-${n}-${a}`,
      agentPath: a === 0 && n < 100 ? `/sandbox/active-${n}.jsonl` : `/sandbox/archived-${n}-${a}.jsonl`, state: "passed",
    })));
    return Object.freeze({
      id: `pipeline-${n}`, state: "running", taskIds: [], stages: [{ id: "build" }],
      runs: [Object.freeze({
        stageId: "build",
        get attempts() {
          if (n >= 100) historyReads++;
          return attempts;
        },
      })],
    });
  }));
  // All pipelines retain ordinary frozen attempts; only traversal of unrelated
  // runs is counted, independently of elapsed time or the displayed row cap.
  const files = Array.from({ length: 100 }, (_, n) => ({
    conversationId: `active-${n}`, path: `/sandbox/active-${n}.jsonl`, project,
    engine: "codex", model: "fixture", proc: "running", activity: "live", mtime: 0, lastAgentWorkAt: 0,
  } as FileEntry));
  const memberships = Object.fromEntries(files.map((file, n) => [file.conversationId!, [
    { kind: "pipeline", containerId: pipelines[n]!.id, stageId: "build" },
  ]]));
  return { project, pipelines, files, memberships, reads: () => historyReads, reset: () => { historyReads = 0; } };
}

test("scan-only refreshes with memberships never traverse unrelated retained pipeline attempts", () => {
  const data = retainedAttempts();
  let files = data.files;
  const tasks: never[] = [];
  const feed = new AgentFeed("membership-history", () => files, () => tasks, () => data.pipelines as never, () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: data.memberships, lineageEdges: {} }) as never, seats: () => [], canonical: p => p });
  const projects = new Set([data.project]);
  const first = feed.page(null, projects);
  expect(first.rows).toHaveLength(50);
  expect(first.rows!.every(row => (row as AgentRow).pl?.stage === "build")).toBe(true);
  expect(data.reads()).toBe(0);
  data.reset();
  files = [...files];
  expect(feed.page(first.cursor, projects).rows).toBeUndefined();
  expect(data.reads()).toBe(0);
});

test("fallback attempt index survives scan refreshes and is replaced with its pipeline snapshot", () => {
  const data = retainedAttempts();
  let files = [data.files[0]!];
  let pipelines: readonly unknown[] = data.pipelines;
  const tasks: never[] = [];
  const feed = new AgentFeed("fallback-history", () => files, () => tasks, () => pipelines as never, () => () => false,
    { snapshot: () => ({ conversations: {}, memberships: {}, lineageEdges: {} }), seats: () => [], canonical: p => p });
  const projects = new Set([data.project]);
  const first = feed.page(null, projects);
  expect(first.rows![0]).toMatchObject({ pl: { id: "pipeline-0", stageState: "passed" } });
  expect(data.reads()).toBe(400);
  data.reset();
  files = [...files];
  expect(feed.page(first.cursor, projects).rows).toBeUndefined();
  expect(data.reads()).toBe(0);

  pipelines = Object.freeze(data.pipelines.map((pipeline, n) => n ? pipeline : Object.freeze({ ...pipeline, state: "done" })));
  const updated = feed.page(first.cursor, projects);
  expect(updated.rows![0]).toMatchObject({ pl: { id: "pipeline-0", state: "done", stageState: "passed" } });
  expect(data.reads()).toBe(400);
  data.reset();
  pipelines = Object.freeze([]);
  const removed = feed.page(updated.cursor, projects);
  expect(removed.rows![0]).not.toHaveProperty("pl");
  pipelines = data.pipelines;
  expect(feed.page(removed.cursor, projects).rows![0]).toMatchObject({ pl: { id: "pipeline-0", state: "running" } });
  expect(data.reads()).toBe(400);
});

test("peer feed resolves recent agents without materializing unrelated archived conversations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-feed-history-"));
  let store: SqliteAgentRegistryStore | undefined;
  try {
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.05), {
      sessionsRoot: path.join(directory, "sessions"),
    });
    let payloads = 0;
    store = new SqliteAgentRegistryStore(dataset.filename, {
      normalize: normalizeRegistry, initialSnapshot: () => { throw new Error("dataset is already imported"); },
      onRowPayloadRead: (_collection, count) => { payloads += count; },
    });
    const snapshot = store.readOnlySnapshot().file;
    const project = `repo-${"a".repeat(32)}`;
    const now = Date.now();
    let files = dataset.conversations.map((conversation, index) => ({
      path: conversation.path, project, engine: "codex", proc: "done", activity: "idle", model: "fixture",
      mtime: now / 1000, lastAgentWorkAt: index < dataset.conversations.length - 8 ? now - 172_800_000 : now,
    } as FileEntry));
    const tasks: never[] = [];
    const pipelines: never[] = [];
    const feed = new AgentFeed("history", () => files, () => tasks, () => pipelines, () => () => false,
      { snapshot: () => snapshot, seats: () => [], canonical: p => p });
    const stat = spyOn(fs, "statSync");
    try {
      for (let pass = 0; pass < 2; pass++) {
        payloads = 0;
        stat.mockClear();
        files = [...files];
        const page = feed.page(null, new Set([project]));
        expect(page.rows).toHaveLength(8);
        const identityReads = stat.mock.calls.filter(([filename]) => filename === dataset.filename).length;
        console.info("peer archived history", { pass, payloads, identityReads });
        expect(payloads).toBeLessThan(35);
        expect(identityReads).toBeLessThan(150);
      }
    } finally { stat.mockRestore(); }
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
