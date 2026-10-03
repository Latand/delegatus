import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-catalog-freshness-"));
const originalEnv = { ...process.env };
Object.assign(process.env, {
  LLV_STATE_DIR: path.join(sandbox, "state"),
  LLV_CODEX_HOME: path.join(sandbox, "codex"),
  LLV_CLAUDE_HOME: path.join(sandbox, "claude"),
  COPILOT_HOME: path.join(sandbox, "copilot"),
  OPENCLAW_STATE_DIR: path.join(sandbox, "openclaw"),
  TMPDIR: path.join(sandbox, "tmp"),
  LLV_FILE_SCANNER_WORKER_DISABLED: "1",
  LLV_FILES_RESPONSE_WORKER_DISABLED: "1",
});
const sessions = path.join(process.env.LLV_CODEX_HOME!, "sessions");
fs.mkdirSync(sessions, { recursive: true });
const { cachedFileScan, completedFileScan, currentFileScan, resetFilesRouteCacheForTests, setFileScanRunnerForTests } = await import("./scanCache");
const { coordinatedFileScan, fileScanCoordinatorStatus, runFileCatalogScan } = await import("./scanCoordinator");
const { GET: filesGet } = await import("@/app/api/files/route");
const { GET: conversationsGet } = await import("@/app/api/conversations/route");
const { collectSnapshot } = await import("@/lib/view/collect");
const { upsertPresence, resetPresenceForTest } = await import("@/lib/view/presenceStore");
const { replaceConversationCatalog } = await import("./conversationCatalog");
const { fileCatalogMembership } = await import("./catalogMembership");
const { completedGenerationSelection } = await import("@/lib/lifecycle/inventorySelection");
const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
const { useFiles, resetFilesClientCacheForTests } = await import("@/hooks/useFiles");
const { setRuntimeBusForTests, createRuntimeBus } = await import("@/hooks/runtimeBus");
import type { EventSourceLike } from "@/hooks/runtimeBus";

let scans = 0;
let clock = Date.now();
const realNow = Date.now;
const originalFetch = globalThis.fetch;
const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event });

function writeSession(name: string): string {
  const pathname = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/catalog-fixture" } }) + "\n");
  return pathname;
}

beforeEach(() => {
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "files-scan-snapshot.json"), { force: true });
  resetFilesRouteCacheForTests();
  resetFilesClientCacheForTests();
  replaceConversationCatalog([]);
  resetPresenceForTest();
  clock = realNow();
  Date.now = () => clock;
  scans = 0;
  setFileScanRunnerForTests(async (...args) => {
    scans += 1;
    return runFileCatalogScan(...args);
  });
});

afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  setRuntimeBusForTests(null);
  setFileScanRunnerForTests(null);
  resetFilesRouteCacheForTests();
  document.body.replaceChildren();
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function Catalog() {
  const data = useFiles();
  return <div>{data.files.map(entry => <span key={entry.path}>{entry.path}</span>)}</div>;
}

test("an open live board gets a second launch inside the revision cooldown", async () => {
  const seat = writeSession("seat");
  let source: EventSourceLike | undefined;
  const bus = createRuntimeBus({
    fetch: async () => Response.json({ schemaVersion: 1, snapshotSeq: 100, retentionFloorSeq: 0,
      runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1, sessions: [],
      attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [] }),
    createEventSource: () => source = { onopen: null, onmessage: null, onerror: null, close() {}, addEventListener() {} },
    now: () => clock, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  setRuntimeBusForTests(bus);
  bus.start();
  await Bun.sleep(20);
  source!.onopen?.(null);
  globalThis.fetch = ((input, init) => filesGet(new Request(`http://127.0.0.1${input}`, init))) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const revision = (value: number) => source!.onmessage?.({ data: JSON.stringify({ schemaVersion: 1,
    seq: 100 + value, eventId: `revision-${value}`, scope: { type: "system", id: "files" },
    kind: "files.revision", payload: { filesRevision: value } }) });
  try {
    flushSync(() => root.render(<Catalog />));
    await Bun.sleep(150);
    expect(host.textContent).toContain(seat);
    clock += 10_000;
    revision(2);
    await Bun.sleep(650);
    await currentFileScan();
    const newAgent = writeSession("new-agent");
    clock += 10_000;
    const start = performance.now();
    revision(3);
    for (let attempt = 0; attempt < 150 && !host.textContent!.includes(newAgent); attempt += 1) await Bun.sleep(10);
    console.info(JSON.stringify({ observation: "open-board", elapsedMs: Math.round(performance.now() - start), scans,
      newAgentVisible: host.textContent!.includes(newAgent) }));
    expect(host.textContent).toContain(newAgent);
    expect(bus.getState().connection).toBe("live");
  } finally {
    flushSync(() => root.unmount());
    bus.stop();
  }
});

test("MCP completed catalog and scanner stamp advance on a new transcript", async () => {
  const seat = writeSession("mcp-seat");
  const presence = (paths: string[]) => upsertPresence({ schemaVersion: 1, viewSessionId: "catalog-tab",
    deviceId: "desktop", device: { kind: "desktop", browser: "chrome" }, visibility: "visible",
    sequence: paths.length, inputSequence: paths.length, project: "catalog-fixture", mode: "scheme",
    viewport: { width: 100, height: 100, dpr: 1 }, camera: null, focusedPath: seat,
    selectedPaths: [], visiblePaths: paths, board: { renderedRevision: 1, durableRevision: 1, sync: "current" } });
  presence([seat]);
  const read = () => collectSnapshot({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } });
  const before = await read();
  const newAgent = writeSession("mcp-new-agent");
  clock += 10_000;
  presence([seat, newAgent]);
  const after = await read();
  console.info(JSON.stringify({ observation: "MCP", before: before.scanner.scannedAt, after: after.scanner.scannedAt,
    scans, newAgentVisible: after.conversations.some(entry => entry.path === newAgent) }));
  expect(after.conversations.some(entry => entry.path === newAgent)).toBe(true);
  expect(after.scanner.scannedAt).not.toBe(before.scanner.scannedAt);
  const activity = await completedGenerationSelection({ limit: 100 });
  expect(activity.entries.some(entry => entry.path === newAgent)).toBe(true);
});

test("the warm HTTP catalog used by list_conversations includes a new transcript", async () => {
  writeSession("catalog-seat");
  await currentFileScan();
  const newAgent = writeSession("catalog-new-agent");
  clock += 10_000;
  const tools = viewerMcpBindings(undefined, {
    get: async pathname => await (await conversationsGet(new Request(`http://127.0.0.1${pathname}`))).json() as Record<string, unknown>,
    post: async () => ({}),
  });
  const listed = await tools.list_conversations({ limit: 100 }) as { conversations: Array<{ transcriptPath: string }> };
  expect(listed.conversations.some(entry => entry.transcriptPath === newAgent)).toBe(true);
  const response = await conversationsGet(new Request("http://127.0.0.1/api/conversations?limit=100"));
  const body = await response.json() as { items: Array<{ path: string }> };
  expect(body.items.some(entry => entry.path === newAgent)).toBe(true);
});

test("production list_conversations waits through the membership cooldown for a second transcript", async () => {
  const seat = writeSession("transport-seat");
  await currentFileScan();
  const first = writeSession("transport-first");
  await completedFileScan();
  const second = writeSession("transport-second");

  const originalControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => conversationsGet(request),
  });
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  // Keep the fixture's cooldown start at the real timestamp while allowing
  // the production retry adapter to measure its deadline with the real clock.
  Date.now = realNow;
  try {
    const startedAt = performance.now();
    const listed = await viewerMcpBindings().list_conversations(
      { limit: 100 },
      { deadlineAt: Date.now() + 30_000 },
    ) as { conversations: Array<{ transcriptPath: string }> };
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info(JSON.stringify({ observation: "production-list-conversations", elapsedMs,
      seatVisible: listed.conversations.some(entry => entry.transcriptPath === seat),
      firstVisible: listed.conversations.some(entry => entry.transcriptPath === first),
      secondVisible: listed.conversations.some(entry => entry.transcriptPath === second) }));
    expect(listed.conversations.some(entry => entry.transcriptPath === second)).toBe(true);
    expect(elapsedMs).toBeLessThan(30_000);
  } finally {
    Date.now = realNow;
    if (originalControlUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = originalControlUrl;
    await server.stop(true);
  }
}, 20_000);

for (const busy of [false, true]) {
  test(`scan rate: ${busy ? "busy appends and revisions" : "idle polls"}`, async () => {
    const transcript = writeSession("rate-seat");
    await currentFileScan();
    // Warm the same revision path a live tab takes; exclude initial hydration.
    await cachedFileScan(undefined, undefined, clock, 1);
    await currentFileScan();
    const initialScans = scans;
    for (let second = 1; second <= 600; second += 1) {
      clock += 1000;
      if (busy) fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "fixture work" } }) + "\n");
      await cachedFileScan(undefined, undefined, clock, busy ? second + 1 : undefined);
      await completedFileScan();
      await currentFileScan();
    }
    console.info(JSON.stringify({ observation: "scan-rate", fixture: busy ? "busy" : "idle", simulatedMinutes: 10,
      polls: 1200, fullScans: scans - initialScans, scansPerMinute: (scans - initialScans) / 10 }));
    expect(scans - initialScans).toBeLessThanOrEqual(2);
  }, 20_000);
}

test("membership probes reuse listings and never stat populated transcripts on appends", async () => {
  const transcript = writeSession("probe-seat");
  const initial = await fileCatalogMembership();
  const originalStat = fs.promises.stat;
  const originalReaddir = fs.promises.readdir;
  let fileStats = 0;
  let directoryStats = 0;
  let listings = 0;
  fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
    if (args[0] === transcript) fileStats += 1;
    if (args[0] === sessions) directoryStats += 1;
    return originalStat(...args);
  }) as typeof originalStat;
  fs.promises.readdir = (async (...args: Parameters<typeof originalReaddir>) => {
    listings += 1;
    return originalReaddir(...args);
  }) as typeof originalReaddir;
  try {
    for (let poll = 0; poll < 100; poll += 1) {
      fs.appendFileSync(transcript, "fixture append\n");
      expect(await fileCatalogMembership()).toBe(initial);
    }
    expect(fileStats).toBe(0);
    expect(directoryStats).toBe(100);
    expect(listings).toBe(0);
  } finally {
    fs.promises.stat = originalStat;
    fs.promises.readdir = originalReaddir;
  }
});

test("an empty transcript becoming populated invalidates membership", async () => {
  writeSession("empty-seat");
  const newAgent = path.join(sessions, "empty-new-agent.jsonl");
  fs.writeFileSync(newAgent, "");
  const before = await currentFileScan();
  expect(before.snapshot.files.some(entry => entry.path === newAgent)).toBe(false);
  writeSession("empty-new-agent");
  clock += 10_000;
  const after = await completedFileScan();
  expect(after.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
  expect(after.refreshedAt).toBeGreaterThan(before.refreshedAt!);
});

test("births and revision storms coalesce to one membership scan per ten seconds", async () => {
  writeSession("storm-seat");
  await currentFileScan();
  writeSession("storm-first");
  await completedFileScan();
  const firstScans = scans;
  writeSession("storm-next");
  clock += 9_950;
  const requests = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    cachedFileScan(undefined, undefined, clock, index + 1)));
  expect(scans).toBe(firstScans);
  expect(new Set(requests.map(scan => scan.targetGeneration)).size).toBe(1);
  await Bun.sleep(80);
  await completedFileScan();
  expect(scans).toBe(firstScans + 1);
  const after = scans;
  for (let revision = 101; revision <= 200; revision += 1) await cachedFileScan(undefined, undefined, clock, revision);
  expect(scans).toBe(after);
});

test("a transcript born during a scan is caught by the next catalog read", async () => {
  writeSession("racing-seat");
  await currentFileScan();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  setFileScanRunnerForTests(async (...args) => {
    scans += 1;
    const snapshot = await runFileCatalogScan(...args);
    started();
    await gate;
    return snapshot;
  });
  const refresh = currentFileScan({ fresh: true });
  await ready;
  const newAgent = writeSession("racing-new-agent");
  release();
  const old = await refresh;
  expect(old.snapshot.files.some(entry => entry.path === newAgent)).toBe(false);
  clock += 10_000;
  const current = await completedFileScan();
  expect(current.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
});

test("a cold read trailing-scans membership missed by an adopted controller generation", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listed!: () => void;
  const ready = new Promise<void>(resolve => { listed = resolve; });
  const controller = coordinatedFileScan({ persist: true }, async (intent, signal) => {
    const snapshot = await runFileCatalogScan(intent, {}, signal);
    listed();
    await gate;
    return snapshot;
  });
  await ready;
  const newAgent = writeSession("adopted-controller-agent");
  try {
    const coldRead = completedFileScan();
    await Bun.sleep(10);
    release();
    const completed = await coldRead;
    await controller;
    expect(completed.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
    expect(scans).toBe(1);
    clock += 10_000;
    const nextRead = await completedFileScan();
    expect(nextRead.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
    expect(scans).toBe(1);
  } finally {
    release();
  }
});

test("a completed read begun during an older refresh waits for one trailing membership scan", async () => {
  writeSession("pending-refresh-seat");
  await currentFileScan();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listed!: () => void;
  const ready = new Promise<void>(resolve => { listed = resolve; });
  setFileScanRunnerForTests(async (...args) => {
    scans += 1;
    const snapshot = await runFileCatalogScan(...args);
    listed();
    await gate;
    return snapshot;
  });
  const oldRefresh = currentFileScan({ fresh: true });
  await ready;
  const newAgent = writeSession("pending-refresh-agent");
  try {
    const read = completedFileScan();
    await Bun.sleep(10);
    release();
    await oldRefresh;
    const completed = await read;
    expect(completed.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
    expect(scans).toBe(3);
  } finally {
    release();
  }
});

test("a membership read acknowledges a controller generation queued before its probe", async () => {
  writeSession("queued-membership-controller-seat");
  await currentFileScan();
  const cacheScansBefore = scans;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstDiscovered!: () => void;
  const firstReady = new Promise<void>(resolve => { firstDiscovered = resolve; });
  let startsAfterWarm = 0;
  const first = coordinatedFileScan({ persist: true }, async (intent, signal) => {
    startsAfterWarm += 1;
    const snapshot = await runFileCatalogScan(intent, {}, signal);
    firstDiscovered();
    await firstGate;
    return snapshot;
  });
  await firstReady;

  const controllerStarts: number[] = [];
  const queuedController = coordinatedFileScan({ persist: true, join: false }, async (intent, signal) => {
    startsAfterWarm += 1;
    controllerStarts.push(clock);
    return runFileCatalogScan(intent, {}, signal);
  });
  const newAgent = writeSession("queued-membership-controller-agent");
  try {
    const membershipRead = completedFileScan();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fileScanCoordinatorStatus().queued === 1 && fileScanCoordinatorStatus().subscribers >= 3) break;
      await Bun.sleep(1);
    }
    expect(fileScanCoordinatorStatus()).toEqual({ inFlight: true, queued: 1, subscribers: 3 });
    releaseFirst();
    const [completed] = await Promise.all([membershipRead, first, queuedController]);

    expect(completed!.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
    expect(startsAfterWarm).toBe(2);
    expect(controllerStarts).toHaveLength(1);
    expect(startsAfterWarm + scans - cacheScansBefore).toBe(2);
  } finally {
    releaseFirst();
  }
});

test("membership cooldown starts when a queued scan starts", async () => {
  writeSession("queued-controller-seat");
  await currentFileScan();
  const starts: number[] = [];
  setFileScanRunnerForTests(async (...args) => {
    scans += 1;
    starts.push(clock);
    return runFileCatalogScan(...args);
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let listed!: () => void;
  const ready = new Promise<void>(resolve => { listed = resolve; });
  const controller = coordinatedFileScan({ persist: true }, async (intent, signal) => {
    const snapshot = await runFileCatalogScan(intent, {}, signal);
    listed();
    await gate;
    return snapshot;
  });
  await ready;
  writeSession("queued-membership-first");
  try {
    const firstRead = completedFileScan();
    await Bun.sleep(10);
    clock += 12_000;
    release();
    await Promise.all([firstRead, controller]);
    expect(starts).toHaveLength(1);

    clock += 100;
    writeSession("queued-membership-second");
    const originalSetTimeout = globalThis.setTimeout;
    let scheduledDelay: number | undefined;
    let fireTimer!: () => void;
    let timerScheduled!: () => void;
    const timerReady = new Promise<void>(resolve => { timerScheduled = resolve; });
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
      scheduledDelay = delay ?? 0;
      const handle = originalSetTimeout(() => {}, 2_147_483_647);
      fireTimer = () => {
        clearTimeout(handle);
        (handler as () => void)();
      };
      timerScheduled();
      return handle;
    }) as unknown as typeof setTimeout;
    const secondRead = completedFileScan();
    void secondRead.catch(() => undefined);
    try {
      await timerReady;
      expect(scheduledDelay).toBe(9_900);
      expect(starts).toHaveLength(1);
      clock += scheduledDelay!;
      fireTimer();
      await secondRead;
      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10_000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  } finally {
    release();
  }
}, 20_000);

test("an unreadable membership probe retains the completed catalog and retries after recovery", async () => {
  writeSession("unreadable-seat");
  const before = await currentFileScan();
  const newAgent = writeSession("unreadable-new-agent");
  const originalStat = fs.promises.stat;
  const originalError = console.error;
  let diagnostics = 0;
  fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
    if (args[0] === sessions) throw Object.assign(new Error("fixture directory unavailable"), { code: "EACCES" });
    return originalStat(...args);
  }) as typeof originalStat;
  console.error = () => { diagnostics += 1; };
  try {
    const retained = await completedFileScan();
    expect(retained.generation).toBe(before.generation);
    expect(retained.refreshedAt).toBe(before.refreshedAt);
    expect(scans).toBe(1);
    expect(diagnostics).toBe(1);
  } finally {
    fs.promises.stat = originalStat;
    console.error = originalError;
  }
  clock += 10_000;
  const recovered = await completedFileScan();
  expect(recovered.snapshot.files.some(entry => entry.path === newAgent)).toBe(true);
});
