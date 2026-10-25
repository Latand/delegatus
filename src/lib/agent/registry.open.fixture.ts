import { Database } from "bun:sqlite";
import path from "node:path";
import * as registryModule from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { stateLockWaitDiagnostics, waitForStateLock } from "@/lib/state/lockWait";
import { resetBlockingWaitsForTests } from "@/lib/blockingWaits";

resetBlockingWaitsForTests(() => {});

const [site, outcome] = process.argv.slice(2);
const filename = path.join(process.env.LLV_STATE_DIR!, "agent-registry.json");
new registryModule.AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" }).close();
const peer = new Database(filename.replace(/\.json$/, ".sqlite"));
peer.exec("PRAGMA busy_timeout=0");
const exec = Database.prototype.exec;
const prototype = SqliteAgentRegistryStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
const original = prototype[site!]!;
const abort = new AbortController();
let attempts = 0;
let held = false;
let yielded = false;
let busy = false;
let busyErrno: number | undefined;
let injected = false;
let release: Promise<void> = Promise.resolve();
let releaseDone = () => {};
function atSite() {
  attempts++;
  if (!injected) {
    injected = true;
    if (outcome === "error") throw new Error("registry open fixture failure");
    exec.call(peer, "BEGIN IMMEDIATE");
    held = true;
    peer.query("INSERT INTO registry_meta(key,value) VALUES ('open_fixture','preserved')").run();
    release = new Promise<void>(resolve => { releaseDone = resolve; });
    setImmediate(() => {
      yielded = true;
      if (outcome === "cancel") abort.abort(new Error("registry open withdrawn"));
      if (outcome === "success") {
        exec.call(peer, "COMMIT");
        held = false;
      }
      releaseDone();
    });
  }
}
function attempt<T>(operation: () => T): T {
  atSite();
  try { return operation(); }
  catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") {
      busy = true;
      busyErrno = (error as { errno?: number }).errno;
    }
    throw error;
  }
}
prototype[site!] = function (...args: unknown[]) {
  return attempt(() => original.apply(this, args));
};

// Keep the legacy singleton as the baseline entry, so a base run reaches the
// actual locked constructor instead of failing on a missing export.
const prepare = (registryModule as Partial<typeof registryModule>).prepareAgentRegistry
  ?? (() => registryModule.agentRegistry());
let error: string | null = null;
let sameSingleton = false;
let publishedAfterFailure = false;
try {
  const open = () => prepare(abort.signal);
  const first = outcome === "deadline"
    ? waitForStateLock("registry.open.fixture", open, { waitMs: 0 })
    : outcome === "timeout" ? waitForStateLock("registry.open.fixture", open, { waitMs: 50 })
    : Promise.resolve().then(open);
  const result = await first;
  sameSingleton = result === registryModule.agentRegistry() && result === await prepare();
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
  publishedAfterFailure = Boolean((process as typeof process & { __llvAgentRegistry?: unknown }).__llvAgentRegistry);
} finally {
  await release;
  prototype[site!] = original;
  if (held) { peer.exec("COMMIT"); held = false; }
}
const waits = stateLockWaitDiagnostics();
const preserved = peer.query<{ value: string }, []>("SELECT value FROM registry_meta WHERE key='open_fixture'").get()?.value;
// A cancelled, expired or failed open must leave the singleton retryable.
let recovered = false;
try { recovered = Boolean(await prepare()); }
finally { registryModule.closeAgentRegistryForTests(); peer.close(); }
console.log(JSON.stringify({ site, outcome, attempts, yielded, busy, busyErrno, error, sameSingleton,
  publishedAfterFailure, preserved, recovered, waits }));
