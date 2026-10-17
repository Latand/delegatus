import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { memoryIndex, refreshMemoryIndex } from "./service";
import { performanceSites, performanceSpans } from "@/lib/performanceSpans";

test("refresh builds only in Viewer state and a test with no explicit roots never discovers live memory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-service-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const filename = path.join(root, "codex", "memories", "memory_summary.md");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "v1\n## User preferences\n- Keep widget reports brief.\n");
  const index = memoryIndex();
  try {
    performanceSpans.clear();
    expect(await refreshMemoryIndex()).toBeUndefined();
    expect(performanceSpans.snapshot().records).toEqual([]);
    expect(fs.existsSync(process.env.LLV_STATE_DIR)).toBe(false);
    const roots = { claudeHomes: [], codexHome: path.join(root, "codex"), skillRoots: [] };
    expect(await refreshMemoryIndex(roots)).toMatchObject({ filesRead: 1, entriesIndexed: 1 });
    const phases = performanceSpans.snapshot().records.map(row => ({ kind: row.kind, name: performanceSites[row.site] }));
    expect(phases).toContainEqual({ kind: "await", name: "memory.discovery" });
    expect(phases).toContainEqual({ kind: "await", name: "memory.refresh" });
    expect(phases).toContainEqual({ kind: "sync", name: "memory.refresh" });
    expect((await index.search({ query: "widget" })).items).toHaveLength(1);
    expect(await refreshMemoryIndex(roots)).toMatchObject({ filesRead: 0 });
    expect(fs.readdirSync(path.dirname(filename))).toEqual(["memory_summary.md"]);
    for (const name of fs.readdirSync(process.env.LLV_STATE_DIR)) {
      expect(name).toMatch(/^memory-index\.sqlite(?:-wal|-shm)?$/);
      expect(fs.statSync(path.join(process.env.LLV_STATE_DIR, name)).mode & 0o777).toBe(0o600);
    }
  } finally {
    performanceSpans.clear();
    index.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("complete refresh attributes project resolution, resumed reads, and pruning as synchronous memory work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-refresh-attribution-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  const filename = path.join(root, "codex", "memories", "memory_summary.md");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "v1\n## User preferences\n- Keep widget reports brief.\n");
  const readStarted = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const releaseRead = (() => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; })();
  const originalReadFile = fsp.readFile;
  const delayedReadFile = (async (filename: string, encoding: BufferEncoding) => {
    readStarted.resolve();
    await releaseRead.promise;
    return originalReadFile(filename, encoding);
  }) as unknown as typeof fsp.readFile;
  const readGate = spyOn(fsp, "readFile").mockImplementation(delayedReadFile);
  const sites: number[] = [];
  let resumedMemorySites = 0;
  let injectCpuOnResume = false;
  const memoryRefreshSite = performanceSites.indexOf("memory.refresh");
  const index = memoryIndex();
  try {
    performanceSpans.clear();
    performanceSpans.observeSite(site => {
      sites.push(site);
      if (injectCpuOnResume && site === memoryRefreshSite) {
        resumedMemorySites++;
        if (resumedMemorySites === 1 || resumedMemorySites === 3) {
          const until = performance.now() + 5;
          while (performance.now() < until) { /* bounded attribution control */ }
        }
      }
    });
    const refresh = refreshMemoryIndex({ claudeHomes: [], codexHome: path.join(root, "codex"), skillRoots: [] });
    await readStarted.promise;
    expect(sites.at(-1)).toBe(-1);
    injectCpuOnResume = true;
    releaseRead.resolve();
    await refresh;

    const sync = performanceSpans.snapshot().records.filter(row => row.kind === "sync");
    const memoryRefresh = sync.filter(row => performanceSites[row.site] === "memory.refresh");
    expect(sites.filter(site => site === memoryRefreshSite)).toHaveLength(6);
    expect(memoryRefresh.filter(row => row.maxMs >= 4)).toHaveLength(2);
    expect(sites.at(-1)).toBe(-1);
    expect(await index.search({ query: "widget" })).toMatchObject({ items: [{ summary: "Keep widget reports brief." }] });
  } finally {
    readGate.mockRestore();
    performanceSpans.observeSite();
    performanceSpans.clear();
    index.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
