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

const { resetFilesClientCacheForTests, useFiles } = await import("./useFiles");
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

function Probe() {
  const data = useFiles();
  return <div>{`${data.files[0]?.path ?? "empty"}|${data.catalogFailures}`}</div>;
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Probe />));
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
