import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadPipelineListRecords, projectPipelineCompactRows, selectPipelineListRecords } from "./listProjection";
import { archiveSettledPipelines, buildPipeline, findPipelineRecord, loadArchivedPipelines, loadPipelinesForList, savePipelines } from "./store";
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
