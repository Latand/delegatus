import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheSizes } from "@/lib/cacheTelemetry";
import { archiveSettledPipelines, buildPipeline, findPipelineRecord, loadArchivedPipelinesForList, loadArchivedPipelinesForListAsync, savePipelines } from "./store";

const spec = (id: string) => `lane spec ${id} `.padEnd(12_000, "s");
const prompt = (id: string) => `stage prompt ${id} `.padEnd(6_000, "p");

function lane(id: string) {
  const pipeline = buildPipeline({ id, task: `Archived ${id}`, spec: spec(id), project: "fixture", repoDir: "/repo",
    stages: [{ id: "build", kind: "run", prompt: prompt(id), next: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
  pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = "2026-07-02T00:00:00.000Z";
  return pipeline;
}

const archiveCacheBytes = () => cacheSizes().caches.find(size => size.owner === "state/collectionReadCache" && size.name === "archive")!.bytes;

/** Archive `size` lanes in a fresh state directory and measure its list. */
async function measure(size: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-archive-text-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const ids = Array.from({ length: size }, (_, index) => `cold-${size}-${String(index).padStart(3, "0")}`);
    savePipelines(ids.map(lane));
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(size);
    const list = await loadArchivedPipelinesForListAsync();
    expect(list.map(pipeline => pipeline.id)).toEqual(ids);
    const perLane = archiveCacheBytes() / size;
    const parse = spyOn(JSON, "parse");
    const rowsParsed = () => parse.mock.calls.filter(([raw]) => typeof raw === "string" && raw.includes('"id":"cold-')).length;
    try {
      // What the seat, board-report and sweep readers ask of every archived lane.
      expect(loadArchivedPipelinesForList()).toBe(list);
      const closed = list.filter(pipeline => pipeline.project === "fixture" && !pipeline.hiddenAt && pipeline.state === "closed"
        && pipeline.closedAt && pipeline.repoDir === "/repo" && pipeline.stages[0]!.effectiveRole?.engine === "codex");
      expect(closed).toHaveLength(size);
      const scanRows = rowsParsed();
      const last = list.at(-1)!;
      expect(last.stages[0]!.prompt).toBe(prompt(last.id));
      expect(last.spec).toBe(spec(last.id));
      const textRows = rowsParsed() - scanRows;
      expect(JSON.stringify(list[0])).toBe(JSON.stringify(findPipelineRecord(ids[0]!)));
      return { perLane, scanRows, textRows };
    } finally { parse.mockRestore(); }
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the archive list holds no long text, and one lane's text is one row read at any archive size", async () => {
  const small = await measure(6);
  const large = await measure(24);
  for (const measured of [small, large]) {
    // A stored lane carries about 36 KiB of UTF-16 spec and prompt text.
    expect(measured.perLane).toBeLessThan(8 * 1024);
    expect(measured.scanRows).toBe(0);
    expect(measured.textRows).toBe(1);
  }
  expect(Math.abs(large.perLane - small.perLane)).toBeLessThan(64);
});
