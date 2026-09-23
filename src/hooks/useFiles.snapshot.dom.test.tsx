/**
 * The cached-first board (#2071, docs/design/skeletons-and-transitions.md D4).
 *
 * A new document paints the last `/api/files` answer an earlier one
 * certified, flagged `cached`, and revalidates it with the request it would
 * have made anyway: conditional on the stored ETag, so an unchanged catalog
 * costs a bodyless `304`. `loaded` keeps meaning "certified by the network in
 * this document", so nothing that acts on data runs on the snapshot.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => false,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "live" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));

const { createFilesClientCache, filesApiUrl, resetFilesClientCacheForTests, persistFilesSnapshotForTests, useFiles } = await import("./useFiles");
const { FILES_SNAPSHOT_MAX_AGE_MS, FILES_SNAPSHOT_VERSION, memoryFilesSnapshotStore, usableSnapshot } = await import("@/lib/client/filesSnapshotStore");

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});
beforeEach(() => {
  resetFilesClientCacheForTests();
});

/* An invented catalog: one project, two conversations. */
const BODY = {
  files: [
    { path: "/sessions/alpha.jsonl", title: "Run the atlas board.", project: "atlas" },
    { path: "/sessions/beta.jsonl", title: "Fix the flaky reseat test.", project: "atlas" },
  ],
  projectCatalog: [{ project: "atlas", conversations: 2, smt: 1 }],
  projectDisplayNames: { atlas: "Atlas" },
};
const ETAG = '"files-v1-abc"';
const record = (overrides: Partial<{ etag: string; text: string; savedAt: number; version: number }> = {}) => ({
  version: FILES_SNAPSHOT_VERSION,
  savedAt: Date.now(),
  etag: ETAG,
  text: JSON.stringify(BODY),
  ...overrides,
});

type Call = { url: string; headers: Record<string, string> };
function recordingFetcher(answer: () => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    return answer();
  };
  return { calls, fetcher };
}
const notModified = () => new Response(null, { status: 304, headers: { ETag: ETAG } });

test("a restored snapshot paints as cached, never as loaded", () => {
  const { fetcher } = recordingFetcher(notModified);
  const cache = createFilesClientCache(fetcher);
  expect(cache.hydrate(record())).toBe(true);
  const data = cache.readScope();
  expect(data.files.map((file) => file.path)).toEqual(BODY.files.map((file) => file.path));
  expect(data.projectDisplayNames).toEqual({ atlas: "Atlas" });
  expect(data.cached).toBe(true);
  expect(data.loaded).toBe(false);
  expect(data.scopeCertified).toBe(false);
  /* Nothing certified yet, so there is nothing to store back. */
  expect(cache.certifiedGlobal()).toBeNull();
});

test("the first request is conditional on the stored ETag, and a 304 certifies the same rows in place", async () => {
  const { calls, fetcher } = recordingFetcher(notModified);
  const cache = createFilesClientCache(fetcher);
  cache.hydrate(record());
  const before = cache.readScope();
  const after = await cache.revalidate();
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe(filesApiUrl());
  expect(calls[0]!.headers["If-None-Match"]).toBe(ETAG);
  expect(after.loaded).toBe(true);
  expect(after.cached).toBe(false);
  expect(after.scopeCertified).toBe(true);
  /* Same row objects: nothing re-renders that did not change. */
  expect(after.files).toBe(before.files);
  expect(after.files[0]).toBe(before.files[0]);
  expect(cache.certifiedGlobal()?.etag).toBe(ETAG);
});

test("a changed catalog replaces the snapshot with the full answer", async () => {
  const next = { ...BODY, files: [BODY.files[0]] };
  const { fetcher } = recordingFetcher(() => new Response(JSON.stringify(next), { status: 200, headers: { ETag: '"files-v1-def"' } }));
  const cache = createFilesClientCache(fetcher);
  cache.hydrate(record());
  const after = await cache.revalidate();
  expect(after.files.map((file) => file.path)).toEqual(["/sessions/alpha.jsonl"]);
  expect(after.loaded).toBe(true);
  expect(after.cached).toBeFalsy();
});

test("a refused browser drops what it stored", async () => {
  const accessDenied = mock(() => {});
  const cache = createFilesClientCache(recordingFetcher(() => new Response("", { status: 401 })).fetcher, { accessDenied });
  cache.hydrate(record());
  await cache.revalidate().catch(() => undefined);
  expect(accessDenied).toHaveBeenCalledTimes(1);
});

test("a snapshot is never painted over an answer this document already has", async () => {
  const cache = createFilesClientCache(recordingFetcher(() => new Response(JSON.stringify(BODY), { status: 200, headers: { ETag: ETAG } })).fetcher);
  await cache.revalidate();
  expect(cache.hydrate(record({ text: JSON.stringify({ files: [] }) }))).toBe(false);
  expect(cache.readScope().files.length).toBe(2);
});

test("a stored record is used only while current, fresh, bounded and revalidatable", () => {
  const now = Date.now();
  expect(usableSnapshot(record(), now)).toBe(true);
  expect(usableSnapshot(record({ version: FILES_SNAPSHOT_VERSION + 1 }), now)).toBe(false);
  expect(usableSnapshot(record({ savedAt: now - FILES_SNAPSHOT_MAX_AGE_MS - 1 }), now)).toBe(false);
  expect(usableSnapshot(record({ etag: "" }), now)).toBe(false);
  expect(usableSnapshot(null, now)).toBe(false);
});

function Probe() {
  const data = useFiles();
  return <div data-loaded={String(data.loaded)} data-cached={String(Boolean(data.cached))}>{data.files.map((file) => file.path).join(",") || "empty"}</div>;
}

test("the board's rows paint from the stored answer before the request answers, then certify on a 304", async () => {
  const store = memoryFilesSnapshotStore(record());
  resetFilesClientCacheForTests(store);
  let answer!: (response: Response) => void;
  const calls: Call[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> | undefined) } });
    return new Promise<Response>((resolve) => { answer = resolve; });
  }) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Probe />));
  const probe = () => host.firstElementChild as unknown as HTMLElement;
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => undefined);
  };
  await settle();
  /* Rows are on screen, flagged cached, while the request is still out. */
  expect(probe().textContent).toBe("/sessions/alpha.jsonl,/sessions/beta.jsonl");
  expect(probe().getAttribute("data-cached")).toBe("true");
  expect(probe().getAttribute("data-loaded")).toBe("false");
  expect(calls.length).toBe(1);
  expect(calls[0]!.headers["If-None-Match"]).toBe(ETAG);
  answer(notModified());
  await settle();
  expect(probe().getAttribute("data-loaded")).toBe("true");
  expect(probe().getAttribute("data-cached")).toBe("false");
  expect(probe().textContent).toBe("/sessions/alpha.jsonl,/sessions/beta.jsonl");
  flushSync(() => root.unmount());
});

test("what a document certified is stored for the next one, and an unchanged answer is not rewritten", async () => {
  const store = memoryFilesSnapshotStore();
  resetFilesClientCacheForTests(store);
  globalThis.fetch = mock(async () => new Response(JSON.stringify(BODY), { status: 200, headers: { ETag: ETAG } })) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<Probe />));
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  persistFilesSnapshotForTests();
  const stored = store.current();
  expect(stored?.etag).toBe(ETAG);
  expect(JSON.parse(stored!.text).files.map((file: { path: string }) => file.path)).toEqual(BODY.files.map((file) => file.path));
  const savedAt = stored!.savedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  persistFilesSnapshotForTests();
  expect(store.current()!.savedAt).toBe(savedAt);
  flushSync(() => root.unmount());
});
