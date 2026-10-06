import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-lifecycle-http-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");

// Exercise the real engine and validator: a mocked patch cannot expose #1789.
const { createPipelineFromRequest } = await import("@/lib/pipelines/engine");
const { findPipelineRecord, loadPipelinesForStartup } = await import("@/lib/pipelines/store");
const { DELETE, GET, PATCH } = await import("./route");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test.each(["close", "delete", "DELETE"] as const)("HTTP %s discards a stageless draft and retains a valid record", async (action) => {
  const created = await createPipelineFromRequest({
    task: `Discard stageless draft via ${action}`, repoDir: process.cwd(), autoStart: false, stages: [],
  }, undefined, { allowOperatorDraftWithoutLineage: true });
  expect(created.error).toBeUndefined();
  const draft = created.pipeline!;
  expect(draft.state).toBe("draft");
  expect(draft.stages).toEqual([]);
  expect(findPipelineRecord(draft.id)).toEqual(draft);

  const url = `http://127.0.0.1/api/pipelines/${draft.id}`;
  const context = { params: Promise.resolve({ id: draft.id }) };
  const response = action === "DELETE"
    ? await DELETE(new NextRequest(url, { method: "DELETE", headers: { host: "127.0.0.1" } }), context)
    : await PATCH(new NextRequest(url, {
      method: "PATCH", headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }), context);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, pipeline: { id: draft.id, state: "closed", stages: [], runs: [], cursor: null } });
  expect(body.pipeline.closedAt).toEqual(expect.any(String));
  expect(body.pipeline.hiddenAt).toBe(body.pipeline.closedAt);
  expect(findPipelineRecord(draft.id)).toEqual(body.pipeline);
  expect(loadPipelinesForStartup().find((pipeline) => pipeline.id === draft.id)).toEqual(body.pipeline);
  const read = await GET(new NextRequest(url), context);
  expect(read.status).toBe(200);
  expect((await read.json()).pipeline).toEqual(body.pipeline);
});
