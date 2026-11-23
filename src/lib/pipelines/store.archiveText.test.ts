import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheSizes } from "@/lib/cacheTelemetry";
import { doneCandidates } from "@/lib/done/candidates";
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

test("a lane archived again while a reader holds the list serializes as its whole current record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-archive-rewrite-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    savePipelines([lane("cold-held"), lane("cold-other")]);
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(2);
    const held = await loadArchivedPipelinesForListAsync();
    const again = lane("cold-held");
    again.closedAt = "2026-07-03T00:00:00.000Z";
    again.stages[0]!.prompt = prompt("rewritten");
    savePipelines([again]);
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(1);
    // The route's response: every lane whole, the rewritten one as stored now.
    const response = JSON.parse(JSON.stringify({ lanes: held })) as { lanes: typeof held };
    expect(response.lanes.map(pipeline => pipeline.id)).toEqual(["cold-held", "cold-other"]);
    expect(response.lanes[0]).toEqual(JSON.parse(JSON.stringify(findPipelineRecord("cold-held"))));
    expect(response.lanes[0]!.closedAt).toBe("2026-07-03T00:00:00.000Z");
    expect(response.lanes[0]!.stages[0]!.prompt).toBe(prompt("rewritten"));
    expect(response.lanes[1]!.spec).toBe(spec("cold-other"));
    expect(held[0]!.closedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(loadArchivedPipelinesForList()[0]!.stages[0]!.prompt).toBe(prompt("rewritten"));
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the done projection titles a lane archived again since its list was read from the lane as stored now", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-archive-done-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const task = `Deliver the archived work ${"t".repeat(700)}`;
    const finished = () => {
      const pipeline = buildPipeline({ id: "cold-done", task, project: "fixture", repoDir: "/repo",
        stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
          effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
        srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
      pipeline.state = "completed"; pipeline.cursor = null; pipeline.closedAt = "2026-07-02T00:00:00.000Z";
      return pipeline;
    };
    savePipelines([finished()]);
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(1);
    const held = await loadArchivedPipelinesForListAsync();
    const again = finished();
    again.closedAt = "2026-07-03T00:00:00.000Z";
    savePipelines([again]);
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(1);
    expect(() => held[0]!.task).toThrow();
    const project = (pipelineRecord?: (id: string) => ReturnType<typeof findPipelineRecord>) => doneCandidates({
      now: Date.parse("2026-07-04T00:00:00Z"), floor: Date.parse("2026-07-01T00:00:00Z"),
      forge: { schemaVersion: 1, repositories: {} }, pipelines: held, tasks: [], deployments: [], reports: [], limits: {},
      pipelineRepository: () => null, repositoryProject: () => null, ...(pipelineRecord ? { pipelineRecord } : {}),
    }).candidates;
    const [item] = project(findPipelineRecord);
    expect(item).toMatchObject({ key: "pipeline:cold-done:done", project: "fixture", at: "2026-07-02T00:00:00.000Z" });
    expect(item!.title.startsWith("Deliver the archived work")).toBe(true);
    // A projection with no way to read the lane still completes.
    expect(project()[0]).toMatchObject({ key: "pipeline:cold-done:done", title: "" });
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
