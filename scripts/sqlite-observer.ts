/* Preload for isolated fixture processes. Both static imports and the lazy
 * process.getBuiltinModule path use the same observed Database constructor. */
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { mock } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import * as sqlite from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const extension = process.env.MCP_SQL_OBSERVER;
const events = process.env.MCP_SQL_EVENTS;
if (!extension || !events || !process.env.LLV_STATE_DIR?.startsWith("/tmp/")) {
  throw new Error("SQLite observation requires an explicit isolated fixture root and output");
}
const log = fs.openSync(`${events}.js`, "a");
const context = new AsyncLocalStorage<{ call: string; collection?: string; acquiring?: boolean }>();
const native = dlopen(extension, { delegatus_observer_context: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.void } });
const empty = Buffer.from([0]);
const buffer = (value?: string) => value ? Buffer.from(`${value}\0`) : empty;
function nativeContext(collection?: string): void {
  const current = context.getStore();
  native.symbols.delegatus_observer_context(buffer(current?.call), buffer(collection ?? current?.collection));
}
const register = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function (this: McpServer, name, configuration, callback) {
  return register.call(this, name, configuration, ((args: Record<string, unknown>, extra: { requestId: unknown }) => {
    const call = `${name}:${args.clientRequestId ?? extra.requestId}`;
    return context.run({ call }, async () => {
      observe("call-start", { name });
      try { return await (callback as (...args: unknown[]) => unknown)(args, extra); }
      finally { observe("call-end", { name }); }
    });
  }) as unknown as typeof callback);
} as typeof register;
export function observe(event: string, fields: Record<string, unknown> = {}): void {
  fs.writeSync(log, `${JSON.stringify({ pid: process.pid, atNs: Number(process.hrtime.bigint()), atMs: Date.now(), event, ...context.getStore(), ...fields })}\n`);
}
let busyResults = 0;
let connectionId = 0;
const NativeDatabase = sqlite.Database;
class ObservedDatabase extends NativeDatabase {
  constructor(...args: ConstructorParameters<typeof NativeDatabase>) {
    nativeContext();
    try { super(...args); }
    catch (error) { observe("open-failed", { database: path.basename(String(args[0])), error: String(error) }); throw error; }
    this.loadExtension(extension!, "sqlite3_observer_init");
    const connection = ++connectionId;
    const database = path.basename(String(args[0] ?? "memory"));
    for (const name of ["exec", "run", "query", "prepare", "close"] as const) {
      const original = this[name].bind(this) as (...args: unknown[]) => unknown;
      Object.defineProperty(this, name, { configurable: true, writable: true, value: (...args: unknown[]) => {
        const result = checked(() => original(...args), name, database, connection);
        if (name === "query" || name === "prepare") observeStatement(result as import("bun:sqlite").Statement, database, connection);
        return result;
      } });
    }
  }
  static override open(...args: Parameters<typeof NativeDatabase.open>) { return new ObservedDatabase(...args); }
}
const nativeModule = { ...sqlite, Database: ObservedDatabase };
mock.module("bun:sqlite", () => nativeModule);
const builtin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = ((name: string) => name === "bun:sqlite" ? nativeModule : builtin(name)) as typeof process.getBuiltinModule;

function checked<T>(operation: () => T, method: string, database: string, connection: number, collection?: string): T {
  nativeContext(collection);
  try { return operation(); }
  catch (error) {
    const code = (error as { errno?: number }).errno;
    const primary = typeof code === "number" ? code & 255 : 0;
    if (primary === 5 || primary === 6) { busyResults++; observe("busy-result", { code, primary, method, database, connection }); }
    throw error;
  }
}
const observedStatements = new WeakSet();
function observeStatement(statement: import("bun:sqlite").Statement, database: string, connection: number) {
  if (observedStatements.has(statement)) return;
  observedStatements.add(statement);
  const collectionBound = /\bcollection\b/.test(statement.toString());
  for (const name of ["run", "get", "all", "values"] as const) {
    const original = statement[name].bind(statement);
    Object.defineProperty(statement, name, { configurable: true, writable: true, value: (...args: import("bun:sqlite").SQLQueryBindings[]) => checked(() => original(...args), name, database, connection,
      collectionBound && typeof args[0] === "string" && args[0].length < 128 ? args[0] : undefined) });
  }
}

/** Instrument the existing lease methods without changing store source or its
 * timing policy. Call before constructing any fixture collection. */
export async function observeLeases(): Promise<void> {
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  // TypeScript private methods are ordinary properties in the running fixture.
  const prototype = SqliteStateCollection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const attempt = prototype.tryAcquireLease!;
  prototype.tryAcquireLease = function (...args) {
    const before = busyResults;
    const result = attempt.apply(this, args);
    const collection = (this as unknown as { options: { collection: string } }).options.collection;
    observe(result ? "lease-acquired" : before === busyResults ? "lease-held-refusal" : "lease-sql-refusal", { collection, token: args[1] });
    return result;
  };
  for (const name of ["acquireLease", "acquireLeaseSync"] as const) {
    const original = prototype[name]!;
    prototype[name] = function (...args) {
      const start = Number(process.hrtime.bigint());
      const collection = (this as unknown as { options: { collection: string } }).options.collection;
      const done = () => observe("lease-acquisition-ns", { collection, duration: Number(process.hrtime.bigint()) - start });
      try {
        const result = context.run({ ...context.getStore(), call: context.getStore()?.call ?? "", collection, acquiring: true }, () => original.apply(this, args));
        if (result instanceof Promise) return result.finally(done);
        done(); return result;
      } catch (error) { done(); throw error; }
    };
  }
}
// Only waits made from the store's acquisition/retry code are attributed.
// A timer's elapsed time includes scheduler delay and is separate from SQLite
// VFS busy sleeps, which the native observer measures around xSleep.
const wait = Atomics.wait;
Atomics.wait = ((...args: Parameters<typeof wait>) => {
  const start = process.hrtime.bigint();
  try { return wait(...args); }
  finally { observe("application-sync-wait-ns", { duration: Number(process.hrtime.bigint() - start) }); }
}) as typeof wait;
const timer = globalThis.setTimeout;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  if (!context.getStore()?.acquiring) return timer(callback, ms, ...args);
  const start = process.hrtime.bigint();
  return timer((...values: unknown[]) => { observe("lease-retry-wait-ns", { duration: Number(process.hrtime.bigint() - start) }); callback(...values); }, ms, ...args);
}) as typeof timer;
observe("process", { identity: fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[19] });
if (process.env.MCP_BENCH_TASK_EXECUTOR === "1") {
  observe("task-executor-process");
  const caller = await import("../src/lib/mcp/callerContext");
  const run = caller.runAsMcpHttpCaller;
  let sequence = 0;
  mock.module("../src/lib/mcp/callerContext", () => ({ ...caller,
    runAsMcpHttpCaller: <T>(identity: import("../src/lib/mcp/callerContext").McpHttpCaller, operation: () => T): T =>
      run(identity, () => context.run({ call: `executor-${++sequence}` }, () => {
        observe("call-start");
        return Promise.resolve().then(operation).finally(() => observe("call-end")) as T;
      })),
  }));
}
if (process.env.MCP_BENCH_LEASES === "1") await observeLeases();
