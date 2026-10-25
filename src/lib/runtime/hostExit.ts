import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { statePath } from "@/lib/configDir";
import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";

export interface HostStopOrigin { path: string; operationId: string }
export interface HostExitRecord {
  process: ProcessIdentity;
  stop: (HostStopOrigin & { at: string; signal: string }) | null;
  exit: { at: string; code: number | null; signal: string | null } | null;
  unavailable?: string;
}

const globals = globalThis as typeof globalThis & { __delegatusHostStopOrigin?: AsyncLocalStorage<HostStopOrigin> };
const origin = globals.__delegatusHostStopOrigin ??= new AsyncLocalStorage<HostStopOrigin>();
export function withHostStopOrigin<T>(source: HostStopOrigin, run: () => T): T {
  return origin.run(origin.getStore() ?? source, run);
}

/** A host owns two bounded receipts. Separate slots keep an exit
 * observer and a signal sender from overwriting each other's evidence. They
 * require no registry lock, including at the synchronous signal boundary. */
function slot(process: ProcessIdentity, kind: "stop" | "exit"): string {
  const key = createHash("sha256").update(JSON.stringify([process.pid, process.startIdentity, process.bootEpoch ?? null])).digest("hex");
  return statePath("host-exits", `${key}.${kind}.json`);
}
function read<T>(file: string): T | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      if (fs.fstatSync(fd).size > 4096) throw new Error("host exit receipt exceeds its bound");
      return JSON.parse(fs.readFileSync(fd, "utf8")) as T;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

export function recordHostStop(process: ProcessIdentity | null | undefined, signal: string, fallback: string): void {
  if (!process?.startIdentity) return;
  try {
    // Cleanup after exit cannot retroactively claim to have caused that exit.
    if (read(slot(process, "exit"))) return;
    const source = origin.getStore() ?? { path: fallback, operationId: randomUUID() };
    const file = slot(process, "stop");
    const prior = read<HostExitRecord["stop"]>(file);
    const next = { path: source.path.slice(0, 160), operationId: source.operationId.slice(0, 200), signal };
    if (prior?.path === next.path && prior.operationId === next.operationId && prior.signal === signal) return;
    record(file, { ...next, at: new Date().toISOString() }, true);
  } catch (error) { console.error("[host exit] could not persist stop intent", error); }
}
export function recordHostExit(process: ProcessIdentity | null | undefined, code: number | null | undefined, signal: string | null | undefined): void {
  if (!process?.startIdentity || code === undefined && signal === undefined) return;
  try {
    record(slot(process, "exit"), { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() });
  } catch (error) { console.error("[host exit] could not persist exit status", error); }
}
export function observeHostExit(child: EventEmitter, process: ProcessIdentity | null): void {
  const observe = (code: number | null, signal: string | null) => recordHostExit(process, code, signal);
  child.once("exit", observe);
  child.once("close", observe);
}
export function readHostExit(process: ProcessIdentity | null | undefined): HostExitRecord | null {
  if (!process?.startIdentity) return null;
  try { return { process, stop: read(slot(process, "stop")), exit: read(slot(process, "exit")) }; }
  catch { return { process, stop: null, exit: null, unavailable: "host exit receipts could not be read" }; }
}
export function hostExitText(evidence: HostExitRecord | null): string {
  if (evidence?.unavailable) return "exit: status unavailable; Delegatus stop evidence unavailable";
  const exit = evidence?.exit;
  const status = exit?.signal ? `signal ${exit.signal}` : exit?.code !== null && exit?.code !== undefined ? `code ${exit.code}` : "status unavailable";
  return `exit: ${status}; ${evidence?.stop ? `stopped by ${evidence.stop.path} (${evidence.stop.operationId})` : "no Delegatus stop recorded"}`;
}

/** The immutable identity survives a child's reap and a released host's null pid. */
export function hostExitProcess(pid: number | undefined, identity: string | null): ProcessIdentity | null {
  return pid && identity ? captureProcessIdentity(pid, undefined, identity) : null;
}
