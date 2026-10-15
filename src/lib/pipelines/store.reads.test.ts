import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPipelineListRecords, projectPipelineCompactRows, selectPipelineListRecords } from "./listProjection";
import { archiveSettledPipelines, buildPipeline, findPipelineRecord, loadArchivedPipelines, loadPipelinesForList, savePipelines } from "./store";

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
