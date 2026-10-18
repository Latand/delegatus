import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadPipelineListRecords, projectPipelineCompactRows, selectPipelineListRecords } from "./listProjection";
import { archiveSettledPipelines, buildPipeline, findPipelineRecord, loadArchivedPipelines, loadArchivedPipelinesForList, loadPipelinesForList, savePipelines } from "./store";
import { projectKeyIndexSnapshot } from "@/lib/projects/projectKeyIndex";
import type { Pipeline } from "./types";

test("compiled stores share readonly data while nested snapshots and aborted mutations stay independent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shared-reads-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  try {
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "store.ts")],
      target: "bun", outdir: root, naming: "store-a.mjs" });
    expect(built.success).toBe(true);
    fs.copyFileSync(path.join(root, "store-a.mjs"), path.join(root, "store-b.mjs"));
    const first: typeof import("./store") = await import(pathToFileURL(path.join(root, "store-a.mjs")).href);
    const second: typeof import("./store") = await import(pathToFileURL(path.join(root, "store-b.mjs")).href);
    const pipeline = buildPipeline({ id: "shared-nested", task: "Shared snapshot", project: "fixture", repoDir: "/repo",
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        role: { roleId: "builder", params: { scope: "original" } }, outputs: ["evidence"],
        effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: "Build {{scope}}" } }],
      srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
    pipeline.state = "running";
    pipeline.runs[0]!.attempts.push({ n: 1, state: "failed", effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
      launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
      startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, error: null,
      verdict: { status: "fail", findings: ["P2 — original finding"], rankedFindings: [{ severity: "P2", text: "original finding" }] } });
    first.savePipelines([pipeline]);
    const baseline = structuredClone(second.loadPipelines());
    const shared = first.loadPipelinesForList();
    expect(second.loadPipelinesForList()).toBe(shared);
    const edit = (copy: Pipeline) => {
      copy.stages[0]!.effectiveRole.effort = "xhigh";
      copy.stages[0]!.role!.params!.scope = "edited";
      copy.stages[0]!.outputs!.push("edited");
      copy.runs[0]!.attempts[0]!.effectiveRole.effort = "xhigh";
      copy.runs[0]!.attempts[0]!.verdict!.findings!.push("P1 — edited");
      copy.runs[0]!.attempts[0]!.verdict!.rankedFindings![0]!.text = "edited";
    };
    const unchanged = () => {
      expect(first.loadPipelines()).toEqual(baseline);
      expect(second.loadPipelines()).toEqual(baseline);
      expect(first.loadPipelinesForList()).toBe(shared);
      expect(second.findPipelineRecord(pipeline.id)).toEqual(baseline[0]!);
    };
    for (const read of [first.loadPipelines, first.loadPipelinesForProjection, first.loadPipelinesAsync]) {
      edit((await read())[0]!);
      unchanged();
    }
    await first.withPipelineStartupAdmission(async available => {
      expect(available).toBe(true);
      edit(first.loadPipelinesForStartup()[0]!);
      expect(first.loadPipelinesForStartup()).toEqual(baseline);
      edit((await first.loadPipelinesForStartupAsync())[0]!);
      expect(await first.loadPipelinesForStartupAsync()).toEqual(baseline);
    });
    unchanged();
    await first.withPipelineMutation(records => { edit(records[0]!); });
    unchanged();
    await expect(first.withPipelineMutation(records => { edit(records[0]!); throw new Error("abort nested edit"); }))
      .rejects.toThrow("abort nested edit");
    unchanged();
    await expect(first.withPipelineControllerMutation(records => { edit(records[0]!); throw new Error("abort controller edit"); }))
      .rejects.toThrow("abort controller edit");
    unchanged();
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("warm pipeline list reads reuse project membership for the cached registry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-project-membership-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const records = Array.from({ length: 100 }, (_, index) => buildPipeline({
      id: `membership-${index}`, task: `Membership ${index}`, project: `project-${index % 5}`, repoDir: "/repo",
      stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z",
    }));
    savePipelines(records);
    const shared = loadPipelinesForList();
    const stat = spyOn(fs, "statSync");
    try {
      for (let pass = 0; pass < 3; pass++) expect(loadPipelinesForList()).toBe(shared);
      expect(stat.mock.calls.filter(([filename]) => String(filename).endsWith("project-aliases.json")).length).toBeLessThanOrEqual(9);
    } finally { stat.mockRestore(); }
    fs.writeFileSync(path.join(root, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { "project-0": "renamed-project" }, displayNames: {} }));
    loadPipelinesForList();
    expect(projectKeyIndexSnapshot().has("renamed-project")).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed-inclusive pages preserve filters, order and details without decoding the whole archive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-list-reads-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  const record = (id: string, project: string, closed: boolean) => {
    const pipeline = buildPipeline({ id, task: id, project, repoDir: "/repo",
      stages: [{ id: "build", kind: "run", prompt: `full prompt ${id}`, next: null,
        effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
    if (closed) { pipeline.state = "closed"; pipeline.cursor = null; pipeline.closedAt = "2026-07-02T00:00:00.000Z"; }
    return pipeline;
  };
  try {
    savePipelines(Array.from({ length: 40 }, (_, i) => record(`cold-${i}`, i % 2 ? "other" : "fixture", true)));
    expect(await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"))).toBe(40);
    savePipelines([record("hot", "fixture", false), record("other-hot", "other", false)]);
    const all = [...loadPipelinesForList(), ...loadArchivedPipelines()];
    for (const filter of [{ includeClosed: true, limit: 3 }, { project: "fixture", includeClosed: true, limit: 4 },
      { project: "none", includeClosed: true }, { state: "closed", includeClosed: true, limit: 2 },
      { state: "open", includeClosed: true }, { project: "fixture", limit: 1 }]) {
      expect(await loadPipelineListRecords(filter)).toEqual(selectPipelineListRecords(all, filter));
    }
    const parse = spyOn(JSON, "parse");
    try {
      const page = await loadPipelineListRecords({ includeClosed: true, limit: 3 });
      const bodies = parse.mock.calls.filter(([raw]) => typeof raw === "string" && raw.includes('"id":"cold-'));
      expect(bodies).toHaveLength(1);
      expect(page[2]!.stages[0]!.prompt).toBe("full prompt cold-0");
      page[2]!.stages[0]!.prompt = "caller edit";
      expect(findPipelineRecord("cold-0")!.stages[0]!.prompt).toBe("full prompt cold-0");
    } finally { parse.mockRestore(); }
    const rows = await projectPipelineCompactRows({ includeClosed: true, limit: 3 });
    expect(rows.map(r => r.id)).toEqual(["hot", "other-hot", "cold-0"]);
    let checks = 0;
    await expect(projectPipelineCompactRows({ project: "none", includeClosed: true }, {
      checkpoint: () => { if (++checks > 3) throw new Error("cancelled"); },
    })).rejects.toThrow("cancelled");
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("done, album and seat readers share the frozen archive and observe revisions immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-archive-reads-"));
  const prior = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
  try {
    const lane = buildPipeline({ id: "archived-fixture", task: "Archived work", project: "fixture", repoDir: "/repo",
      taskIds: ["task-fixture"], stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
        effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
    lane.state = "closed"; lane.cursor = null; lane.closedAt = "2026-07-02T00:00:00.000Z";
    savePipelines([lane]);
    await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"));
    const frozen = loadArchivedPipelinesForList();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0]!.stages[0]!.effectiveRole)).toBe(true);
    const original = JSON.stringify(frozen);
    const { productionDoneWorld } = await import("@/lib/done/world");
    const { productionAlbumWorld } = await import("@/lib/taskAlbum/world");
    const { taskAlbumTranscripts } = await import("@/lib/taskAlbum/sources");
    const { defaultSeatTickSources, pipelineSummary } = await import("@/lib/monitor/seatTickSources");
    const { runDoneSweepOnce } = await import("@/lib/done/sweep");
    const { viewerLoopMonitor } = await import("@/lib/viewerLoopMonitor");
    const album = productionAlbumWorld();
    const sources = defaultSeatTickSources();
    expect(sources.archivedPipelines()).toBe(frozen);
    expect(album.pipelines()[0]).toBe(frozen[0]!);
    expect(productionDoneWorld().pipelines()[0]).toBe(frozen[0]!);
    expect(taskAlbumTranscripts("task-fixture", { ...album,
      task: () => ({ assignments: [] } as unknown as import("@/lib/tasks/types").BoardTask) })).toEqual([]);
    expect(pipelineSummary(frozen[0]!)).toBeDefined();
    const world = () => ({ ...productionDoneWorld(), now: () => Date.parse("2026-08-01T00:00:00Z"),
      preserveFrame: undefined, removeFrames: undefined });
    expect(await runDoneSweepOnce({ ownsTraffic: async () => {
      expect(viewerLoopMonitor.current()).toBe("done.sweep"); return true;
    }, world })).toBe(true);
    expect(await runDoneSweepOnce({ ownsTraffic: async () => false, world: () => { throw Error("must not read"); } })).toBe(false);
    await expect(runDoneSweepOnce({ ownsTraffic: async () => true, world: () => { throw Error("fixture refusal"); } })).rejects.toThrow("fixture refusal");
    expect(viewerLoopMonitor.current()).toBeUndefined();
    const mutable = loadArchivedPipelines(); mutable[0]!.stages[0]!.prompt = "Caller overlay";
    expect(JSON.stringify(loadArchivedPipelinesForList())).toBe(original);
    const next = buildPipeline({ id: "new-archive-fixture", task: lane.task, project: lane.project,
      repoDir: lane.repoDir, stages: lane.stages, srcPath: null, srcConversationId: null, now: lane.createdAt });
    next.state = "closed"; next.cursor = null; next.closedAt = lane.closedAt;
    savePipelines([next]);
    await archiveSettledPipelines(Date.parse("2026-08-01T00:00:00Z"));
    const updated = loadArchivedPipelinesForList();
    expect(updated).not.toBe(frozen);
    expect(updated.map(row => row.id)).toEqual([lane.id, next.id]);
    expect(productionAlbumWorld().pipelines()).toHaveLength(2);
    expect(productionDoneWorld().pipelines()).toHaveLength(2);
    expect(sources.archivedPipelines()).toBe(updated);
    expect(Object.isFrozen(updated[1]!.stages[0]!)).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
