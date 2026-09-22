import { expect, test } from "bun:test";

import { diffFilesRepresentations } from "@/lib/filesDelta";

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
