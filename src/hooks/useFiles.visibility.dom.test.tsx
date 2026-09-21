import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/* #1994: a hidden phone tab kept downloading the board. These drive the real
   hook against a scripted server and a scripted page visibility. */

let revisionListener: ((revision: number) => void) | null = null;
let connection: "live" | "degraded" = "live";

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => true,
  getRuntimeBus: () => ({
    getState: () => ({ connection }),
    subscribe: () => () => {},
    subscribeFilesRevision: (listener: (revision: number) => void) => {
      revisionListener = listener;
      return () => { revisionListener = null; };
    },
  }),
}));

const { createFilesClientCache, resetFilesClientCacheForTests, useFiles } = await import("./useFiles");
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
});

let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal }> = [];
let serve: (index: number, signal?: AbortSignal) => Promise<Response>;
let root: Root | null = null;

function body(tag: string): string {
  return JSON.stringify({ files: [{ path: `/sessions/${tag}.jsonl` }] });
}

beforeEach(() => {
  resetFilesClientCacheForTests();
  visibility = "visible";
  connection = "live";
  requests = [];
  serve = async () => new Response(body("current"), { headers: { ETag: "\"current\"" } });
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(input), headers, signal: init?.signal ?? undefined });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return serve(requests.length - 1, init?.signal ?? undefined);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  globalThis.fetch = originalFetch;
  revisionListener = null;
  document.body.replaceChildren();
});

function Probe({ pinnedPath }: { pinnedPath?: string }) {
  const data = useFiles(undefined, pinnedPath);
  return <div>{`${data.files[0]?.path ?? "empty"}|${data.catalogFailures}`}</div>;
}

async function mount(pinnedPath?: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Probe pinnedPath={pinnedPath} />));
  await Bun.sleep(20);
  return host;
}

test("a revision announced while hidden is fetched once, on return", async () => {
  await mount();
  expect(requests).toHaveLength(1);
  setVisibility("hidden");
  revisionListener?.(5);
  revisionListener?.(6);
  await Bun.sleep(600);
  expect(requests).toHaveLength(1);

  setVisibility("visible");
  await Bun.sleep(30);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.headers["x-llv-files-revision"]).toBe("6");
  expect(requests[1]!.headers["if-none-match"]).toBe("\"current\"");
});

test("a board read in flight when the tab hides is cancelled without counting as a failure", async () => {
  const host = await mount();
  let started!: () => void;
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  serve = (_index, signal) => new Promise<Response>((resolve, reject) => {
    started();
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  revisionListener?.(9);
  await inFlight;
  expect(requests).toHaveLength(2);

  setVisibility("hidden");
  await Bun.sleep(20);
  expect(requests[1]!.signal?.aborted).toBe(true);
  expect(host.textContent).toBe("/sessions/current.jsonl|0");

  serve = async () => new Response(body("after"), { headers: { ETag: "\"after\"" } });
  await Bun.sleep(1_200);
  expect(requests).toHaveLength(2);
  setVisibility("visible");
  await Bun.sleep(30);
  expect(requests).toHaveLength(3);
  expect(requests[2]!.headers["x-llv-files-revision"]).toBe("9");
  expect(host.textContent).toBe("/sessions/after.jsonl|0");
});

test("the fallback poll of a degraded connection is silent while hidden and revalidates once on return", async () => {
  connection = "degraded";
  await mount();
  setVisibility("hidden");
  await Bun.sleep(10_500);
  expect(requests).toHaveLength(1);
  setVisibility("visible");
  await Bun.sleep(30);
  expect(requests).toHaveLength(2);
}, 15_000);

test("fast visibility flapping with nothing owed fetches nothing", async () => {
  await mount();
  for (let flip = 0; flip < 20; flip += 1) {
    setVisibility("hidden");
    setVisibility("visible");
  }
  await Bun.sleep(30);
  expect(requests).toHaveLength(1);
});

test("a board first opened in a hidden tab hydrates when it is shown", async () => {
  visibility = "hidden";
  const host = await mount();
  expect(requests).toHaveLength(0);
  setVisibility("visible");
  await Bun.sleep(30);
  expect(requests).toHaveLength(1);
  expect(host.textContent).toBe("/sessions/current.jsonl|0");
});

/* Scan-completion retries own their timer and controller, apart from the
   hook's reads; they park while hidden with their target intact. */
const incomplete = (tag: string) => async () => new Response(body(tag), {
  headers: { ETag: `"${tag}"`, "x-llv-files-generation": "0", "x-llv-files-target-generation": "1" },
});
const complete = (tag: string) => async () => new Response(body(tag), {
  headers: { ETag: `"${tag}"`, "x-llv-files-generation": "1", "x-llv-files-target-generation": "1" },
});

test("a scheduled completion retry chain parks while hidden and resumes its target on return", async () => {
  serve = incomplete("stale");
  const host = await mount();
  setVisibility("hidden");
  const hiddenAt = requests.length;
  await Bun.sleep(700);
  expect(requests.length).toBe(hiddenAt);

  serve = complete("done");
  setVisibility("visible");
  await Bun.sleep(100);
  const resumed = requests.slice(hiddenAt);
  expect(resumed.length).toBeGreaterThanOrEqual(1);
  expect(resumed.some((request) => request.headers["x-llv-files-generation"] === "1")).toBe(true);
  expect(host.textContent).toBe("/sessions/done.jsonl|0");
  const settled = requests.length;
  await Bun.sleep(300);
  expect(requests.length).toBe(settled);
});

test("a completion retry in flight when the tab hides is aborted, not failed, and retried on return", async () => {
  let retryStarted!: () => void;
  const retryInFlight = new Promise<void>((resolve) => { retryStarted = resolve; });
  serve = async (index, signal) => {
    if (index === 0) return incomplete("stale")();
    retryStarted();
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const host = await mount();
  await retryInFlight;
  const inFlight = requests.at(-1)!;
  expect(inFlight.headers["x-llv-files-generation"]).toBe("1");

  setVisibility("hidden");
  await Bun.sleep(20);
  expect(inFlight.signal?.aborted).toBe(true);
  const hiddenAt = requests.length;
  await Bun.sleep(700);
  expect(requests.length).toBe(hiddenAt);
  expect(host.textContent).toBe("/sessions/stale.jsonl|0");

  serve = complete("done");
  setVisibility("visible");
  await Bun.sleep(100);
  expect(requests[hiddenAt]!.headers["x-llv-files-generation"]).toBe("1");
  expect(host.textContent).toBe("/sessions/done.jsonl|0");
});

test("a completion retry queued behind another read parks if the tab hid before it ran", async () => {
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const seen: Array<Record<string, string>> = [];
  let calls = 0;
  const cache = createFilesClientCache(async (_url, init) => {
    calls += 1;
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    if (calls === 1) return incomplete("stale")();
    if (calls === 2) {
      await gate;
      return new Response(null, { status: 304, headers: { ETag: "\"stale\"", "x-llv-files-generation": "0", "x-llv-files-target-generation": "1" } });
    }
    return complete("done")();
  });
  const unsubscribe = cache.subscribe(() => {});
  await cache.revalidate();
  // A second read holds the queue; the retry timer fires and queues behind it.
  const blocker = cache.revalidate();
  await Bun.sleep(60);
  setVisibility("hidden");
  cache.pauseCompletionRetries();
  released();
  await blocker;
  await Bun.sleep(300);
  expect(calls).toBe(2);

  setVisibility("visible");
  cache.resumeCompletionRetries();
  await Bun.sleep(100);
  expect(calls).toBe(3);
  expect(seen[2]!["x-llv-files-generation"]).toBe("1");
  expect(cache.read().files[0]?.path).toBe("/sessions/done.jsonl");
  unsubscribe();
  cache.dispose();
});

test("a pinned scope keeps custody of its incomplete scan across hide and return", async () => {
  const pinnedPath = "/sessions/pinned.jsonl";
  serve = incomplete("stale");
  await mount(pinnedPath);
  setVisibility("hidden");
  const hiddenAt = requests.length;
  await Bun.sleep(400);
  expect(requests.length).toBe(hiddenAt);
  serve = complete("done");
  setVisibility("visible");
  await Bun.sleep(100);
  const resumed = requests[hiddenAt]!;
  expect(resumed.url).toContain(`path=${encodeURIComponent(pinnedPath)}`);
  expect(resumed.headers["x-llv-files-generation"]).toBe("1");
});
