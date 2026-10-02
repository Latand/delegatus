import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import type { EventSourceLike, RuntimeBus } from "./runtimeBus";

const createTestRuntimeBus = (await import("./runtimeBus")).createRuntimeBus;
let testRuntimeBus: RuntimeBus | null = null;

let revisionListener: ((revision: number) => void) | null = null;

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => true,
  getRuntimeBus: () => testRuntimeBus ?? ({
    getState: () => ({ connection: "live" }),
    subscribe: () => () => {},
    subscribeFilesRevision: (listener: (revision: number) => void) => {
      revisionListener = listener;
      return () => { revisionListener = null; };
    },
  }),
}));

const {
  applyPipelineSnapshot,
  filesApiUrl,
  resetFilesClientCacheForTests,
  revertPipelineSnapshot,
  useFiles,
} = await import("./useFiles");
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

beforeEach(() => {
  resetFilesClientCacheForTests();
});

afterEach(() => {
  testRuntimeBus?.stop();
  testRuntimeBus = null;
  globalThis.fetch = originalFetch;
  revisionListener = null;
  document.body.replaceChildren();
});

function Probe() {
  const data = useFiles();
  return <div data-loaded={String(data.loaded)}>{data.files[0]?.path ?? "empty"}</div>;
}

test("an already open live board renders a new agent after SSE snapshot recovery", async () => {
  let filesRevision = 1;
  const sources: Array<{ source: EventSourceLike; reset: () => void }> = [];
  testRuntimeBus = createTestRuntimeBus({
    fetch: async () => new Response(JSON.stringify({
      schemaVersion: 1, snapshotSeq: filesRevision === 1 ? 100 : 200,
      retentionFloorSeq: 0, runtime: { hostEpoch: 1, health: "ready" }, filesRevision,
      sessions: [], attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [],
    })),
    createEventSource: () => {
      let reset = () => {};
      const source: EventSourceLike = {
        onopen: null, onmessage: null, onerror: null, close: () => {},
        addEventListener: (name, listener) => {
          if (name === "reset") reset = () => listener({ data: "{}" });
        },
      };
      sources.push({ source, reset: () => reset() });
      return source;
    },
    now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  testRuntimeBus.start();
  await Bun.sleep(20);
  sources[0]!.source.onopen?.(null);
  let fileReads = 0;
  globalThis.fetch = mock(async () => {
    fileReads += 1;
    return new Response(JSON.stringify({ files: [{ path: filesRevision === 1 ? "/sessions/seat.jsonl" : "/sessions/new-agent.jsonl" }] }));
  }) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => { root.render(<Probe />); });
    await Bun.sleep(30);
    expect(host.textContent).toBe("/sessions/seat.jsonl");
    expect(fileReads).toBe(1);
    filesRevision = 7;
    sources[0]!.reset();
    await Bun.sleep(20);
    sources.at(-1)!.source.onopen?.(null);
    await Bun.sleep(500);
    expect(testRuntimeBus.getState().connection).toBe("live");
    expect(host.textContent).toBe("/sessions/new-agent.jsonl");
    expect(fileReads).toBe(2);
  } finally {
    flushSync(() => { root.unmount(); });
    host.remove();
  }
});

function ScopedProbe({ pinnedPath }: { pinnedPath?: string }) {
  const data = useFiles(undefined, pinnedPath);
  return <div>{JSON.stringify({
    files: data.files.map((entry) => entry.path),
    pins: data.pinOverlayPaths,
    scope: data.requestScope,
    certified: data.scopeCertified,
    task: data.pipelines[0]?.task ?? "",
  })}</div>;
}

function pipelineRow(task: string) {
  return { id: "p1", task, project: "project-a", state: "draft", stages: [], runs: [], cursor: null, hiddenAt: null };
}

test("concurrent pinned and global hooks keep their scopes through local pipeline apply and revert", async () => {
  const pinnedPath = "/archive/dom-scoped-pin.jsonl";
  let fetches = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    fetches += 1;
    const url = String(input);
    const pinned = new URL(url, "http://localhost").searchParams.has("path");
    return new Response(JSON.stringify({
      files: pinned ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinned ? [pinnedPath] : [],
      pipelines: [pipelineRow("server")],
    }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<>
      <ScopedProbe pinnedPath={pinnedPath} />
      <ScopedProbe />
    </>);
  });
  await Bun.sleep(30);

  applyPipelineSnapshot(pipelineRow("patched") as never, false);
  await Bun.sleep(0);
  expect(fetches).toBe(2);
  expect(host.children[0]?.textContent).toBe(JSON.stringify({
    files: ["/global", pinnedPath],
    pins: [pinnedPath],
    scope: filesApiUrl(undefined, pinnedPath),
    certified: true,
    task: "patched",
  }));
  expect(host.children[1]?.textContent).toBe(JSON.stringify({
    files: ["/global"],
    pins: [],
    scope: filesApiUrl(),
    certified: true,
    task: "patched",
  }));

  revertPipelineSnapshot("p1");
  await Bun.sleep(0);
  expect(fetches).toBe(2);
  expect(host.children[0]?.textContent).toContain('"task":"server"');
  expect(host.children[0]?.textContent).toContain(pinnedPath);
  expect(host.children[1]?.textContent).toBe(JSON.stringify({
    files: ["/global"],
    pins: [],
    scope: filesApiUrl(),
    certified: true,
    task: "server",
  }));

  flushSync(() => { root.unmount(); });
  host.remove();
});

/* #1432: a scope with no representation yet paints the last known GLOBAL rows,
   marked uncertified, instead of an empty placeholder — and never the rows only
   another pin admitted. */
test("hook initialization paints the last known global rows for an unfetched scope, never another pin's rows", async () => {
  const pinA = "/archive/pin-a.jsonl";
  const pinB = "/archive/pin-b.jsonl";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls += 1;
    const url = String(input);
    if (calls > 1) await gate;
    const pinnedPath = new URL(url, "http://localhost").searchParams.get("path");
    return new Response(JSON.stringify({
      files: pinnedPath ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinnedPath ? [pinnedPath] : [],
    }));
  }) as unknown as typeof fetch;

  const warmHost = document.createElement("div");
  document.body.append(warmHost);
  const warmRoot = createRoot(warmHost);
  flushSync(() => { warmRoot.render(<ScopedProbe pinnedPath={pinA} />); });
  await Bun.sleep(20);
  expect(warmHost.textContent).toContain(pinA);
  flushSync(() => { warmRoot.unmount(); });
  warmHost.remove();

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(<>
      <ScopedProbe />
      <ScopedProbe pinnedPath={pinB} />
      <ScopedProbe pinnedPath={pinA} />
    </>);
  });

  expect(host.children[0]?.textContent).toContain('"files":["/global"]');
  expect(host.children[0]?.textContent).toContain('"certified":false');
  expect(host.children[1]?.textContent).toContain('"files":["/global"]');
  expect(host.children[1]?.textContent).toContain('"certified":false');
  expect(host.children[2]?.textContent).toContain(pinA);
  expect(host.children[2]?.textContent).toContain('"certified":true');
  expect(host.children[0]?.textContent).not.toContain(pinA);
  expect(host.children[1]?.textContent).not.toContain(pinA);

  release();
  await Bun.sleep(30);
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("an already-mounted hook drops pin-only rows in the render that changes scope", async () => {
  const pinA = "/archive/switch-pin-a.jsonl";
  const pinB = "/archive/switch-pin-b.jsonl";
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls += 1;
    const url = String(input);
    if (calls > 1) await gate;
    const pinnedPath = new URL(url, "http://localhost").searchParams.get("path");
    return new Response(JSON.stringify({
      files: pinnedPath ? [{ path: "/global" }, { path: pinnedPath }] : [{ path: "/global" }],
      pinOverlayPaths: pinnedPath ? [pinnedPath] : [],
    }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<ScopedProbe pinnedPath={pinA} />); });
  await Bun.sleep(20);
  expect(host.textContent).toContain(pinA);

  flushSync(() => { root.render(<ScopedProbe pinnedPath={pinB} />); });
  expect(host.textContent).toContain('"files":["/global"]');
  expect(host.textContent).toContain('"certified":false');
  expect(host.textContent).not.toContain(pinA);

  flushSync(() => { root.render(<ScopedProbe />); });
  expect(host.textContent).toContain('"files":["/global"]');
  expect(host.textContent).toContain('"certified":false');
  expect(host.textContent).not.toContain(pinA);

  release();
  await Bun.sleep(30);
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a failed cold hydration keeps creation guarded and retries until a snapshot succeeds", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) throw new Error("cold files transport failed");
    return new Response(JSON.stringify({ files: [{ path: "/sessions/recovered.jsonl" }] }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.firstElementChild?.getAttribute("data-loaded")).toBe("false");
  expect(host.textContent).toBe("empty");

  await Bun.sleep(1_100);
  expect(calls).toBe(2);
  expect(host.firstElementChild?.getAttribute("data-loaded")).toBe("true");
  expect(host.textContent).toBe("/sessions/recovered.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a live-mode remount paints A from cache and reaches B through one background revalidation", async () => {
  let calls = 0;
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ files: [{ path: "/sessions/project-a.jsonl" }] }));
    await gateB;
    return new Response(JSON.stringify({ files: [{ path: "/sessions/project-b.jsonl" }] }));
  }) as unknown as typeof fetch;

  const firstHost = document.createElement("div");
  document.body.append(firstHost);
  const firstRoot = createRoot(firstHost);
  flushSync(() => { firstRoot.render(<Probe />); });
  await Bun.sleep(20);
  expect(firstHost.textContent).toBe("/sessions/project-a.jsonl");
  flushSync(() => { firstRoot.unmount(); });
  firstHost.remove();

  const secondHost = document.createElement("div");
  document.body.append(secondHost);
  const secondRoot = createRoot(secondHost);
  flushSync(() => { secondRoot.render(<Probe />); });
  expect(secondHost.textContent).toBe("/sessions/project-a.jsonl");
  await Bun.sleep(20);
  expect(calls).toBe(2);

  releaseB();
  await Bun.sleep(20);
  expect(secondHost.textContent).toBe("/sessions/project-b.jsonl");
  expect(calls).toBe(2);
  flushSync(() => { secondRoot.unmount(); });
  secondHost.remove();
});

test("a failed live revision hydration retries without another revision event", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 2) throw new Error("transient files failure");
    const path = calls === 1 ? "/sessions/old.jsonl" : "/sessions/new.jsonl";
    return new Response(JSON.stringify({ files: [{ path }] }), {
      headers: { ETag: `"${calls}"` },
    });
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.textContent).toBe("/sessions/old.jsonl");

  revisionListener?.(7);
  await Bun.sleep(450);
  expect(calls).toBe(2);

  await Bun.sleep(1_100);
  expect(calls).toBe(3);
  expect(host.textContent).toBe("/sessions/new.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});

test("a delayed ordinary refresh cannot overwrite a newer revision hydration", async () => {
  let calls = 0;
  let resolveLate!: (response: Response) => void;
  globalThis.fetch = mock(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ files: [{ path: "/sessions/initial.jsonl" }] }));
    }
    if (calls === 2) {
      return new Promise<Response>((resolve) => { resolveLate = resolve; });
    }
    return new Response(JSON.stringify({ files: [{ path: "/sessions/fresh-revision.jsonl" }] }));
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<Probe />); });
  await Bun.sleep(20);
  expect(host.textContent).toBe("/sessions/initial.jsonl");

  window.dispatchEvent(new dom.Event(FLOWS_CHANGED_EVENT) as unknown as Event);
  await Bun.sleep(10);
  expect(calls).toBe(2);
  revisionListener?.(8);
  await Bun.sleep(450);

  resolveLate(new Response(JSON.stringify({ files: [{ path: "/sessions/stale-late.jsonl" }] })));
  await Bun.sleep(30);
  expect(calls).toBe(3);
  expect(host.textContent).toBe("/sessions/fresh-revision.jsonl");
  flushSync(() => { root.unmount(); });
  host.remove();
});

/** Costs a millisecond, so a render of many rows is long enough to be interrupted. */
function spendOneMillisecond() {
  const until = performance.now() + 1;
  while (performance.now() < until) { /* busy */ }
}

function Row({ path }: { path: string }) {
  spendOneMillisecond();
  return <i>{path}</i>;
}

function StreamedProbe({ tick }: { tick: number }) {
  const data = useFiles();
  return (
    <div data-tick={tick}>
      <b>{data.files[0]?.path ?? "empty"}</b>
      {Array.from({ length: 60 }, (_, index) => <Row key={`r${index}`} path={data.files[0]?.path ?? ""} />)}
    </div>
  );
}

test("a catalog update commits while a stream of urgent renders keeps interrupting it", async () => {
  let generation = 0;
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    files: [{ path: `/sessions/generation-${generation}.jsonl` }],
  }))) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let tick = 0;
  const render = () => { root.render(<StreamedProbe tick={tick} />); };
  flushSync(render);
  for (let waited = 0; waited < 2_000 && host.querySelector("b")?.textContent !== "/sessions/generation-0.jsonl"; waited += 20) {
    await Bun.sleep(20);
  }
  expect(host.querySelector("b")?.textContent).toBe("/sessions/generation-0.jsonl");
  /* Each tick is an urgent render landing inside the 60 ms transition render. */
  const stream = setInterval(() => {
    tick += 1;
    flushSync(render);
  }, 5);
  try {
    generation = 1;
    const sentAt = performance.now();
    window.dispatchEvent(new dom.Event(FLOWS_CHANGED_EVENT) as unknown as Event);
    let landedAfter = Number.POSITIVE_INFINITY;
    while (performance.now() - sentAt < 3_000) {
      await Bun.sleep(10);
      if (host.querySelector("b")?.textContent === "/sessions/generation-1.jsonl") {
        landedAfter = performance.now() - sentAt;
        break;
      }
    }
    expect(landedAfter).toBeLessThan(1_000);
  } finally {
    clearInterval(stream);
    flushSync(() => { root.unmount(); });
    host.remove();
  }
});
