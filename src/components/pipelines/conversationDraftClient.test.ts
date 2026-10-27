import { expect, test } from "bun:test";

import type { ConversationDraftRequest } from "@/lib/pipelines/conversationDraftContract";
import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import type { PipelinePorts, PipelineWriteResult } from "@/components/kanban/pipelinePorts";

import { ConversationDrafts, conversationSourceFile, postConversationDraft, readConversationPreview, type ConversationSource, type CreateOutcome, type PreviewOutcome } from "./conversationDraftClient";

/* The browser side of a pipeline drafted from a conversation
   (docs/design/start-pipeline-from-conversation/implementation.md): which
   conversation the card names, how the route's answers read, and the one
   request per logical draft the store sends. Invented records; the route is
   a stub answering what the real one answers. */

const file = (id: string | undefined, mtime: number, cwd: string | null = "/repo"): FileEntry => ({ path: `/t/${id ?? "none"}-${mtime}.jsonl`, conversationId: id, mtime, cwd, title: id } as FileEntry);

test("the card names its newest conversation with a recorded folder, one row per conversation", () => {
  expect(conversationSourceFile([])).toBeNull();
  expect(conversationSourceFile([file(undefined, 9)])).toBeNull();
  /* A newer row without a folder loses to an older one with it. */
  expect(conversationSourceFile([file("a", 5), file("b", 9, null)])?.conversationId).toBe("a");
  /* Without any folder the newest still stands, so the server can recover one. */
  expect(conversationSourceFile([file("a", 5, null), file("b", 9, null)])?.conversationId).toBe("b");
  /* Generations of one conversation count once, at their newest. */
  const newest = conversationSourceFile([file("a", 3), file("b", 6), file("a", 8)]);
  expect([newest?.conversationId, newest?.mtime]).toEqual(["a", 8]);
  /* Equal times fall to the id, so the choice never depends on list order. */
  expect(conversationSourceFile([file("b", 4), file("a", 4)])?.conversationId).toBe("a");
  expect(conversationSourceFile([file("a", 4), file("b", 4)])?.conversationId).toBe("a");
});

const respond = (status: number, body: unknown) => async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const request: ConversationDraftRequest = { conversationId: "c1", taskId: "t1", sourceRevision: "rev-1", clientRequestId: "k1" };
const pipeline = (over: Partial<Pipeline> = {}) => ({ id: "p1", state: "draft", stages: [{ id: "builder", next: "reviewer" }, { id: "reviewer", next: null }], ...over }) as unknown as Pipeline;

test("a create answer is a draft, a named refusal, or unknown when nothing says what happened", async () => {
  expect(await postConversationDraft(request, respond(201, { ok: true, pipeline: pipeline() }) as unknown as typeof fetch)).toEqual({ kind: "created", pipeline: pipeline() });
  expect(await postConversationDraft(request, respond(200, { ok: true, pipeline: pipeline() }) as unknown as typeof fetch)).toEqual({ kind: "created", pipeline: pipeline() });
  expect(await postConversationDraft(request, respond(409, { error: "changed", code: "SOURCE_CHANGED" }) as unknown as typeof fetch)).toEqual({ kind: "refused", refusal: { code: "SOURCE_CHANGED", error: "changed" } });
  expect(await postConversationDraft(request, respond(503, { error: "busy", code: "store_busy", retryable: true }) as unknown as typeof fetch)).toEqual({ kind: "refused", refusal: { code: "store_busy", error: "busy", retryable: true } });
  /* The route's catch-all may follow a stored draft. */
  expect((await postConversationDraft(request, respond(500, { error: "unavailable", code: "SOURCE_UNAVAILABLE" }) as unknown as typeof fetch)).kind).toBe("unknown");
  expect((await postConversationDraft(request, respond(502, undefined) as unknown as typeof fetch)).kind).toBe("unknown");
  expect((await postConversationDraft(request, (async () => { throw new TypeError("network"); }) as unknown as typeof fetch)).kind).toBe("unknown");
  /* A success with no record is not a success. */
  expect((await postConversationDraft(request, respond(201, { ok: true }) as unknown as typeof fetch)).kind).toBe("unknown");
});

test("the preview sends only the two ids and reads the source or the refusal", async () => {
  const urls: string[] = [];
  const source: ConversationSource = { conversationId: "c1", title: "Export retry", branch: "fix/export", head: "a".repeat(40), sourceRevision: "rev", canCreate: true };
  const answered = await readConversationPreview("c1", "t 1", undefined, (async (url: string) => { urls.push(url); return respond(200, { ok: true, source })(); }) as unknown as typeof fetch);
  expect(urls).toEqual(["/api/pipelines/from-conversation?conversationId=c1&taskId=t+1"]);
  expect(answered).toEqual({ kind: "ready", source });
  expect(await readConversationPreview("c1", "t1", undefined, respond(409, { error: "nope", code: "SOURCE_WORKING_COPY_UNAVAILABLE" }) as unknown as typeof fetch)).toEqual({ kind: "failed", refusal: { code: "SOURCE_WORKING_COPY_UNAVAILABLE", error: "nope" } });
  expect(await readConversationPreview("c1", "t1", undefined, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toEqual({ kind: "failed", refusal: null });
});

/* A route that answers each post when the test releases it. */
function fakeRoute() {
  const posts: ConversationDraftRequest[] = [];
  const previews: string[] = [];
  const waiting: Array<(outcome: CreateOutcome) => void> = [];
  let held: ((outcome: PreviewOutcome) => void) | null = null;
  let hold = false;
  let preview: PreviewOutcome = { kind: "ready", source: { conversationId: "c1", title: "Export retry", branch: "fix/export", head: "b".repeat(40), sourceRevision: "rev-2", canCreate: true } };
  const applied: Pipeline[] = [];
  let keys = 0;
  const store = new ConversationDrafts({
    post: (body) => { posts.push(body); return new Promise((resolve) => waiting.push(resolve)); },
    preview: async (conversationId) => {
      previews.push(conversationId);
      return hold ? new Promise<PreviewOutcome>((resolve) => { held = resolve; }) : preview;
    },
    apply: (record) => { applied.push(record); },
    newKey: () => `key-${++keys}`,
  });
  return {
    store, posts, previews, applied,
    answer: (outcome: CreateOutcome) => waiting.shift()!(outcome),
    setPreview: (next: PreviewOutcome) => { preview = next; },
    holdPreview: () => { hold = true; },
    releasePreview: (outcome: PreviewOutcome) => held!(outcome),
  };
}
const source: ConversationSource = { conversationId: "c1", title: "Export retry", branch: "fix/export", head: "a".repeat(40), sourceRevision: "rev-1", canCreate: true };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one draft per press: a second press while it is on its way sends nothing, and the answer lands for the task's surface", async () => {
  const route = fakeRoute();
  const first = route.store.create("t1", source);
  expect(await route.store.create("t1", source)).toBeNull();
  expect(route.posts).toEqual([{ conversationId: "c1", taskId: "t1", sourceRevision: "rev-1", clientRequestId: "key-1" }]);
  expect(route.store.attempt("t1")?.phase).toBe("creating");
  route.answer({ kind: "created", pipeline: pipeline() });
  expect((await first)?.id).toBe("p1");
  expect(route.store.attempt("t1")).toBeNull();
  expect(route.applied.map((entry) => entry.id)).toEqual(["p1"]);
  expect(route.store.landedFor("t1")).toBe("p1");
  route.store.take("t1");
  expect(route.store.landedFor("t1")).toBeNull();
});

test("a create with no answer asks again under the same key and never claims a failure", async () => {
  const route = fakeRoute();
  const sent = route.store.create("t1", source);
  route.answer({ kind: "unknown", error: "offline" });
  expect(await sent).toBeNull();
  expect(route.store.attempt("t1")).toMatchObject({ phase: "unknown", refusal: null });
  /* Dismissing an answer that may have landed is not offered. */
  route.store.dismiss("t1");
  expect(route.store.attempt("t1")?.phase).toBe("unknown");
  const again = route.store.retry("t1");
  expect(route.posts.map((post) => post.clientRequestId)).toEqual(["key-1", "key-1"]);
  route.answer({ kind: "created", pipeline: pipeline() });
  expect((await again)?.id).toBe("p1");
  expect(route.previews).toEqual([]);
});

test("a passing refusal retries the same request; a changed source is only read again, and Create posts it under a new key", async () => {
  const route = fakeRoute();
  void route.store.create("t1", source);
  route.answer({ kind: "refused", refusal: { code: "store_busy", error: "busy", retryable: true } });
  await flush();
  expect(route.store.attempt("t1")?.refusal?.code).toBe("store_busy");
  void route.store.retry("t1");
  route.answer({ kind: "refused", refusal: { code: "SOURCE_CHANGED", error: "changed" } });
  await flush();
  expect(route.posts.map((post) => post.clientRequestId)).toEqual(["key-1", "key-1"]);
  /* The source changed: the task keeps the refusal until the operator checks it. */
  expect(route.store.attempt("t1")).toMatchObject({ phase: "refused", refusal: { code: "SOURCE_CHANGED" } });
  /* The conversation moved to another branch meanwhile. Checking reads it and shows it; nothing is posted. */
  route.setPreview({ kind: "ready", source: { ...source, branch: "other-branch", sourceRevision: "rev-2" } });
  expect(await route.store.retry("t1")).toBeNull();
  expect(route.previews).toEqual(["c1"]);
  expect(route.posts).toHaveLength(2);
  expect(route.store.attempt("t1")).toMatchObject({ phase: "checked", refusal: null, source: { branch: "other-branch" }, checked: { sourceRevision: "rev-2" } });
  /* A second check press while it shows sends nothing either. */
  expect(await route.store.retry("t1")).toBeNull();
  expect([route.previews.length, route.posts.length]).toEqual([1, 2]);
  const fresh = route.store.create("t1", route.store.attempt("t1")!.checked!);
  expect(route.posts.at(-1)).toEqual({ conversationId: "c1", taskId: "t1", sourceRevision: "rev-2", clientRequestId: "key-2" });
  route.answer({ kind: "created", pipeline: pipeline() });
  expect((await fresh)?.id).toBe("p1");
});

test("a source read again can be closed without posting, and a read that fails is checked again, never answered by the refused request", async () => {
  const route = fakeRoute();
  void route.store.create("t1", source);
  route.answer({ kind: "refused", refusal: { code: "SOURCE_NOT_ON_TASK", error: "gone" } });
  await flush();
  route.setPreview({ kind: "failed", refusal: { code: "store_busy", error: "busy", retryable: true } });
  await route.store.retry("t1");
  /* The busy read keeps its reason; the next press reads again. */
  expect(route.store.attempt("t1")).toMatchObject({ phase: "refused", refusal: { code: "store_busy" } });
  expect(route.store.attempt("t1")?.refusal?.retryable).toBeUndefined();
  route.setPreview({ kind: "ready", source: { ...source, sourceRevision: "rev-2" } });
  await route.store.retry("t1");
  expect(route.previews).toEqual(["c1", "c1"]);
  expect(route.posts).toHaveLength(1);
  expect(route.store.attempt("t1")?.phase).toBe("checked");
  route.store.dismiss("t1");
  expect(route.store.attempt("t1")).toBeNull();
  expect(route.posts).toHaveLength(1);
});

test("a check still reading holds the menu row and Close, and what it read is shown", async () => {
  const route = fakeRoute();
  void route.store.create("t1", source);
  route.answer({ kind: "refused", refusal: { code: "SOURCE_CHANGED", error: "changed" } });
  await flush();
  route.holdPreview();
  const checking = route.store.retry("t1");
  await flush();
  expect(route.store.attempt("t1")?.phase).toBe("checking");
  expect(await route.store.create("t1", source)).toBeNull();
  expect(await route.store.retry("t1")).toBeNull();
  route.store.dismiss("t1");
  expect(route.posts).toHaveLength(1);
  expect(route.previews).toHaveLength(1);
  route.releasePreview({ kind: "ready", source: { ...source, sourceRevision: "rev-2" } });
  await checking;
  expect(route.store.attempt("t1")).toMatchObject({ phase: "checked", checked: { sourceRevision: "rev-2" } });
  expect(route.posts).toHaveLength(1);
});

test("choosing the row again while a create has no answer asks again under the same key, never a new one", async () => {
  const route = fakeRoute();
  void route.store.create("t1", source);
  route.answer({ kind: "unknown", error: "offline" });
  await flush();
  expect(route.store.attempt("t1")?.phase).toBe("unknown");
  /* The menu read a newer revision meanwhile; the pending request still stands for it. */
  const again = route.store.create("t1", { ...source, branch: "other-branch", sourceRevision: "rev-2" });
  expect(route.posts.map((post) => [post.clientRequestId, post.sourceRevision])).toEqual([["key-1", "rev-1"], ["key-1", "rev-1"]]);
  expect(route.store.attempt("t1")).toMatchObject({ phase: "creating", source: { branch: "fix/export" } });
  route.answer({ kind: "unknown", error: "offline" });
  await again;
  void route.store.create("t1", source);
  expect(new Set(route.posts.map((post) => post.clientRequestId))).toEqual(new Set(["key-1"]));
  route.answer({ kind: "created", pipeline: pipeline() });
  await flush();
  expect(route.store.landedFor("t1")).toBe("p1");
});

test("a changed source that can no longer be drafted keeps its reason and sends nothing", async () => {
  const route = fakeRoute();
  void route.store.create("t1", source);
  route.answer({ kind: "refused", refusal: { code: "SOURCE_CHANGED", error: "changed" } });
  await flush();
  route.setPreview({ kind: "ready", source: { ...source, sourceRevision: "rev-3", canCreate: false, refusal: { code: "SOURCE_HAS_CHANGES", error: "dirty" } } });
  expect(await route.store.retry("t1")).toBeNull();
  expect(route.posts).toHaveLength(1);
  expect(route.store.attempt("t1")).toMatchObject({ phase: "refused", refusal: { code: "SOURCE_HAS_CHANGES" } });
  route.store.dismiss("t1");
  expect(route.store.attempt("t1")).toBeNull();
});

function startPorts() {
  const patches: PatchPipelineRequest[] = [];
  const answers: PipelineWriteResult[] = [];
  let record = pipeline();
  let refreshes = 0;
  const ports: PipelinePorts = {
    read: async () => ({ pipeline: record, stageDigests: {} }),
    patch: async (_id, body) => { patches.push(body); return answers.shift() ?? { ok: true, pipeline: { ...record, state: "provisioning" } as Pipeline }; },
    refresh: () => { refreshes += 1; },
  };
  return { ports, patches, answers, setRecord: (next: Pipeline) => { record = next; }, refreshes: () => refreshes };
}

test("Start sends the engine's start once; a refusal keeps its reason, a lost answer is read before anything else", async () => {
  const route = fakeRoute();
  const ports = startPorts();
  ports.answers.push({ ok: false, status: 409, error: "add at least 1 stage before starting" });
  await route.store.startDraft(pipeline(), ports.ports);
  expect(ports.patches).toEqual([{ action: "start" }]);
  expect(route.store.start("p1")).toEqual({ phase: "refused", error: "add at least 1 stage before starting" });

  ports.answers.push({ ok: false, status: 0, error: "offline", unknown: true });
  await route.store.startDraft(pipeline(), ports.ports);
  expect(route.store.start("p1")?.phase).toBe("unknown");
  /* The lane left its draft: Start landed, whoever sent it, and nothing is sent again. */
  ports.setRecord(pipeline({ state: "running" }));
  await route.store.checkStart("p1", ports.ports);
  expect(route.store.start("p1")).toBeNull();
  expect(ports.patches).toHaveLength(2);
  expect(route.applied.at(-1)?.state).toBe("running");

  await route.store.startDraft(pipeline(), ports.ports);
  expect(ports.patches).toHaveLength(3);
  expect(route.store.start("p1")).toBeNull();
});

test("a Start still on its way takes no second press", async () => {
  const route = fakeRoute();
  const ports = startPorts();
  let release: (result: PipelineWriteResult) => void = () => {};
  ports.ports.patch = async (_id, body) => { ports.patches.push(body); return new Promise((resolve) => { release = resolve; }); };
  const first = route.store.startDraft(pipeline(), ports.ports);
  await route.store.startDraft(pipeline(), ports.ports);
  expect(ports.patches).toHaveLength(1);
  expect(route.store.start("p1")?.phase).toBe("starting");
  release({ ok: true, pipeline: pipeline({ state: "provisioning" }) });
  await first;
  expect(route.store.start("p1")).toBeNull();
});
