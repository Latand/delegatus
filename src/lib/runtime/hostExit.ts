import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { statePath } from "@/lib/configDir";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";

export interface HostStopOrigin { path: string; operationId: string }
export interface HostExitRecord {
  process: ProcessIdentity;
  stop: (HostStopOrigin & { at: string; signal: string }) | null;
  exit: { at: string; code: number | null; signal: string | null } | null;
  unavailable?: string;
}
type HostExitSummary = Pick<HostExitRecord, "exit" | "stop" | "unavailable">;

const globals = globalThis as typeof globalThis & { __delegatusHostStopOrigin?: AsyncLocalStorage<HostStopOrigin> };
const origin = globals.__delegatusHostStopOrigin ??= new AsyncLocalStorage<HostStopOrigin>();
export function withHostStopOrigin<T>(source: HostStopOrigin, run: () => T): T {
  return origin.run(origin.getStore() ?? source, run);
}

/** A host owns two bounded receipts and a transient waiter identity. Separate slots keep an exit
 * observer and a signal sender from overwriting each other's evidence. They
 * require no registry lock, including at the synchronous signal boundary. */
function slot(process: ProcessIdentity, kind: "stop" | "exit" | "writer"): string {
  const key = createHash("sha256").update(JSON.stringify([process.pid, process.startIdentity, process.bootEpoch ?? null])).digest("hex");
  return statePath("host-exits", `${key}.${kind}.json`);
}

/** The independent native waiter receives only its own immutable output slot. */
export function bindHostExitWriter(directory: string, process: ProcessIdentity, writer = captureProcessIdentity(globalThis.process.pid)): void {
  record(slot(process, "writer"), writer);
  fs.writeFileSync(path.join(directory, "host-exit.json"), JSON.stringify({ file: slot(process, "exit") }), { mode: 0o600 });
}

export function hostExitWriterPending(process: ProcessIdentity): boolean {
  try {
    const writer = read<ProcessIdentity>(slot(process, "writer"));
    return writer !== null && processIdentityStatus(writer) !== "dead";
  } catch { return false; }
}
export function hostExitWriterRegistered(process: ProcessIdentity): boolean {
  return fs.existsSync(slot(process, "writer"));
}
function readDescriptor<T>(fd: number): T {
  if (fs.fstatSync(fd).size > 4096) throw new Error("host exit receipt exceeds its bound");
  return JSON.parse(fs.readFileSync(fd, "utf8")) as T;
}
function read<T>(file: string): T | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      return readDescriptor<T>(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

type StopReceipt = NonNullable<HostExitRecord["stop"]> & {
  active?: 0 | 1; prior?: HostExitRecord["stop"]; requestId?: string;
};
// This first JSON property has a single-byte value, changed only through an
// open descriptor. A replacement sender owns another inode, so withdrawal
// cannot erase it between a comparison and a pathname mutation.
const STOP_ACTIVE_PREFIX = '{"active":';
function readStop(file: string): HostExitRecord["stop"] {
  const receipt = read<StopReceipt>(file);
  if (!receipt) return null;
  if (receipt.active === 0) return receipt.prior ?? null;
  const { path, operationId, signal, at } = receipt;
  return { path, operationId, signal, at };
}
function record(file: string, value: unknown, replace = false): void {
  if (!replace && fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      if (replace) fs.renameSync(temporary, file);
      else fs.linkSync(temporary, file);
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(file), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function recordHostStop(process: ProcessIdentity | null | undefined, signal: string, fallback: string): (() => void) | undefined {
  if (!process?.startIdentity) return;
  try {
    // Cleanup after exit cannot retroactively claim to have caused that exit.
    if (read(slot(process, "exit"))) return;
    const source = origin.getStore() ?? { path: fallback, operationId: randomUUID() };
    const file = slot(process, "stop");
    const prior = readStop(file);
    const next = { path: source.path.slice(0, 160), operationId: source.operationId.slice(0, 200), signal };
    if (prior?.path === next.path && prior.operationId === next.operationId && prior.signal === signal) return;
    const intent = { ...next, at: new Date().toISOString() };
    const requestId = randomUUID();
    record(file, { active: 1, prior, requestId, ...intent }, true);
    return () => {
      // A refused sender may withdraw only its own intent, preserving an
      // earlier signal and any newer sender that took over in the meantime.
      try {
        const fd = fs.openSync(file, "r+");
        try {
          if (readDescriptor<StopReceipt>(fd).requestId !== requestId) return;
          fs.writeSync(fd, Buffer.from("0"), 0, 1, STOP_ACTIVE_PREFIX.length);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      } catch (error) { console.error("[host exit] could not withdraw refused stop intent", error); }
    };
  } catch (error) { console.error("[host exit] could not persist stop intent", error); }
}
export function recordHostExit(process: ProcessIdentity | null | undefined, code: number | null | undefined, signal: string | null | undefined): boolean {
  if (!process?.startIdentity || code === undefined && signal === undefined) return false;
  try {
    record(slot(process, "exit"), { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() });
    fs.rmSync(slot(process, "writer"), { force: true });
    return true;
  } catch (error) { console.error("[host exit] could not persist exit status", error); return false; }
}
export function observeHostExit(child: EventEmitter, process: ProcessIdentity | null): void {
  if (process?.startIdentity && (hostExitWriterRegistered(process) || readHostExit(process)?.exit)) return;
  if (process?.startIdentity && !readHostExit(process)?.exit) {
    try { record(slot(process, "writer"), captureProcessIdentity(globalThis.process.pid)); }
    catch (error) { console.error("[host exit] could not retain wait owner", error); }
  }
  const observe = (code: number | null, signal: string | null) => {
    if (!recordHostExit(process, code, signal)) return;
    child.off("exit", observe);
    child.off("close", observe);
  };
  child.once("exit", observe);
  child.once("close", observe);
}

/** Called only after the owning row/attempt durably retained terminal evidence. */
export function reclaimHostExit(process: ProcessIdentity): void {
  for (const kind of ["stop", "exit", "writer"] as const) fs.rmSync(slot(process, kind), { force: true });
}
export function readHostExit(process: ProcessIdentity | null | undefined): HostExitRecord | null {
  if (!process?.startIdentity) return null;
  try { return { process, stop: readStop(slot(process, "stop")), exit: read(slot(process, "exit")) }; }
  catch { return { process, stop: null, exit: null, unavailable: "host exit receipts could not be read" }; }
}
/** Startup can fail before the native identity is admitted to a host row. */
export function readHostExitSpool(directory: string): HostExitSummary | null {
  try {
    const exit = read<HostExitRecord["exit"]>(path.join(directory, "native-exit.json"));
    return exit ? { exit, stop: read<HostExitRecord["stop"]>(path.join(directory, "native-stop.json")) } : null;
  } catch { return null; }
}
export function hostExitText(evidence: HostExitSummary | null): string {
  if (evidence?.unavailable) return "exit: status unavailable; Delegatus stop evidence unavailable";
  const exit = evidence?.exit;
  const status = exit?.signal ? `signal ${exit.signal}` : exit?.code !== null && exit?.code !== undefined ? `code ${exit.code}` : "status unavailable";
  return `exit: ${status}; ${evidence?.stop ? `stopped by ${evidence.stop.path} (${evidence.stop.operationId})` : "no Delegatus stop recorded"}`;
}

/** The immutable identity survives a child's reap and a released host's null pid. */
export function hostExitProcess(pid: number | undefined, identity: string | null): ProcessIdentity | null {
  return pid && identity ? captureProcessIdentity(pid, undefined, identity) : null;
}
