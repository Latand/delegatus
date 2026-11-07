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
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { TeamView, WorkspacesView } from "@/lib/team/contract";

let runtimeEnabled = false;
mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => runtimeEnabled,
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

test("a server bootstrap stays provisional through incomplete replies until a current generation arrives", async () => {
  for (const status of [200, 304]) {
    let phase = 0;
    const { fetcher } = recordingFetcher(() => {
      const headers = { ETag: ETAG, "x-llv-files-generation": phase === 2 ? "1" : "0", "x-llv-files-target-generation": "1",
        "x-llv-files-projection-cache": phase === 0 ? "bootstrap" : phase === 1 ? "stale" : "hit" };
      return phase === 0 || status === 200
        ? new Response(JSON.stringify(BODY), { headers })
        : new Response(null, { status: 304, headers });
    });
    const cache = createFilesClientCache(fetcher);
    try {
      for (phase = 0; phase < 2; phase++) {
        const data = await cache.revalidate();
        expect(data.files.map(file => [file.path, file.project, file.title])).toEqual(BODY.files.map(file => [file.path, file.project, file.title]));
        expect(data.cached).toBe(true);
        expect(data.loaded).toBe(false);
        expect(data.scopeCertified).toBe(false);
        expect(cache.readScope("/sessions/other.jsonl").scopeCertified).toBe(false);
        expect(cache.certifiedGlobal()).toBeNull();
      }
      const current = await cache.revalidate();
      expect(current.cached).not.toBe(true);
      expect(current.loaded).toBe(true);
      expect(current.scopeCertified).toBe(true);
      expect(cache.certifiedGlobal()?.etag).toBe(ETAG);
    } finally { cache.dispose(); }
  }
});

test("a server refusal discards a provisional bootstrap", async () => {
  let refused = false;
  const { fetcher } = recordingFetcher(() => refused
    ? new Response(null, { status: 403 })
    : new Response(JSON.stringify(BODY), { headers: { ETag: ETAG, "x-llv-files-projection-cache": "bootstrap", "x-llv-files-generation": "0", "x-llv-files-target-generation": "1" } }));
  const cache = createFilesClientCache(fetcher);
  try {
    await cache.revalidate();
    refused = true;
    await expect(cache.revalidate()).rejects.toThrow("files request failed: 403");
    expect(cache.read().files).toEqual([]);
    expect(cache.read().cached).toBeUndefined();
  } finally { cache.dispose(); }
});

test("a refused browser drops what it stored and stops painting the restored answer", async () => {
  for (const status of [401, 403]) {
    const accessDenied = mock(() => {});
    const cache = createFilesClientCache(recordingFetcher(() => new Response("", { status })).fetcher, { accessDenied });
    cache.hydrate(record());
    const seen: number[] = [];
    cache.subscribe((data) => seen.push(data.files.length));
    await cache.revalidate().catch(() => undefined);
    expect(accessDenied).toHaveBeenCalledTimes(1);
    const after = cache.readScope();
    expect(after.files).toEqual([]);
    expect(after.cached).toBeFalsy();
    expect(after.loaded).toBe(false);
    expect(seen).toContain(0);
    /* Nothing is left to revalidate conditionally, or to store back. */
    expect(cache.certifiedGlobal()).toBeNull();
  }
});

test("a refusal after this document certified its answer removes protected rows and conditional bytes", async () => {
  let status = 200;
  const cache = createFilesClientCache(async () => (status === 200 ? new Response(JSON.stringify(BODY), { status: 200, headers: { ETag: ETAG } }) : new Response("", { status })));
  await cache.revalidate();
  status = 403;
  await cache.revalidate().catch(() => undefined);
  expect(cache.readScope().files).toEqual([]);
  expect(cache.certifiedGlobal()).toBeNull();
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

for (const phase of ["headers", "body"] as const) {
  test.each(["solo confirmation", "team confirmation", "replacement", "rescope"] as const)(
    `a live board reloads after %s while its first catalog awaits ${phase}`, async (transition) => {
      const { setTeamViewForTests } = await import("@/components/team/teamClient");
      const { setWorkspacesForTests } = await import("@/components/team/workspacesClient");
      const { buildPipeline } = await import("@/lib/pipelines/store");
      const pipeline = buildPipeline({ id: "refunds", project: "atlas", task: "Idempotent refunds", taskIds: [],
        repoDir: "/fixture/repo", srcPath: null, srcConversationId: null, now: "2030-01-01T00:00:00Z", stages: [], state: "draft" });
      const stale = { ...BODY, pipelines: [{ ...pipeline, id: "stale", task: "Stale card" }] };
      const team = (id: string): TeamView => ({ mode: "team", me: {
        id, name: "Member", role: "member", status: "active", color: "sky", initials: "M", telegram: null,
      }, members: [], methods: { approval: false, telegram: { available: false, botUsername: null }, passkey: { available: false } } });
      const workspaces = (project: string): WorkspacesView => ({ mode: "team", canManage: false,
        workspaces: [{ id: "workspace-a", name: "Workspace", color: "sky", createdAt: "2030-01-01T00:00:00Z", projects: [project] }] });
      setTeamViewForTests(transition.endsWith("confirmation") ? null : team("member-a"));
      setWorkspacesForTests(workspaces("atlas"));
      resetFilesClientCacheForTests(memoryFilesSnapshotStore());
      runtimeEnabled = true;
      let started!: () => void;
      const firstRequest = new Promise<void>(resolve => { started = resolve; });
      let answer!: () => void;
      const requests: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "HEAD") return new Response(null);
        expect(init?.method ?? "GET").toBe("GET");
        requests.push(String(input));
        if (requests.length === 1) {
          if (phase === "headers") return new Promise<Response>(resolve => {
            answer = () => resolve(Response.json(stale));
            started();
          });
          const response = Response.json(stale);
          const read = response.text.bind(response);
          response.text = async () => {
            await new Promise<void>(resolve => { answer = resolve; started(); });
            return read();
          };
          return response;
        }
        return Response.json({ ...BODY, files: [{ ...BODY.files[0], path: "/sessions/current.jsonl" }], pipelines: [pipeline] });
      }) as typeof fetch;
      let painted!: () => void;
      const currentPainted = new Promise<void>(resolve => { painted = resolve; });
      const seen: string[][] = [];
      function Board() {
        const data = useFiles(null, "/sessions/pinned.jsonl");
        useEffect(() => {
          seen.push([...data.files.map(file => file.path), ...data.pipelines.map(row => row.task)]);
          if (data.loaded && data.pipelines[0]?.id === pipeline.id) painted();
        }, [data]);
        return <span>{[...data.files.map(file => file.path), ...data.pipelines.map(row => row.task)].join(",")}</span>;
      }
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host as unknown as Element);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        flushSync(() => root.render(<Board />));
        await Promise.race([firstRequest, new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("initial catalog did not reach the response barrier")), 1500);
        })]);
        clearTimeout(deadline);
        if (transition === "solo confirmation") setTeamViewForTests({ ...team("member-a"), mode: "solo", me: null });
        else if (transition === "rescope") setWorkspacesForTests(workspaces("harbor"));
        else setTeamViewForTests(team(transition === "replacement" ? "member-b" : "member-a"));
        // A confirmed refresh with the same signature owes no additional read.
        setWorkspacesForTests(workspaces(transition === "rescope" ? "harbor" : "atlas"));
        answer();
        await Promise.race([currentPainted, new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("authority replacement did not repaint the board")), 1500);
        })]);
        expect(host.textContent).toBe("/sessions/current.jsonl,Idempotent refunds");
        expect(requests).toEqual([filesApiUrl(null, "/sessions/pinned.jsonl"), filesApiUrl(null, "/sessions/pinned.jsonl")]);
        expect(seen.flat()).not.toContain("/sessions/alpha.jsonl");
        expect(seen.flat()).not.toContain("/sessions/beta.jsonl");
        expect(seen.flat()).not.toContain("Stale card");
      } finally {
        clearTimeout(deadline);
        flushSync(() => root.unmount());
        runtimeEnabled = false;
        setTeamViewForTests(null);
        setWorkspacesForTests(null);
      }
    },
  );
}

test.each(["confirmation", "replacement", "rescope", "revocation"] as const)(
  "a catalog body cannot publish across authority %s before the replacement read", async (transition) => {
    let authority: { owner: string; signature: string } | null = transition === "confirmation"
      ? null : { owner: "member-a", signature: "member-a:atlas" };
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    let requests = 0;
    const cache = createFilesClientCache(async () => {
      if (++requests > 1) return Response.json(BODY);
      const response = Response.json({ ...BODY, files: [{ ...BODY.files[0], path: "/sessions/stale.jsonl" }] });
      const read = response.text.bind(response);
      response.text = async () => {
        await new Promise<void>(resolve => { finish = resolve; started(); });
        return read();
      };
      return response;
    }, { authority: () => authority });
    const seen: string[] = [];
    const unsubscribe = cache.subscribe(data => { seen.push(...data.files.map(file => file.path)); });
    try {
      const pending = cache.revalidate();
      await reading;
      authority = transition === "revocation" ? null : { owner: transition === "replacement" ? "member-b" : "member-a",
        signature: transition === "rescope" ? "member-a:harbor" : "current" };
      cache.refreshCreationAuthority();
      finish();
      expect((await pending).files).toEqual([]);
      expect(seen).not.toContain("/sessions/stale.jsonl");
      authority = { owner: "member-b", signature: "current" };
      cache.refreshCreationAuthority();
      expect((await cache.revalidate()).files.map(file => file.path)).toEqual(BODY.files.map(file => file.path));
    } finally { unsubscribe(); cache.dispose(); }
  },
);

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


test("a visible board heartbeats through files HEAD even with live streaming, and stops on hiding or closing", async () => {
  runtimeEnabled = true;
  const originalInterval = globalThis.setInterval;
  let heartbeat: (() => void) | undefined;
  let hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  const calls: { url: string; method: string }[] = [];
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    if (ms === 15_000) heartbeat = callback;
    return originalInterval(callback, ms === 15_000 ? 100_000 : ms);
  }) as typeof setInterval;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return init?.method === "HEAD" ? new Response(null, { status: 204 }) : Response.json(BODY);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  function Board({ project }: { project?: string }) { useFiles(project); return null; }
  try {
    flushSync(() => root.render(<Board project="repo-open" />));
    expect(calls.filter((call) => call.method === "HEAD")).toEqual([{ url: "/api/files?project=repo-open", method: "HEAD" }]);
    heartbeat!();
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(2);
    hidden = true;
    heartbeat!();
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(2);
    hidden = false;
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(3);
    flushSync(() => root.render(<Board />));
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(3);
  } finally {
    flushSync(() => root.unmount());
    globalThis.setInterval = originalInterval;
    runtimeEnabled = false;
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  }
});


test("quiet live boards read accepted IDs on the existing health cadence without another catalog or POST", async () => {
  const { setTeamViewForTests } = await import("@/components/team/teamClient");
  const { reservePipelineCreation, usePipelineCreationCards, retryPipelineCreationRead } = await import("./useFiles");
  const { buildPipeline } = await import("@/lib/pipelines/store");
  setTeamViewForTests({ mode: "solo", me: null, members: [], methods: {
    approval: false, telegram: { available: false, botUsername: null }, passkey: { available: false },
  } });
  resetFilesClientCacheForTests(memoryFilesSnapshotStore());
  runtimeEnabled = true;
  const originalInterval = globalThis.setInterval;
  let tick!: () => void;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    if (ms === 10_000) tick = callback;
    return originalInterval(callback, 100_000);
  }) as typeof setInterval;
  const pipeline = buildPipeline({ id: "quiet-accepted", project: "atlas", task: "Quiet accepted work", taskIds: [],
    srcPath: null, srcConversationId: null, repoDir: "/fixture/repo", now: "2030-01-01T00:00:00Z", stages: [], state: "draft" });
  let reads = 0, catalogs = 0, terminal = false;
  let readDone!: () => void;
  let done = new Promise<void>(resolve => { readDone = resolve; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? "GET").not.toBe("POST");
    if (String(input).startsWith("/api/pipelines/")) {
      reads++;
      const response = Response.json({ code: terminal ? "pipeline_creation_refused" : "pipeline_queued", queuedCreation: {
        id: pipeline.id, project: pipeline.project, title: pipeline.task, taskIds: [], queuedAt: pipeline.createdAt,
        state: terminal ? "refused" : "queued", reason: terminal ? "creation_refused" : "store_unavailable",
      } }, { status: 404 });
      const json = response.json.bind(response);
      response.json = async () => { const result = await json(); queueMicrotask(readDone); return result; };
      return response;
    }
    if (String(input).includes("view=storage-health")) return Response.json({ state: "ok", freeBytes: null, since: null });
    if (String(input).startsWith("/api/files")) catalogs++;
    return Response.json(BODY);
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host as unknown as Element);
  function Board() { useFiles(); return <span>{usePipelineCreationCards().map(card => card.status).join(",")}</span>; }
  try {
    flushSync(() => root.render(<Board />));
    const reservation = reservePipelineCreation()!;
    await reservation.accept(pipeline, pipeline.createdAt); reservation.release();
    tick(); await done;
    await retryPipelineCreationRead();
    const beforeCatalogs = catalogs;
    terminal = true;
    done = new Promise<void>(resolve => { readDone = resolve; });
    tick(); await done;
    await retryPipelineCreationRead();
    flushSync(() => root.render(<Board />));
    expect(host.textContent).toBe("refused");
    expect(reads).toBe(2);
    expect(catalogs).toBe(beforeCatalogs);
  } finally {
    flushSync(() => root.unmount());
    globalThis.setInterval = originalInterval;
    runtimeEnabled = false;
    setTeamViewForTests(null);
    resetFilesClientCacheForTests();
  }
});


test("receipt envelopes merge concurrent documents, survive expired catalogs, and fence old owners", async () => {
  const { usableCreationLocators, CREATION_LOCATORS_MAX_BYTES } = await import("@/lib/client/filesSnapshotStore");
  const store = memoryFilesSnapshotStore(record({ savedAt: Date.now() - FILES_SNAPSHOT_MAX_AGE_MS - 1 }));
  await Promise.all([
    store.updateCreations!("member-a", [{ id: "first" }], [], () => true, undefined, "scope-a"),
    store.updateCreations!("member-a", [{ id: "second" }], [], () => true, undefined, "scope-a"),
  ]);
  expect((await store.read())?.creations?.entries).toEqual([{ id: "first" }, { id: "second" }]);
  await store.write(record());
  expect((await store.read())?.creations?.entries).toEqual([{ id: "first" }, { id: "second" }]);
  await store.updateCreations!("member-a", [], ["first"], () => true, undefined, "scope-a");
  expect((await store.read())?.creations?.entries).toEqual([{ id: "second" }]);
  await expect(store.updateCreations!("member-a", [{ id: "late" }], [], () => false)).rejects.toThrow("owner changed");
  await store.updateCreations!("member-b", [{ id: "new-owner" }], [], () => true, undefined, "scope-b");
  await store.clear("member-a");
  expect((await store.read())?.creations).toEqual({ owner: "member-b", scope: "scope-b", entries: [{ id: "new-owner" }] });
  expect((await store.read())?.text).toBe("");
  expect(usableCreationLocators({ owner: "member-a", scope: "x".repeat(CREATION_LOCATORS_MAX_BYTES), entries: [] })).toBe(false);
  const maximum = { owner: "member-a", entries: Array.from({ length: 8 }, (_, index) => ({ id: `accepted-${index}` })) };
  expect(usableCreationLocators(maximum)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(maximum)).byteLength).toBeLessThan(1024);
  expect(usableCreationLocators({ ...maximum, entries: [...maximum.entries, { id: "ninth" }] })).toBe(false);
});
