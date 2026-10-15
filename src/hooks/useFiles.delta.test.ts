import { expect, test } from "bun:test";

import { diffFilesRepresentations } from "@/lib/filesDelta";
import { diffBoard } from "@/lib/boardDelta";

import { createFilesClientCache } from "./useFiles";

/* #1994: the client applies a delta only to the exact representation it
   certified, and a local overlay never leaks into that base. */

type Json = Record<string, unknown>;
const pipeline = (id: string, task: string) => ({ id, task, project: "p", state: "draft", stages: [], runs: [], cursor: null, hiddenAt: null });
const representation = (tag: string, task = "server"): Json => ({
  files: [{ path: "/a" }, { path: "/b", tag }],
  pipelines: [pipeline("p1", task)],
  tasks: [],
});

interface Seen { url: string; headers: Record<string, string> }

function scripted(steps: Array<(seen: Seen) => Response>) {
  const seen: Seen[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const request = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    seen.push(request);
    const step = steps.shift();
    if (!step) throw new Error("unexpected request");
    return step(request);
  };
  return { seen, fetcher };
}

const full = (body: Json, etag: string) => () => new Response(JSON.stringify(body), { headers: { ETag: etag } });
const delta = (from: Json, to: Json, base: string, etag: string, header = base) => () =>
  new Response(JSON.stringify({ deltas: [diffFilesRepresentations(from, to, base, etag)] }), {
    headers: { ETag: etag, "x-llv-files-delta-base": header },
  });

test("a delta is requested only against a certified ETag and lands on that exact base", async () => {
  const one = representation("one");
  const two = representation("two");
  const { seen, fetcher } = scripted([full(one, "\"e1\""), delta(one, two, "\"e1\"", "\"e2\"")]);
  const cache = createFilesClientCache(fetcher);
  const unsubscribe = cache.subscribe(() => {});
  await cache.revalidate();
  expect(seen[0]!.headers["x-llv-files-delta"]).toBeUndefined();
  const first = cache.read().files;
  await cache.revalidate();
  expect(seen[1]!.headers).toMatchObject({ "if-none-match": "\"e1\"", "x-llv-files-delta": "1" });
  const second = cache.read().files;
  expect(second[1]).toEqual({ path: "/b", tag: "two" } as never);
  expect(second[0]).toBe(first[0]);
  unsubscribe();
});

test("a delta naming another base, or ending at another ETag, is refused and replaced by one full read", async () => {
  const one = representation("one");
  const two = representation("two");
  const three = representation("three");
  const { seen, fetcher } = scripted([
    full(one, "\"e1\""),
    delta(one, two, "\"e1\"", "\"e2\"", "\"other\""),
    full(two, "\"e2\""),
    // The chain in the body ends at e2 while the response claims e3.
    () => new Response(JSON.stringify({ deltas: [diffFilesRepresentations(two, three, "\"e2\"", "\"e2x\"")] }), {
      headers: { ETag: "\"e3\"", "x-llv-files-delta-base": "\"e2\"" },
    }),
    full(three, "\"e3\""),
  ]);
  const cache = createFilesClientCache(fetcher);
  const unsubscribe = cache.subscribe(() => {});
  await cache.revalidate();
  await cache.revalidate();
  expect(seen[2]!.headers["x-llv-files-delta"]).toBeUndefined();
  expect(seen[2]!.headers["if-none-match"]).toBe("\"e1\"");
  expect(cache.read().files[1]).toEqual({ path: "/b", tag: "two" } as never);
  expect(cache.read().catalogFailures).toBe(0);

  await cache.revalidate();
  expect(seen[3]!.headers["x-llv-files-delta"]).toBe("1");
  expect(seen[4]!.headers["x-llv-files-delta"]).toBeUndefined();
  expect(cache.read().files[1]).toEqual({ path: "/b", tag: "three" } as never);
  unsubscribe();
});

test("a pinned scope never applies the global scope's representation as its delta base", async () => {
  const global = representation("global");
  const { seen, fetcher } = scripted([full(global, "\"g1\""), full(representation("pinned"), "\"p1\"")]);
  const cache = createFilesClientCache(fetcher);
  const unsubscribeGlobal = cache.subscribe(() => {});
  const unsubscribePinned = cache.subscribe(() => {}, "/pinned.jsonl");
  await cache.revalidate();
  await cache.revalidate("/pinned.jsonl");
  expect(seen[1]!.url).toContain("path=");
  expect(seen[1]!.headers["if-none-match"]).toBeUndefined();
  expect(seen[1]!.headers["x-llv-files-delta"]).toBeUndefined();
  unsubscribeGlobal();
  unsubscribePinned();
});

test("an optimistic pipeline overlay never becomes part of the delta base", async () => {
  const one = representation("one");
  const two = representation("two");
  const three = representation("two", "server-renamed");
  const { fetcher } = scripted([
    full(one, "\"e1\""),
    delta(one, two, "\"e1\"", "\"e2\""),
    delta(two, three, "\"e2\"", "\"e3\""),
  ]);
  const cache = createFilesClientCache(fetcher);
  const unsubscribe = cache.subscribe(() => {});
  await cache.revalidate();
  cache.applyPipeline(pipeline("p1", "optimistic") as never, false);
  await cache.revalidate();
  expect(cache.read().pipelines[0]?.task).toBe("optimistic");
  cache.revertPipeline("p1");
  expect(cache.read().pipelines[0]?.task).toBe("server");
  await cache.revalidate();
  expect(cache.read().pipelines[0]?.task).toBe("server-renamed");
  expect(cache.read().files[1]).toEqual({ path: "/b", tag: "two" } as never);
  unsubscribe();
});

test("an unchanged board answers 304 and keeps every published identity", async () => {
  const one = representation("one");
  const { fetcher } = scripted([full(one, "\"e1\""), () => new Response(null, { status: 304, headers: { ETag: "\"e1\"" } })]);
  const cache = createFilesClientCache(fetcher);
  const unsubscribe = cache.subscribe(() => {});
  await cache.revalidate();
  const before = cache.read();
  await cache.revalidate();
  expect(cache.read().files).toBe(before.files);
  expect(cache.read().pipelines).toBe(before.pipelines);
  unsubscribe();
});

const boardFull = (body: Json, etag: string) => () => new Response(JSON.stringify(body), {
  headers: { ETag: etag, "x-llv-board-protocol": "2" },
});
const boardDelta = (from: Json, to: Json, base: string, etag: string) => () => new Response(
  JSON.stringify({ deltas: [diffBoard(from, to, base, etag)] }), {
    headers: { ETag: etag, "x-llv-files-delta-base": base, "x-llv-board-protocol": "2" },
  });

test("v2 multi-link reconstruction equals the full-summary client state, retaining every consumer field", async () => {
  const one: Json = { ...representation("one"), boardProtocol: 2, boardScope: "epoch.scope",
    tasks: [{ id: "t1", text: "Task", details: "complete editor text", assignments: [], prototypeReview: { status: "waiting", rounds: [1] } }],
    flows: [{ id: "f1", state: "waiting" }], workflows: [{ id: "w1", members: ["t1"] }],
    seatDecisions: [{ id: "s1", state: "waiting" }], prototypeReviewNotices: [{ id: "r1", state: "open" }],
    workLinks: { tasks: { t1: { pr: 4 } }, pipelines: {} }, systemHealth: { tmux: { status: "healthy" } },
    projectCatalog: [{ project: "p", conversations: 2 }], projectAliases: { old: "p" },
    conversationAliases: { old: "new" }, launchRoutes: { "spawn:x": "new" }, pipelinesError: "temporary store refusal",
  } as Json;
  const two = structuredClone(one);
  (two.tasks as Array<Record<string, unknown>>)[0].details = "updated details";
  two.seatDecisions = [];
  delete two.pipelinesError;
  const three = structuredClone(two);
  three.files = [{ path: "/b", tag: "three" }, { path: "/new" }];
  three.flows = [];
  three.prototypeReviewNotices = [];
  const { seen, fetcher } = scripted([boardFull(one, "b1"), () => new Response(JSON.stringify({ deltas: [
    diffBoard(one, two, "b1", "b2"), diffBoard(two, three, "b2", "b3"),
  ] }), { headers: { ETag: "b3", "x-llv-files-delta-base": "b1", "x-llv-board-protocol": "2" } })]);
  const cache = createFilesClientCache(fetcher);
  const cold = createFilesClientCache(scripted([boardFull(three, "b3")]).fetcher);
  try {
    await cache.revalidate();
    const pipeline = cache.read().pipelines[0];
    await cache.revalidate();
    await cold.revalidate();
    expect(seen[0].headers["x-llv-board-protocol"]).toBe("2");
    expect(cache.certifiedGlobal()?.raw).toEqual(three);
    expect(cache.read()).toEqual(cold.read());
    expect(cache.read().pipelines[0]).toBe(pipeline);
  } finally { cache.dispose(); cold.dispose(); }
});

test("a broken v2 chain publishes nothing partial and performs one bounded legacy refetch", async () => {
  const one: Json = { ...representation("one"), boardProtocol: 2 };
  const two: Json = { ...representation("two"), boardProtocol: 2 };
  const { seen, fetcher } = scripted([boardFull(one, "b1"), () => new Response(JSON.stringify({ deltas: [
    diffBoard(one, two, "b1", "b2"), { ...diffBoard(two, one, "wrong", "b3") },
  ] }), { headers: { ETag: "b3", "x-llv-files-delta-base": "b1", "x-llv-board-protocol": "2" } }),
  () => new Response("unavailable", { status: 503 }), full(representation("legacy"), "legacy")]);
  const cache = createFilesClientCache(fetcher);
  try {
    await cache.revalidate();
    await expect(cache.revalidate()).rejects.toThrow();
    expect(cache.read().files).toEqual(one.files as never);
    expect(cache.read().catalogFailures).toBe(1);
    expect(seen[2].headers["x-llv-board-protocol"]).toBeUndefined();
    expect(seen[2].headers["x-llv-files-delta"]).toBeUndefined();
    await cache.revalidate();
    expect(cache.read().catalogFailures).toBe(0);
  } finally { cache.dispose(); }
});

test("v2 overlays remain separate and persisted versions negotiate through restart and rollback", async () => {
  const one: Json = { ...representation("one"), boardProtocol: 2, boardScope: "epoch.scope" };
  const two: Json = { ...representation("two", "server-new"), boardProtocol: 2, boardScope: "epoch.scope" };
  const { fetcher } = scripted([boardDelta(one, two, "b1", "b2"), full(representation("rollback"), "v1")]);
  const cache = createFilesClientCache(fetcher);
  try {
    expect(cache.hydrate({ etag: "unsupported", text: JSON.stringify({ ...one, boardProtocol: 3 }) })).toBe(false);
    expect(cache.hydrate({ etag: "b1", text: JSON.stringify(one) })).toBe(true);
    cache.applyPipeline(pipeline("p1", "optimistic draft") as never, false);
    await cache.revalidate();
    expect(cache.read().pipelines[0].task).toBe("optimistic draft");
    expect(cache.certifiedGlobal()?.raw.pipelines).toEqual(two.pipelines);
    cache.revertPipeline("p1");
    expect(cache.read().pipelines[0].task).toBe("server-new");
    await cache.revalidate();
    expect(cache.read().files).toEqual(representation("rollback").files as never);
  } finally { cache.dispose(); }
});

test("unknown protocol responses trigger one legacy read while auth refusal preserves the last live board", async () => {
  const { seen, fetcher } = scripted([
    boardFull({ ...representation("good"), boardProtocol: 2 }, "good"),
    () => new Response(null, { status: 304, headers: { "x-llv-board-protocol": "3" } }),
    full(representation("legacy"), "legacy"),
    () => new Response("denied", { status: 403 }),
  ]);
  const cache = createFilesClientCache(fetcher);
  try {
    await cache.revalidate();
    await cache.revalidate();
    expect(seen).toHaveLength(3);
    expect(seen[2].headers["x-llv-board-protocol"]).toBeUndefined();
    await expect(cache.revalidate()).rejects.toThrow("403");
    expect(cache.read().files).toEqual(representation("legacy").files as never);
  } finally { cache.dispose(); }
});
