import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { codexModelServiceTiers, codexServiceTierCatalog } from "@/lib/accounts/codexServiceTiers";
import { cacheSizes, MeasuredCache, touchCacheEntry } from "./cacheTelemetry";
import { performanceSpans, performanceSites } from "./performanceSpans";
import { readBackgroundTaskLedger } from "./pipelines/backgroundTasks";
import { headRecordsResult, tailRecordsResult, transcriptTurnResult } from "./scanner/activity";
import { readHead } from "./scanner/head";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

test("MeasuredCache.touch promotes LRU order without re-running the byte estimator", () => {
  let measures = 0;
  const cache = new MeasuredCache<string, { label: string }>("touch-test", "cacheTelemetry-fastPath", (value) => {
    measures += 1;
    return value.label.length * 2;
  }, "estimated-bytes");
  try {
    cache.set("a", { label: "alpha" });
    cache.set("b", { label: "beta" });
    expect(measures).toBe(2);
    expect([...cache.keys()]).toEqual(["a", "b"]);
    const before = cacheSizes().caches.find(row => row.owner === "cacheTelemetry-fastPath" && row.name === "touch-test")!;
    expect(touchCacheEntry(cache, "a")).toBe(true);
    expect(touchCacheEntry(cache, "missing")).toBe(false);
    expect([...cache.keys()]).toEqual(["b", "a"]);
    expect(measures).toBe(2);
    expect(cacheSizes().caches.find(row => row.owner === "cacheTelemetry-fastPath" && row.name === "touch-test")).toEqual(before);
  } finally {
    cache.clear();
  }
});

test("scanner tail-v3, head-records-v2, scanner-head-v1 and turn-evidence-v3 avoid recursive graph accounting", () => {
  const dir = tempDir("scanner-cache-accounting-");
  const file = path.join(dir, "session.jsonl");
  const lines = Array.from({ length: 120 }, (_, index) => JSON.stringify({
    type: "event_msg",
    timestamp: "2026-11-20T12:00:00Z",
    payload: { type: index === 119 ? "task_complete" : "agent_message", items: Array.from({ length: 12 }, (_, k) => ({ k, text: "payload".repeat(12) })) },
  }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const stat = fs.statSync(file);

  const head = readHead(file, stat.size, stat.mtimeMs);
  expect(head.complete).toBe(true);
  const headRecs = headRecordsResult(file, stat.size, stat.mtimeMs);
  expect(headRecs.complete).toBe(true);
  const tail = tailRecordsResult(file, stat.size, stat.mtimeMs);
  expect(tail.complete).toBe(true);
  expect(transcriptTurnResult(file, stat.size, stat.mtimeMs, "codex").complete).toBe(true);

  const tailCounter = cacheSizes().caches.find(row => row.owner === "scanner/caches" && row.name === "tail-v3");
  const headCounter = cacheSizes().caches.find(row => row.owner === "scanner/caches" && row.name === "scanner-head-v1");
  expect(tailCounter?.basis).toBe("source-utf16");
  expect(tailCounter?.bytes ?? 0).toBeGreaterThan(0);
  expect(headCounter?.basis).toBe("buffer-bytes");
  expect(headCounter?.bytes ?? 0).toBeGreaterThan(0);

  // Repeated turn-evidence cache hits must emit zero cache.accounting spans.
  performanceSpans.clear();
  for (let i = 0; i < 20; i += 1) {
    expect(transcriptTurnResult(file, stat.size, stat.mtimeMs, "codex").complete).toBe(true);
  }
  const accountingSlices = performanceSpans.snapshot().records
    .filter(slice => performanceSites[slice.site] === "cache.accounting");
  expect(accountingSlices).toHaveLength(0);
});

test("codexServiceTiers strips unused catalog blobs before caching model rows", () => {
  const dir = tempDir("codex-tiers-slim-");
  const hugeBlob = "x".repeat(250_000);
  fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({
    models: [
      {
        slug: "gpt-6.1-sol",
        description: hugeBlob,
        base_instructions: hugeBlob,
        service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }],
      },
      {
        slug: "gpt-6-luna",
        description: hugeBlob,
        additional_speed_tiers: ["fast"],
      },
    ],
  }));
  expect(codexModelServiceTiers(dir, "gpt-6.1-sol")).toEqual([
    { id: "priority", name: "Fast" },
    { id: "ultrafast", name: "Ultrafast" },
  ]);
  expect(codexServiceTierCatalog(dir)).toEqual([
    { slug: "gpt-6.1-sol", tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }] },
    { slug: "gpt-6-luna", tiers: [{ id: "priority", name: "priority" }] },
  ]);
  const modelsCounter = cacheSizes().caches.find(row => row.owner === "accounts/codexServiceTiers" && row.name === "models");
  // Raw file is >750 KB (1.5 MB UTF-16); slimmed cache retains only tier metadata (<32 KB).
  expect(modelsCounter?.bytes ?? Infinity).toBeLessThan(32 * 1024);
});

test("readBackgroundTaskLedger skips re-measuring its cache when a transcript appends ordinary lines", async () => {
  const dir = tempDir("bg-ledger-touch-");
  const file = path.join(dir, "claude.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "started" }] } })}\n`);
  const first = await readBackgroundTaskLedger(file);
  expect(first).not.toBeNull();

  // Appending non-background lines keeps the same ledger and emits zero cache.accounting spans.
  fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ordinary follow-up" }] } })}\n`);
  performanceSpans.clear();
  const second = await readBackgroundTaskLedger(file);
  expect(second).toBe(first);
  const accountingSlices = performanceSpans.snapshot().records
    .filter(slice => performanceSites[slice.site] === "cache.accounting");
  expect(accountingSlices).toHaveLength(0);
});
