import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { setSystemTime, spyOn } from "bun:test";
import { AgentRegistry, agentRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";
import { registryLockHolder } from "./registryLockHolderFixture";
import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "./spawnCommand";
import { executeSpawnAdmissionValidation } from "./spawnAdmissionValidation";
import { readSpawnAdmissionFence } from "./spawnAdmission";
import { launchAutonomousConversation } from "./autonomousConversation";
import { ensureOperatorSpawnCapability } from "./operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "./spawnPolicy";
import { reportSpawnHeaders } from "@/lib/telegram/reportSpawn";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import { sendOwnerContinuation } from "@/lib/externalRelay/ownerRun";

const [route, site, revoked] = process.argv.slice(2);
setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
let nextId = 0;
const ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
  `aaaaaaaa-0000-4000-8000-${(++nextId).toString(16).padStart(12, "0")}` as ReturnType<typeof crypto.randomUUID>);
const root = process.env.LLV_STATE_DIR!;
const stem = route === "continuation" ? "agent-registry" : "launch-registry";
const filename = path.join(root, `${stem}.json`);
const sqliteFilename = path.join(root, `${stem}.sqlite`);
const options = { sqliteMode: "sqlite" as const, deferColdKeyInitialization: true };
const open = () => new AgentRegistry(filename, undefined, undefined, options);
open().close();
if (route === "continuation") {
  agentRegistry().close();
  delete (process as typeof process & { __llvAgentRegistry?: AgentRegistry }).__llvAgentRegistry;
}
let registry: AgentRegistry | undefined = site === "writer" ? open() : undefined;
const holder = registryLockHolder(sqliteFilename);
const observed = Promise.withResolvers<void>();
let constructorBusy = false, errno: number | undefined, attempts = 0;
let authorized = true, dispatches = 0;
const dispatched = Promise.withResolvers<void>();
const work: Promise<void>[] = [];
const cwd = path.join(root, "workspace");
fs.mkdirSync(cwd, { recursive: true });
const account = { engine: "claude" as const, accountId: "fixture-account", kind: "managed" as const,
  home: path.join(root, "account"), transcriptRoot: path.join(root, "projects"), env: { NODE_ENV: "test" } };
const dependencies: SpawnCommandDependencies = {
  ...productionSpawnCommandDependencies,
  registry: () => {
    attempts++;
    try { return registry ??= open(); }
    catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") {
        constructorBusy = true; errno = (error as { errno?: number }).errno; observed.resolve();
      }
      throw error;
    }
  },
  resolveHealthySpawnAccount: async () => account,
  resolveSpawnAccount: () => account,
  resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
  runtimeHostClient: () => ({} as RuntimeHostClient),
  assertStructuredRuntime: () => {},
  engineReadiness: () => "connected",
  defer: callback => { work.push(callback()); },
  storeImages: () => [],
  spawnStructuredConversation: async input => {
    dispatches++; dispatched.resolve();
    return { ok: true, target: null, path: null, effectivePermissionMode: "default",
      launchId: input.receipt.launchId, conversationId: input.receipt.conversationId,
      launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
  },
  authorizeAutonomousLaunch: () => { if (!authorized) throw new Error("fixture launch revoked"); },
};
const writerPrototype = SqliteAgentRegistryStore.prototype as unknown as {
  tryBeginWrite(this: SqliteAgentRegistryStore): boolean;
};
const begin = writerPrototype.tryBeginWrite;
const probe = spyOn(writerPrototype, "tryBeginWrite").mockImplementation(function (this: SqliteAgentRegistryStore) {
  const acquired = begin.call(this);
  if (site === "writer" && this.filename === sqliteFilename && !acquired) observed.resolve();
  return acquired;
});
// The default singleton also prepares archive schema before runAtomically.
// Observe the real transaction's refusal without changing its lock behaviour.
type Transaction = { immediate(...args: never[]): unknown };
const databasePrototype = Database.prototype as unknown as { transaction(callback: (...args: never[]) => unknown): Transaction };
const transaction = databasePrototype.transaction;
const transactionProbe = spyOn(databasePrototype, "transaction").mockImplementation(function (this: Database, callback: (...args: never[]) => unknown) {
  const prepared = transaction.call(this, callback), immediate = prepared.immediate;
  if (route !== "continuation") return prepared;
  const properties = Object.getOwnPropertyDescriptors(prepared);
  properties.immediate = { ...properties.immediate, value: (...args: never[]) => {
    attempts++;
    try { return immediate.apply(prepared, args); }
    catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") {
        constructorBusy = true; errno = (error as { errno?: number }).errno; observed.resolve();
      }
      throw error;
    }
  } };
  // Bun's transaction methods are readonly. Preserve its callable and all
  // descriptors while observing immediate(), rather than mutating the native.
  return Object.defineProperties((...args: never[]) => Reflect.apply(prepared as unknown as (...args: never[]) => unknown, prepared, args), properties) as Transaction;
});
const originalDependencies = { ...productionSpawnCommandDependencies };
const body = { clientAttemptId: `writer_${route}_${site}_${revoked}`, engine: "claude", model: "sonnet",
  title: "Registry contention fixture", cwd, prompt: "Inspect the fixture", mcpServers: [] };
const headers = reportSpawnHeaders(ensureOperatorSpawnCapability(), VIEWER_SPAWN_CAPABILITY_HEADER);
if (route === "validation" || route === "agent-refusal") { headers.delete("origin"); headers.delete("sec-fetch-site"); }
if (["validation", "refusal", "agent-refusal"].includes(route!)) Object.assign(body, { role: "invalid-registry-fixture-role" });
let settled = false, yielded = false;
let outcome: { status: number; error: string | null } = { status: 0, error: null };
try {
  Object.assign(productionSpawnCommandDependencies, dependencies);
  if (route === "drain") writeDrain(drainFile(), { id: "fixture-launch-drain", target: "a".repeat(40), since: "2026-10-25T00:00:00.000Z", until: 0, persistent: true });
  await holder.hold();
  const request = new NextRequest("http://127.0.0.1/api/spawn", { method: "POST", headers, body: JSON.stringify(body) });
  let responseCode: string | null = null;
  const pending = (route === "continuation"
    ? sendOwnerContinuation({ clientAttemptId: body.clientAttemptId, claimedAt: "2026-10-25T00:00:00.000Z", conversationId: "conversation_fixture_continuation",
        continuation: { operationId: "fixture-continuation" } }, body.prompt,
      { id: "fixture-target", name: "Fixture", answered_by: "install", fallback: "none", enabled: true,
        engine: "claude", model: null, effort: null, project: null, concurrency: 1, hardCapMinutes: 1 }, dependencies.authorizeAutonomousLaunch!)
      .then(result => result && !result.ok ? { status: result.status, body: { error: result.error } }
        : { status: 202, body: { error: null } })
    : route === "relay" || route === "drain"
    ? launchAutonomousConversation(body, dependencies.authorizeAutonomousLaunch, { structured: true })
    : (route === "validation" ? executeSpawnAdmissionValidation(request, dependencies) : executeSpawnRequest(request, dependencies))
      .then(async response => ({ status: response.status, body: await response.json() })))
    .then(result => { responseCode = typeof result.body.code === "string" ? result.body.code : null;
      return { status: result.status, error: typeof result.body.error === "string" ? result.body.error : null }; },
      error => ({ status: 500, error: error instanceof Error ? error.message : String(error) }))
    .then(result => { settled = true; outcome = result; return result; });
  await Promise.race([observed.promise, pending.then(result => { throw new Error(`launch finished without observing the held writer: ${JSON.stringify(result)}`); })]);
  await new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const settledBeforeRelease = settled;
  if (revoked === "yes") authorized = false;
  await holder.release();
  await pending;
  if (outcome.status === 202) await dispatched.promise;
  await Promise.all(work);
  const receipt = registry?.spawnReceiptForClientAttempt(body.clientAttemptId);
  console.log(JSON.stringify({ ...outcome, constructorBusy, errno, attempts, yielded, settledBeforeRelease,
    dispatches, receipt: !!receipt, membershipAdmitted: receipt?.membershipAdmitted ?? false,
    fenced: !!readSpawnAdmissionFence(body.clientAttemptId), code: responseCode }));
} finally {
  probe.mockRestore();
  transactionProbe.mockRestore();
  Object.assign(productionSpawnCommandDependencies, originalDependencies);
  await holder.close();
  registry?.close();
  if (route === "continuation") (process as typeof process & { __llvAgentRegistry?: AgentRegistry }).__llvAgentRegistry?.close();
  if (route === "drain") releaseDrain(drainFile(), "fixture-launch-drain");
  ids.mockRestore();
  setSystemTime();
}
