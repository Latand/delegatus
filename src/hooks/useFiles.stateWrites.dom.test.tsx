import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { initializeStateCollections, injectStateWriteFaultForTests, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { noteStateCommit, setStateFreeBytesProbeForTests, StateDiskFullError, stateWriteHealth } from "@/lib/state/diskFull";

mock.module("./runtimeBus", () => ({
  isRuntimeUiEnabled: () => true,
  getRuntimeBus: () => ({
    getState: () => ({ connection: "live" }),
    subscribe: () => () => {},
    subscribeFilesRevision: () => () => {},
  }),
}));
const { resetFilesClientCacheForTests, useFiles } = await import("./useFiles");
const { StateWritesAlert } = await import("@/components/StateWritesAlert");
const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, Event: dom.Event });
let hidden = false;
let phone = false;
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
Object.defineProperty(dom, "matchMedia", { configurable: true, value: (query: string) => ({
  matches: query === "(pointer: coarse)" ? phone : query === "(any-pointer: fine)" ? !phone : false,
}) });
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let tick: (() => void) | undefined;
let healthReads = 0;
let catalogReads = 0;
let interval: ReturnType<typeof spyOn>;
let serveHealth: (signal?: AbortSignal | null) => Promise<Response>;
let serveCatalog: (() => Promise<Response>) | undefined;
const directory = process.env.LLV_STATE_DIR!;
const filename = path.join(directory, "state.sqlite");
const options = { collection: "health-probe", schemaVersion: 1, busyMessage: "probe busy",
  key: (row: { key: string }) => row.key, decode: (raw: unknown) => raw as { key: string }, clone: (row: { key: string }) => ({ ...row }) };
initializeStateCollections(filename, [{ ...options, migrationId: "probe", loadRecords: () => [] }]);
const store = new SqliteStateCollection(filename, options);

beforeEach(() => {
  noteStateCommit();
  setStateFreeBytesProbeForTests(() => 1024 ** 3);
  resetFilesClientCacheForTests();
  hidden = false;
  tick = undefined;
  healthReads = 0;
  catalogReads = 0;
  serveCatalog = undefined;
  // Drive the installed cadence deterministically, without waiting ten seconds.
  interval = spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, delay: number) => {
    expect(delay).toBe(10_000);
    tick = handler;
    return 123;
  }) as typeof setInterval);
  serveHealth = async () => Response.json(stateWriteHealth(directory));
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("view=storage-health")) { healthReads++; return serveHealth(init?.signal); }
    catalogReads++;
    if (serveCatalog) return serveCatalog();
    return Response.json({ files: [], systemHealth: { storage: { incidents: [], writes: stateWriteHealth(directory) } } }, { headers: { etag: '"stable"' } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  interval.mockRestore();
  globalThis.fetch = originalFetch;
  injectStateWriteFaultForTests(null);
  noteStateCommit();
  setStateFreeBytesProbeForTests(null);
  document.body.replaceChildren();
});
function Probe() {
  const data = useFiles();
  return <StateWritesAlert storage={data.systemHealth.storage} />;
}
async function settle() { await Bun.sleep(20); flushSync(() => undefined); }
async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Probe />));
  await settle();
  return host;
}
function failCommit() {
  injectStateWriteFaultForTests({ site: "commit", collection: "health-probe", error: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) });
  expect(() => store.boundedPatch(1, (tx) => tx.put({ key: "failed" }))).toThrow(StateDiskFullError);
  expect(store.get("failed")).toBeNull();
  injectStateWriteFaultForTests(null);
}

test.each([false, true])("idle live view discovers commit failure and recovery (phone=%s)", async (isPhone) => {
  phone = isPhone;
  const host = await mount();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  failCommit();
  expect(stateWriteHealth(directory).state).toBe("disk-full");
  tick?.(); await settle();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(catalogReads).toBe(1);
  store.boundedPatch(1, (tx) => tx.put({ key: "recovered" }));
  tick?.(); await settle();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(healthReads).toBe(2);
  expect(catalogReads).toBe(1);
});

test("hidden live views pause health traffic and refresh immediately on return", async () => {
  phone = true;
  const host = await mount();
  hidden = true; document.dispatchEvent(new Event("visibilitychange"));
  failCommit(); tick?.(); await settle();
  expect(healthReads).toBe(0);
  hidden = false; document.dispatchEvent(new Event("visibilitychange")); await settle();
  expect(healthReads).toBe(1);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

test("health reads never overlap and abort when the live view unmounts", async () => {
  await mount();
  let signal: AbortSignal | null | undefined;
  serveHealth = (next) => { signal = next; return new Promise((_resolve, reject) => {
    next?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }); };
  tick?.(); tick?.(); await settle();
  expect(healthReads).toBe(1);
  flushSync(() => root?.unmount()); root = null;
  expect(signal?.aborted).toBe(true);
});

test.each([false, true])("hung catalog cannot block live failure and recovery alerts (phone=%s)", async (isPhone) => {
  phone = isPhone;
  const host = await mount();
  let release!: (response: Response) => void;
  serveCatalog = () => new Promise<Response>((resolve) => { release = resolve; });
  window.dispatchEvent(new Event("llv:files-changed"));
  await settle();
  expect(catalogReads).toBe(2);
  failCommit();
  tick?.(); await settle();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  release(Response.json({ files: [], systemHealth: { storage: { writes: { state: "ok", freeBytes: 1024 ** 3, since: null } } } }));
  await settle();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  window.dispatchEvent(new Event("llv:files-changed"));
  await settle();
  store.boundedPatch(1, (tx) => tx.put({ key: "recovered" }));
  tick?.(); await settle();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  release(Response.json({ files: [], systemHealth: { storage: { writes: { state: "disk-full", freeBytes: 0, since: null } } } }));
  await settle();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(healthReads).toBe(2);
});

test("health timeout frees polling when fetch ignores abort", async () => {
  const host = await mount();
  let expire!: () => void;
  const originalTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
    if (delay === 10_000) { expire = handler; return 456; }
    return originalTimeout(handler, delay);
  }) as typeof setTimeout);
  let release!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  serveHealth = (next) => { signal = next; return new Promise((resolve) => { release = resolve; }); };
  try {
    tick?.(); await settle();
    expire(); await settle();
    expect(signal?.aborted).toBe(true);
    failCommit();
    serveHealth = async () => Response.json(stateWriteHealth(directory));
    tick?.(); await settle();
    expect(healthReads).toBe(2);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    release(Response.json({ state: "ok", freeBytes: 1024 ** 3, since: null }));
    await settle();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  } finally { timeout.mockRestore(); }
});
