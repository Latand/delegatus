import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { PIPELINE_TEMPLATES, createDraftPipeline } from "./pipelineModel";

/* createDraftPipeline posts a preflight-approved repository as a draft. */
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Event: dom.Event,
});

const realFetch = globalThis.fetch;
afterEach(() => {
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

test("a PR source drafts with its title, followed base, PR delivery and linked task, and attaches nothing", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, json: async () => ({ pipeline: { id: "p12" } }) };
  }) as unknown as typeof fetch;

  const result = await createDraftPipeline("demo", "/repo", undefined, undefined, { source: PR_SOURCE, taskId: "task-1" });
  expect(result).toEqual({ pipeline: { id: "p12" } as never });
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
