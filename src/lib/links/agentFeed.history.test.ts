import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import { normalizeRegistry } from "@/lib/agent/registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "@/lib/agent/registryPerformanceDataset";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import type { FileEntry } from "@/lib/types";
import { AgentFeed } from "./agentFeed";

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
