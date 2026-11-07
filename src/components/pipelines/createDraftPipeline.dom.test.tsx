import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";

import { PIPELINE_TEMPLATES, createDraftPipeline } from "./pipelineModel";
import { setTeamViewForTests } from "@/components/team/teamClient";
import { attachPipelineCreationLink, retryPipelineCreationRead, resetFilesClientCacheForTests } from "@/hooks/useFiles";
import { memoryFilesSnapshotStore } from "@/lib/client/filesSnapshotStore";
import * as filesClient from "@/hooks/useFiles";

/* createDraftPipeline posts a preflight-approved repository as a draft. */
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
});

const realFetch = globalThis.fetch;
let storage = memoryFilesSnapshotStore();
beforeEach(() => {
  setTeamViewForTests({ mode: "solo", me: null, members: [], methods: {
    approval: false, telegram: { available: false, botUsername: null }, passkey: { available: false },
  } });
  storage = memoryFilesSnapshotStore();
  resetFilesClientCacheForTests(storage);
});
afterEach(() => {
  resetFilesClientCacheForTests();
  setTeamViewForTests(null);
  globalThis.fetch = realFetch;
});

test("POSTs an autoStart:false draft seeded with the default implement action (#353)", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p9" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/repo");
  expect(result.pipeline?.id).toBe("p9");
  const post = requests.find((request) => request.url === "/api/pipelines");
  const body = post?.body as { autoStart?: boolean; repoDir?: string; stages?: unknown[] };
  expect(body?.autoStart).toBe(false);
  expect(body?.repoDir).toBe("/repo");
  expect(requests.map((request) => request.url)).toEqual(["/api/pipelines"]);
  /* Every fresh draft carries the default implement action (#353) — no empty
     shell ever reaches the board; the 1-stage floor is enforced at Start. */
  expect(body?.stages).toEqual([{ id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null }]);
});

test("uses the explicit canonical repo prefill", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return { ok: true, json: async () => ({ pipeline: { id: "p10" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/explicit/repo");
  expect(result.pipeline?.id).toBe("p10");
  expect(requests.some((url) => url.startsWith("/api/spawn"))).toBe(false);
});

test("surfaces an error and never fetches when the preflight repo is absent", async () => {
  let posted = false;
  globalThis.fetch = (async () => {
    posted = true;
    return { ok: true, json: async () => ({ pipeline: { id: "x" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo");
  expect(result.pipeline).toBeUndefined();
  expect(result.error).toBeTruthy();
  expect(posted).toBe(false);
});

test("a template POSTs the draft WITH the template's full role chain (#196 template-first)", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p11" } }) };
  }) as unknown as typeof fetch;

  const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === "planBuildReview")!;
  const result = await createDraftPipeline("demo", "/repo", template);
  expect(result.pipeline?.id).toBe("p11");
  const post = requests.find((request) => request.url === "/api/pipelines");
  const body = post?.body as { autoStart?: boolean; stages?: Array<{ kind: string; role?: { roleId: string }; next: string | null }> };
  /* Still a DRAFT — nothing spawns; but every role stage is already in the plan,
     so the canvas renders the whole chain as placeholders immediately. */
  expect(body?.autoStart).toBe(false);
  expect(body?.stages?.map((s) => s.role?.roleId)).toEqual(["architect", "builder", "reviewer", "builder"]);
  expect(body?.stages?.map((s) => s.kind)).toEqual(["run", "run", "run", "run"]);
  expect(body?.stages?.at(-1)?.next).toBe("reviewer");
});

/* A pasted PR or issue (docs/research/competitors-2026-10.md rank 4). */
const PR_SOURCE = {
  kind: "pr" as const, repository: "owner/project", number: 41, url: "https://github.com/owner/project/pull/41", title: "Links", state: "open" as const,
  base: { branch: "release" }, head: { branch: "feature/links", sha: "a".repeat(40), repository: "owner/project", remote: "origin", fork: false, maintainerCanModify: null },
  tasks: [{ id: "task-1", text: "Linked", updatedAt: "2026-10-22T09:00:00Z" }],
  request: { task: "PR #41: Links", spec: "Source: https://github.com/owner/project/pull/41", baseBranch: "release",
    delivery: { branch: "refs/heads/feature/links", remote: "origin", pr: 41 } },
  attachLink: null,
};

test("accepted source draft keeps one ID across reload and reads the stored links before a manual attachment", async () => {
  const pipeline = { id: "queued-source", project: "demo", task: "Attach the source", taskIds: [], state: "draft", createdAt: "2030-01-01T00:00:00Z", stages: [], runs: [], workLinks: [] as unknown[] };
  const source = { ...PR_SOURCE, kind: "issue" as const, attachLink: "owner/project#7" };
  const calls: string[] = [];
  let materialized = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return Response.json({ pipeline, queued: { queuedAt: pipeline.createdAt, reason: "store_unavailable" } }, { status: 202 });
    if (init?.method === "PATCH") {
      pipeline.workLinks = [{ repository: "owner/project", number: 7, kind: "issue" }];
      // The write completed; its acknowledgement was lost.
      throw new Error("acknowledgement unavailable");
    }
    return materialized ? Response.json({ pipeline }) : Response.json({ code: "pipeline_queued", queuedCreation: {
      id: pipeline.id, project: pipeline.project, title: pipeline.task, taskIds: [], queuedAt: pipeline.createdAt, state: "queued", reason: "store_unavailable",
    } }, { status: 404 });
  }) as typeof fetch;
  const result = await createDraftPipeline("demo", "/repo", undefined, undefined, { source, taskId: null });
  expect(result.accepted).toBe(true);
  expect(result.pipeline?.id).toBe(pipeline.id);
  expect(calls).toEqual(["POST /api/pipelines"]);
  expect((await storage.read())?.creations?.entries).toEqual([{ id: pipeline.id, link: { attachLink: source.attachLink, kind: "issue" } }]);
  resetFilesClientCacheForTests(storage);
  await Promise.resolve(); await Promise.resolve();
  await retryPipelineCreationRead();
  materialized = true;
  await retryPipelineCreationRead();
  expect(calls.filter(call => call.startsWith("PATCH"))).toHaveLength(0);
  expect(await attachPipelineCreationLink(pipeline.id)).toBeTruthy();
  expect(await attachPipelineCreationLink(pipeline.id)).toBeNull();
  expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
  expect(calls.filter(call => call.startsWith("PATCH"))).toHaveLength(1);
});

test.each(["response", "body"])("create completion loses its authority during %s without opening or attaching", async phase => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (phase === "response") { started(); await pending; }
    return { ok: true, status: 201, json: async () => {
      if (phase === "body") { started(); await pending; }
      return { pipeline: { id: "late-source", project: "demo", task: "Private title" } };
    } };
  }) as unknown as typeof fetch;
  const result = createDraftPipeline("demo", "/repo", undefined, undefined, { source: { ...PR_SOURCE, kind: "issue", attachLink: "owner/project#7" }, taskId: null });
  await entered;
  setTeamViewForTests(null);
  expect(await result).toEqual({ error: "Access unavailable" });
  release();
  expect(calls).toEqual(["/api/pipelines"]);
  expect((await storage.read())?.creations?.entries ?? []).toEqual([]);
});

test.each([["headers", 201], ["body", 201], ["headers", 202], ["body", 202]] as const)("a timed-out %s settles without replay and ignores a late %s response", async (seam, status) => {
  const applied = spyOn(filesClient, "applyPipelineSnapshot");
  let expire!: () => void;
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === filesClient.CREATION_REQUEST_TIMEOUT_MS) expire = handler as () => void;
    return schedule(handler, delay, ...args);
  });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const signals: AbortSignal[] = [];
  let posts = 0;
  globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
    if (++posts > 1) return Response.json({ pipeline: { id: "independent" } }, { status: 201 });
    if (init?.signal) signals.push(init.signal);
    if (seam === "headers") { entered(); await held; }
    const response = Response.json({ pipeline: { id: "late", project: "demo", task: "Late work", taskIds: [] },
      queued: { queuedAt: "2030-01-01T00:00:00Z", reason: "store_unavailable" } }, { status });
    const decode = response.json.bind(response);
    response.json = async () => {
      if (seam === "body") { entered(); await held; }
      return decode();
    };
    // Deliberately ignore abort: the consumer still owes a bounded result.
    return response;
  }, { preconnect: () => {} });
  try {
    const first = createDraftPipeline("demo", "/repo");
    await started;
    expire();
    expect(await first).toEqual({ error: "Creation status unavailable" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect((await createDraftPipeline("demo", "/repo")).pipeline?.id).toBe("independent");
    release();
    // Let the released transport and body finish their promise continuations.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await storage.read())?.creations?.entries ?? []).toEqual([]);
    expect(posts).toBe(2);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.mock.calls[0]?.[0].id).toBe("independent");
  } finally { release(); timer.mockRestore(); applied.mockRestore(); }
});

test.each([false, true])("dispatch rechecks the completed reservation (revoked=%s)", async revoked => {
  const prepare = filesClient.preparePipelineCreation;
  const observer = spyOn(filesClient, "preparePipelineCreation").mockImplementation(async () => {
    const reservation = await prepare();
    if (revoked) queueMicrotask(() => setTeamViewForTests(null));
    return reservation;
  });
  let posts = 0;
  globalThis.fetch = Object.assign(async () => { posts++; return Response.json({ pipeline: { id: "fresh-create" } }, { status: 201 }); }, { preconnect: () => {} });
  try {
    const result = await createDraftPipeline("demo", "/repo");
    expect(posts).toBe(revoked ? 0 : 1);
    expect(result.pipeline?.id).toBe(revoked ? undefined : "fresh-create");
    if (revoked) expect(result.error).toBe("Access unavailable");
  } finally { observer.mockRestore(); }
});

test("eight concurrent intents reserve capacity before POST and the ninth never dispatches", async () => {
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = Object.assign(async () => { posts++; await held; return Response.json({ error: "refused" }, { status: 400 }); }, { preconnect: () => {} });
  const pending = Array.from({ length: 9 }, () => createDraftPipeline("demo", "/repo"));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(posts).toBe(8);
  release();
  const results = await Promise.all(pending);
  expect(results.filter(result => result.error === "refused")).toHaveLength(8);
  expect(results[8]?.error).toContain("tracking is full");
});

test("a PR source drafts with its title, followed base, PR delivery and linked task, and attaches nothing", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p12" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/repo", undefined, undefined, { source: PR_SOURCE, taskId: "task-1" });
  expect(result).toMatchObject({ pipeline: { id: "p12" } as never });
  expect(requests).toEqual([{ url: "/api/pipelines", body: {
    task: "PR #41: Links", repoDir: "/repo",
    stages: [{ id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}", next: null }],
    spec: "Source: https://github.com/owner/project/pull/41", baseBranch: "release",
    delivery: { branch: "refs/heads/feature/links", remote: "origin", pr: 41 },
    taskIds: ["task-1"], autoStart: false,
  } }]);
});

test("an issue source drafts on its own task and attaches the issue; a failed attach keeps the draft and says so", async () => {
  const issue = { ...PR_SOURCE, kind: "issue" as const, number: 7, head: null, tasks: [], attachLink: "owner/project#7",
    request: { task: "Issue #7: Links", spec: "Source: x", baseBranch: "trunk" } };
  for (const attachOk of [true, false]) {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/api/pipelines") return { ok: true, json: async () => ({ pipeline: { id: "p13" } }) };
      return attachOk
        ? { ok: true, status: 200, json: async () => ({ pipeline: { id: "p13", workLinks: [] } }) }
        : { ok: false, status: 409, json: async () => ({ error: "a record carries at most 20 attached links" }) };
    }) as unknown as typeof fetch;

    const result = await createDraftPipeline("demo", "/repo", undefined, undefined, { source: issue, taskId: null });
    expect(result.pipeline?.id).toBe("p13");
    expect(result.warning).toBe(attachOk ? undefined : "a record carries at most 20 attached links");
    expect((requests[0]!.body as { taskIds?: unknown }).taskIds).toBeUndefined();
    expect(requests[1]).toEqual({ url: "/api/pipelines/p13", method: "PATCH", body: { action: "attach-link", link: "owner/project#7", kind: "issue" } });
  }
});
