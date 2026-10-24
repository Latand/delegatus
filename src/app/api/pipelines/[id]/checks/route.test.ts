import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
const root = mkdtempSync(join(tmpdir(), "cloud-choice-route-"));
process.env.LLV_STATE_DIR = join(root, "state");
const { GET, POST } = await import("./route");
const { buildPipeline, savePipelines } = await import("@/lib/pipelines/store");
execFileSync("git", ["init", "-q", root]);
savePipelines([buildPipeline({ id: "lane-fixture", task: "Check the source", project: "fixture", repoDir: root,
  stages: [{ id: "build", kind: "run", prompt: "Check source", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }], srcPath: null, srcConversationId: null, now: "2026-10-24T00:00:00.000Z" })]);
const context = { params: Promise.resolve({ id: "lane-fixture" }) };
const request = (body?: unknown) => new NextRequest("http://localhost/api/pipelines/lane-fixture/checks", body === undefined ? undefined : {
  method: "POST", headers: { host: "localhost", "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body),
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("UI and MCP endpoint share persisted lane overrides and project defaults", async () => {
  expect(await (await GET(request(), context)).json()).toMatchObject({ effective: "cloud", override: null });
  expect(await (await POST(request({ scope: "project", execution: "local" }), context)).json()).toMatchObject({ effective: "local", project: "local" });
  expect(await (await POST(request({ scope: "lane", execution: "cloud" }), context)).json()).toMatchObject({ effective: "cloud", project: "local" });
  expect(await (await POST(request({ scope: "lane", execution: null }), context)).json()).toMatchObject({ effective: "local", override: null });
  expect((await POST(request({ scope: "lane", execution: "invalid" }), context)).status).toBe(400);
});

test("invalid bodies and cross-origin writes leave settings unchanged", async () => {
  const before = await (await GET(request(), context)).json();
  for (const body of [null, [], "local", {}, { scope: "toString", execution: "local" }, { scope: "lane", execution: "constructor" }]) {
    expect((await POST(request(body), context)).status).toBe(400);
  }
  const broken = new NextRequest("http://localhost/api/pipelines/lane-fixture/checks", {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: "{",
  });
  expect((await POST(broken, context)).status).toBe(400);
  const foreign = new NextRequest("http://localhost/api/pipelines/lane-fixture/checks", {
    method: "POST", headers: { host: "localhost", origin: "https://foreign.invalid", "content-type": "application/json" },
    body: JSON.stringify({ scope: "project", execution: "cloud" }),
  });
  expect((await POST(foreign, context)).status).toBe(403);
  expect(await (await GET(request(), context)).json()).toEqual(before);
});

test("stage overrides validate lane membership and preserve the lane choice", async () => {
  await POST(request({ scope: "project", execution: "cloud" }), context);
  await POST(request({ scope: "lane", execution: "local" }), context);
  expect(await (await POST(request({ scope: "stage", stageId: "build", execution: "cloud" }), context)).json()).toMatchObject({
    project: "cloud", override: "local", stageOverride: "cloud", effective: "cloud",
  });
  for (const stageId of [undefined, null, "foreign", "constructor", "__proto__"]) {
    expect((await POST(request({ scope: "stage", stageId, execution: "local" }), context)).status).toBe(400);
  }
  expect(await (await GET(request(), context)).json()).toMatchObject({ override: "local", effective: "local" });
  expect(await (await POST(request({ scope: "stage", stageId: "build", execution: null }), context)).json()).toMatchObject({ stageOverride: null, effective: "local" });
});
