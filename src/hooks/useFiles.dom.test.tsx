import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { FLOWS_CHANGED_EVENT } from "@/components/flows/flowModel";
import { Sparkle } from "@/components/icons";
import { TurnStatusBar } from "@/components/TurnStatusBar";
import { chatState } from "@/components/mobile/mobileChatState";
import type { FileEntry } from "@/lib/types";
import { turnStateFromRecords } from "@/lib/scanner/activity";
import recordedTurnEnd from "@/lib/runtime/fixtures/recorded-turn-end.json";
import { useSwitchboardData } from "./useSwitchboardData";
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

function TurnStatusProbe({ now, pinnedPath }: { now: number; pinnedPath?: string }) {
  const data = useFiles(undefined, pinnedPath);
  const board = useSwitchboardData(data.files, [], "", now);
  return <>
    <span data-working-count>{board.working.length}</span>
    {data.files.map((file) => <section key={file.path} data-card-state={file.activity}>
      <span data-phone-state>{chatState(file)}</span>
      <span data-card-status>{[...board.working, ...board.waiting, ...board.recent, ...board.older]
        .find((item) => item.file.path === file.path)?.statusLine}</span>
      <TurnStatusBar file={file} workingLabel="working…" workingIcon={Sparkle} />
    </section>)}
  </>;
}

const turnEndReplays = (["claude", "codex"] as const)
  .flatMap((engine) => [false, true].map((coalesced) => ({ engine, coalesced })));
for (const { engine, coalesced } of turnEndReplays) {
  test(`${engine}: ${coalesced ? "coalesced start and" : "recorded"} turn end settles every status surface while the scan remains live`, async () => {
    // Recorded QA transcript boundaries with identities and prose removed.
    // Replay their canonical lifecycle into the bus; the catalog stays
    // at the preceding open turn, as it did during the five-minute scan window.
    const conversationId = "conversation_turn-end";
    const artifactPath = `/sessions/${engine}-turn-end.jsonl`;
    let source: EventSourceLike | null = null;
    let recovered = false;
    testRuntimeBus = createTestRuntimeBus({
      fetch: async () => new Response(JSON.stringify({
        schemaVersion: 1, snapshotSeq: recovered ? 102 : 100, retentionFloorSeq: 0,
        runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
        sessions: [{ conversationId, sessionKey: { engine, sessionId: "session-turn-end" },
          artifactPath, hostKind: engine === "claude" ? "claude-broker" : "codex-app-server",
          host: "hosted", turn: recovered ? "idle" : coalesced ? "unknown" : "running",
          provenance: "structured", revision: recovered ? 3 : 1,
          attentionIds: [], recentReceipts: [], activeTurnId: coalesced ? null : "turn-end", capabilities: {} }],
        attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [],
      })),
      createEventSource: () => source = {
        onopen: null, onmessage: null, onerror: null,
        close: () => {}, addEventListener: () => {},
      },
      now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
    });
    testRuntimeBus.start();
    await Bun.sleep(20);
    source!.onopen?.(null);
    const scanned: FileEntry = {
      path: artifactPath, conversationId, root: engine === "claude" ? "claude-projects" : "codex-sessions",
      engine, fmt: engine, kind: "session", name: "turn-end", title: "Replay", project: "demo",
      parent: null, mtime: Date.now() / 1000, size: 1, activity: "live", proc: "running", pid: null,
      model: null, pendingQuestion: null, waitingInput: null, rateLimit: null,
      lastTurn: { startedAt: Date.now() - 8000, endedAt: null },
    };
    let fileReads = 0;
    globalThis.fetch = mock(async () => {
      fileReads += 1;
      return new Response(JSON.stringify({ files: [scanned] }));
    }) as unknown as typeof fetch;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<TurnStatusProbe now={scanned.mtime} />));
      await Bun.sleep(40);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("1");
      expect(host.querySelector('[data-turn-status="running"]')).not.toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).toBe("working");
      const ended = recordedTurnEnd[engine];
      const turn = turnStateFromRecords([ended], engine);
      expect(turn).toBe("done");
      // Deliver both lifecycle events within the bus's 16 ms subscriber batch.
      const offset = coalesced ? 1 : 0;
      if (coalesced) source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 101, eventId: `${engine}-start`,
        scope: { type: "session", id: conversationId }, revision: 2, kind: "turn-started",
        payload: { conversationId, turnId: "turn-end" },
      }) });
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 101 + offset, eventId: `${engine}-end`,
        scope: { type: "session", id: conversationId }, revision: 2 + offset, kind: turn === "done" ? "turn-ended" : "item",
        occurredAt: ended.timestamp,
        payload: { conversationId, turnId: "turn-end", outcome: "completed" },
      }) });
      if (coalesced) {
        // A snapshot replacement before the first batched render must retain
        // the terminal identity too; the wire snapshot has no active turn.
        recovered = true;
        expect(await testRuntimeBus.refresh()).toBe(true);
      }
      await Bun.sleep(60);
      expect(testRuntimeBus.getState().store.sessions[conversationId]?.turn).toBe("idle");
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("0");
      expect(host.querySelector('[data-turn-status="running"]')).toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).not.toBe("working");
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 102 + offset, eventId: "host-after-end",
        scope: { type: "session", id: conversationId }, revision: 3 + offset, kind: "session-status",
        payload: { conversationId, host: "dead", turn: "unknown" },
      }) });
      await Bun.sleep(60);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("0");
      expect(host.querySelector('[data-turn-status="running"]')).toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).not.toBe("working");
      expect(host.querySelector("[data-card-status]")?.textContent).toBe("finished the turn — waiting for a reply");
      expect(fileReads).toBe(1);
      // A same-turn status snapshot can arrive after the terminal event while
      // the host still reports the last activeTurnId. It must preserve idle.
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 104 + offset, eventId: "late-same-turn-status",
        scope: { type: "session", id: conversationId }, revision: 4 + offset, kind: "session-status",
        payload: { conversationId, host: "hosted", turn: "running", activeTurnId: "turn-end" },
      }) });
      await Bun.sleep(60);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("0");

      // Opening the transcript changes the files scope and restarts its
      // subscription effect. The settlement must remain visible during that
      // render and on every status surface.
      flushSync(() => root.render(<TurnStatusProbe now={scanned.mtime} pinnedPath={artifactPath} />));
      await Bun.sleep(60);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("0");
      expect(host.querySelector('[data-turn-status="running"]')).toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).not.toBe("working");
      expect(host.querySelector("[data-card-status]")?.textContent).toBe("finished the turn — waiting for a reply");

      // Recovery first reports unknown, then proves that a different turn
      // started. This transition must invalidate the retained idle overlay.
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 105 + offset, eventId: "unknown-after-end",
        scope: { type: "session", id: conversationId }, revision: 5 + offset, kind: "session-status",
        payload: { conversationId, host: "dead", turn: "unknown", activeTurnId: null },
      }) });
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 106 + offset, eventId: "next-turn-started",
        scope: { type: "session", id: conversationId }, revision: 6 + offset, kind: "session-status",
        payload: { conversationId, host: "hosted", turn: "running", activeTurnId: "turn-next" },
      }) });
      await Bun.sleep(60);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("1");
      expect(host.querySelector('[data-turn-status="running"]')).not.toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).toBe("working");
      // A late catalog answer still containing the pre-terminal row cannot
      // bring working back after the runtime end has already reached the DOM.
      source!.onmessage?.({ data: JSON.stringify({
        schemaVersion: 1, seq: 107 + offset, eventId: "files-after-end",
        scope: { type: "system", id: "files" }, kind: "files.revision", payload: { filesRevision: 2 },
      }) });
      await Bun.sleep(500);
      expect(fileReads).toBeGreaterThanOrEqual(2);
      expect(host.querySelector("[data-working-count]")?.textContent).toBe("1");
      expect(host.querySelector('[data-turn-status="running"]')).not.toBeNull();
      expect(host.querySelector("[data-phone-state]")?.textContent).toBe("working");
    } finally {
      flushSync(() => root.unmount());
    }
  });
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
