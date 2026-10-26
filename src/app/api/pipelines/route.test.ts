import { afterAll, expect, test, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

const previousStateDir = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipeline-route-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
const creatorPath = path.join(process.env.LLV_CODEX_HOME, "sessions", "creator.jsonl");
fs.mkdirSync(path.dirname(creatorPath), { recursive: true });
fs.writeFileSync(creatorPath, "{}\n");
/* The sandbox's Codex account is signed in: a stage on an engine with nobody
   signed in is refused at start (#1876), and these cases start pipelines. */
fs.writeFileSync(path.join(process.env.LLV_CODEX_HOME, "auth.json"), "{}\n");
const { GET, POST } = await import("./route");
const { agentRegistry } = await import("@/lib/agent/registry");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const collectionRequest = (query = "") => new NextRequest(`http://127.0.0.1/api/pipelines${query}`);
const CURRENT_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
agentRegistry().ensureConversation("codex", creatorPath, null);

test("pipeline responses preserve full JSON and serialize only rows requested by the reader", async () => {
  const { buildPipeline, loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
  const previous = loadPipelines();
  const records = ["one", "two", "three"].map(id => buildPipeline({ id, task: `Unicode \"${id}\"\nрядок 😀`,
    project: "fixture", repoDir: "/repo", stages: [{ id: "build", kind: "run", prompt: "full prompt", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00.000Z" }));
  try {
    savePipelines(records);
    const expected = loadPipelines();
    expect(await (await GET(collectionRequest())).json()).toEqual({ pipelines: expected });
    const stringify = spyOn(JSON, "stringify");
    try {
      const response = await GET(collectionRequest());
      const encodedRows = () => stringify.mock.calls.filter(([value]) => records.some(r => r.id === (value as { id?: string })?.id)).length;
      expect(encodedRows()).toBe(0);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"pipelines":[');
      expect(encodedRows()).toBe(0);
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(first)).toEqual(expected[0]);
      expect(encodedRows()).toBe(1);
      await reader.cancel();
      await Bun.sleep(10);
      expect(encodedRows()).toBe(1);
    } finally { stringify.mockRestore(); }
    savePipelines([]);
    expect(await (await GET(collectionRequest())).text()).toBe('{"pipelines":[]}');
  } finally { savePipelines(previous); }
});

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("pipeline collection route mirrors flow GET and POST shapes", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  expect(await (await GET(collectionRequest())).json()).toEqual({ pipelines: [] });
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      task: "ship",
      src: creatorPath,
      repoDir: process.cwd(),
      baseRef: CURRENT_HEAD,
      stages: [
        { id: "build", kind: "run", prompt: "build", next: "verify" },
        { id: "verify", kind: "run", prompt: "verify", next: null },
      ],
    }),
  });
  const response = await POST(request);
  expect(response.status).toBe(201);
  const body = await response.json() as { ok: boolean; pipeline: { id: string; state: string; baseBranch: string; baseRef: string; lastPassedCommit: string; stages: { id: string; effectiveRole: { effort: string } }[] } };
  expect(body.ok).toBe(true);
  expect(body.pipeline.state).toBe("provisioning");
  expect(body.pipeline.baseBranch).toBe("main");
  expect(body.pipeline.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(body.pipeline.lastPassedCommit).toBe(body.pipeline.baseRef);
  expect(body.pipeline.stages.map((stage) => stage.id)).toEqual(["build", "verify"]);
  expect(body.pipeline.stages[0]!.effectiveRole.effort).toBe("high");
  await Promise.resolve();
  expect(ticks).toBe(1);
  unregister();
});

/* #1845 defect B: the collection GET read no query at all, so a project filter
   answered every pipeline of every project — 5 MB — and a project with no
   pipelines answered the same 5 MB rather than nothing. */
test("pipeline collection GET honours the list filters and refuses a parameter it does not read (#1845)", async () => {
  const unfiltered = await (await GET(collectionRequest())).json() as { pipelines: Array<{ id: string; project: string; state: string }> };
  expect(unfiltered.pipelines.length).toBeGreaterThan(0);
  const project = unfiltered.pipelines[0]!.project;

  const mine = await (await GET(collectionRequest(`?project=${encodeURIComponent(project)}`))).json() as typeof unfiltered;
  expect(mine.pipelines.map((pipeline) => pipeline.id)).toEqual(unfiltered.pipelines.filter((pipeline) => pipeline.project === project).map((pipeline) => pipeline.id));
  /* Whole records still, for a caller that reads runs and verdicts. */
  expect(mine.pipelines[0]).toHaveProperty("stages");
  expect(mine.pipelines[0]).toHaveProperty("runs");

  expect(await (await GET(collectionRequest("?project=nonexistent-x"))).json()).toEqual({ pipelines: [] });
  const open = await (await GET(collectionRequest(`?project=${encodeURIComponent(project)}&state=open&limit=1`))).json() as typeof unfiltered;
  expect(open.pipelines).toHaveLength(1);
  expect(["completed", "closed"]).not.toContain(open.pipelines[0]!.state);

  const refused = await GET(collectionRequest("?projct=typo"));
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toContain("projct");
});

/* #1799: the HTTP door answers on the same terms the MCP one does — the base
   is the controller's to resolve, so nothing here waits on a remote. The test
   would be reaching this repository's real origin if it did. */
test("pipeline POST without baseRef answers at once with the base unresolved (#1799)", async () => {
  const unregister = registerPipelineTick(async () => {});
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      task: "answer before the fetch",
      src: creatorPath,
      repoDir: process.cwd(),
      stages: [{ id: "build", kind: "run", prompt: "build", next: null }],
    }),
  });
  const response = await POST(request);
  expect(response.status).toBe(201);
  const body = await response.json() as { pipeline: { state: string; baseBranch: string; baseRef: string; lastPassedCommit: string; stateDetail: string | null } };
  expect(body.pipeline).toMatchObject({
    state: "provisioning",
    baseBranch: "main",
    baseRef: "",
    lastPassedCommit: "",
    stateDetail: "resolving the pipeline base and provisioning the worktree",
  });
  unregister();
});

test("pipeline POST returns a persisted draft id for autoStart false", async () => {
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({
      task: "review before start",
      src: creatorPath,
      repoDir: process.cwd(),
      autoStart: false,
      stages: [
        { id: "build", kind: "run", prompt: "build", next: "verify" },
        { id: "verify", kind: "run", prompt: "verify", next: null },
      ],
    }),
  });
  const response = await POST(request);
  const body = await response.json() as { ok: boolean; pipeline: { id: string; state: string } };
  expect(response.status).toBe(201);
  expect(body).toMatchObject({ ok: true, pipeline: { state: "draft" } });
  expect(body.pipeline.id.length).toBeGreaterThan(0);
  await Promise.resolve();
  expect(ticks).toBe(0);
  unregister();
});

test("same-origin desktop and mobile global actions create an operator draft without a transcript", async () => {
  const request = new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST",
    headers: {
      cookie: `llv_operator=${soloBrowserSession()}`,
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      task: "global pipeline action",
      repoDir: process.cwd(),
      autoStart: false,
      stages: [{ id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null }],
    }),
  });

  const response = await POST(request);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    ok: true,
    pipeline: {
      state: "draft",
      srcPath: null,
      srcConversationId: null,
    },
  });
});

test("pipeline POST rejects malformed JSON", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1" }, body: "{" }));
  expect(response.status).toBe(400);
});

test("pipeline POST rejects non-object JSON", async () => {
  for (const body of ["null", "[]"]) {
    const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", { method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1" }, body }));
    expect(response.status).toBe(400);
  }
});

test("pipeline POST refuses the state directory with its safety reason", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ task: "blocked", src: creatorPath, repoDir: process.env.LLV_STATE_DIR, autoStart: false, stages: [] }),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "initialization refused for the Delegatus state directory", code: "initialization_refused", field: "repoDir", path: process.env.LLV_STATE_DIR,
  });
  expect((await GET(collectionRequest())).status).toBe(200);
});

test("pipeline POST creates a draft in a plain folder and returns its initialization inventory", async () => {
  const folder = fs.mkdtempSync(path.join(sandbox, "board-project-"));
  fs.writeFileSync(path.join(folder, "readme.txt"), "Project\n");
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ task: "New project", src: creatorPath, repoDir: folder, autoStart: false, stages: [] }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.repositoryInitialization.committedFiles).toEqual([".gitignore", "readme.txt"]);
  expect(body.repositoryInitialization.defaultIgnorePatterns).toContain(".env*");
  expect(body.pipeline.state).toBe("draft");
  expect(body.pipeline.delivery.target.remote).toBe("");
});


test("a cookie-free pipeline create cannot admit private home roots", async () => {
  const { loadPipelines } = await import("@/lib/pipelines/store");
  const before = loadPipelines().map(pipeline => pipeline.id);
  const privateRoot = path.join(sandbox, ".config");
  fs.mkdirSync(privateRoot, { recursive: true });
  const response = await POST(new NextRequest("http://127.0.0.1/api/pipelines", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ task: "Untrusted root", src: creatorPath, repoDir: privateRoot, autoStart: false, stages: [] }),
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("verified session") });
  expect(loadPipelines().map(pipeline => pipeline.id)).toEqual(before);
});
