import fs from "node:fs";
import path from "node:path";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { procBackend } from "@/lib/proc";
import { findAgentBinary } from "../../../bin/agent-binaries.mjs";
import { agentSignalDomainAlive, signalDomain } from "@/lib/runtime/agentSignalSandbox";

export function updateDirectory(binary: string): string {
  return path.join(path.dirname(binary), ".delegatus-codex");
}

/** The executable link is the only shared write. Package contents stay immutable. */
export class UnsupportedCodexInstallError extends Error {}
export function installedTarget(binary: string): string {
  if (!path.isAbsolute(binary) || path.basename(binary) !== "codex" || !fs.lstatSync(binary).isSymbolicLink()) {
    throw new UnsupportedCodexInstallError("unknown install location");
  }
  const target = fs.realpathSync(binary);
  if (!target.split(path.sep).join("/").endsWith("/node_modules/@openai/codex/bin/codex.js")) {
    throw new UnsupportedCodexInstallError("unknown install location");
  }
  fs.accessSync(path.dirname(binary), fs.constants.W_OK | fs.constants.X_OK);
  return target;
}

export function withCliSwitch<T>(binary: string, operation: () => T | Promise<T>): Promise<T> {
  return withFileTransaction(path.join(updateDirectory(binary), "switch"), "Codex CLI switch busy", operation);
}

/** Agents and account/voice clients share the updater's cross-process lock.
 * Hold it through initialization, including delayed namespace execs. */
export async function waitForCodexProcess(handle: number | { pid?: number }, timeoutMs = 15_000): Promise<void> {
  const pid = typeof handle === "number" ? handle : handle.pid;
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!procBackend.pidAlive(pid) || procBackend.processExited(pid)) return;
    // Signal-sandbox receipts authenticate the native engine behind the
    // persistent Python monitor. Other supported wrappers are resolved by
    // walking only descendants of the process we launched.
    try {
      const domain = signalDomain(typeof handle === "number" ? { pid } : handle);
      if (domain && agentSignalDomainAlive(domain)) return;
    } catch { /* malformed receipts remain unobservable */ }
    const parents = procBackend.ppidMap();
    const descendants: Set<number> = new Set([pid]);
    for (;;) {
      let changed = false;
      for (const [child, parent] of parents) if (descendants.has(parent) && !descendants.has(child)) {
        descendants.add(child); changed = true;
      }
      if (!changed) break;
    }
    for (const candidatePid of Array.from(descendants) as number[]) {
      if (candidatePid !== pid && (!procBackend.pidAlive(candidatePid) || procBackend.processExited(candidatePid))) continue;
      const argv = procBackend.readArgv(candidatePid).map(argument => path.basename(argument).toLowerCase());
      if (argv.some(argument => /^codex(?:$|[.-])/.test(argument))) return;
    }
    if (Date.now() >= deadline) throw new Error("Codex process did not become observable after launch");
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

function managedLaunchBinary(binary: string): string | undefined {
  if (binary === "codex") binary = findAgentBinary("codex") ?? binary;
  try { installedTarget(binary); }
  catch (error) {
    if (error instanceof UnsupportedCodexInstallError || ["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw new Error("Codex CLI install location could not be read safely", { cause: error });
  }
  fs.mkdirSync(updateDirectory(binary), { recursive: true, mode: 0o700 });
  return binary;
}

export async function withCodexCliLaunch<T>(binary: string, operation: () => Promise<T>, observable?: (result: T) => Promise<void>): Promise<T> {
  const managed = managedLaunchBinary(binary);
  if (!managed) return operation();
  return withCliSwitch(managed, async () => {
    const result = await operation();
    await observable?.(result);
    return result;
  });
}

type QuotaLaunchGroup = {
  homes: Map<string, string | undefined>;
  join: <T>(home: string, id: string | undefined, operation: () => Promise<T>) => Promise<T>;
};
const quotaLaunches = new Map<string, QuotaLaunchGroup>();

function soleSwitchTicket(binary: string): string | undefined {
  const queue = path.join(updateDirectory(binary), "switch.write-locks");
  try {
    const tickets = fs.readdirSync(queue).filter(name => name.endsWith(".json"));
    if (tickets.length === 1) return path.join(queue, tickets[0]);
  } catch { /* Fall back to normal file admission on an unreadable queue. */ }
}

function homeDirectoryId(home: string): string | undefined {
  try {
    const stat = fs.statSync(home, { bigint: true });
    if (stat.isDirectory() && stat.ino > BigInt(0)) return `${stat.dev}:${stat.ino}`;
  } catch { /* Unresolved homes initialize under their own switch ticket. */ }
}

/** Quota clients read the same installed version and initialize independent
 * children. They may share our active ticket until any other ticket queues.
 * Switches and launches from older releases still see the physical lock. */
export async function withCodexQuotaLaunch<T>(binary: string, home: string, operation: () => Promise<T>): Promise<T> {
  const managed = managedLaunchBinary(binary);
  if (!managed) return operation();
  const existing = quotaLaunches.size ? soleSwitchTicket(managed) : undefined;
  const group = existing && quotaLaunches.get(existing);
  if (group) {
    const id = homeDirectoryId(home);
    // A home may be replaced or a symlink retargeted during initialization.
    if (id && [...group.homes].every(([path, previous]) => previous !== id && homeDirectoryId(path) === previous)) {
      return group.join(home, id, operation);
    }
  }

  const first = Promise.withResolvers<T>();
  const drained = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const homes: QuotaLaunchGroup["homes"] = new Map();
  let ticket: string | undefined;
  let admitted = false;
  void withCliSwitch(managed, () => {
    admitted = true;
    const id = homeDirectoryId(home);
    ticket = id ? soleSwitchTicket(managed) : undefined;
    if (ticket) quotaLaunches.set(ticket, { homes, join });
    first.resolve(join(home, id, operation));
    return drained.promise;
  }).then(exited.resolve, error => {
    if (admitted) exited.reject(error);
    else first.reject(error);
  });
  return first.promise;

  async function join<R>(path: string, id: string | undefined, start: () => Promise<R>): Promise<R> {
    homes.set(path, id);
    try {
      return await start();
    } finally {
      homes.delete(path);
      if (!homes.size) {
        if (ticket) quotaLaunches.delete(ticket);
        drained.resolve();
        await exited.promise;
      }
    }
  }
}

export function switchCli(binary: string, expected: string, target: string): void {
  if (installedTarget(binary) !== expected) throw new Error("installed CLI changed during update");
  const temporary = path.join(updateDirectory(binary), "next-link");
  // Both forward and rollback links are prepared before the final idle scan.
  if (fs.realpathSync(temporary) !== target) throw new Error("prepared CLI link changed");
  fs.renameSync(temporary, binary);
}

export function prepareSwitch(binary: string, target: string): void {
  const temporary = path.join(updateDirectory(binary), "next-link");
  try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  fs.symlinkSync(target, temporary);
}
