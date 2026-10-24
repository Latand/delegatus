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

export async function withCodexCliLaunch<T>(binary: string, operation: () => Promise<T>, observable?: (result: T) => Promise<void>): Promise<T> {
  if (binary === "codex") binary = findAgentBinary("codex") ?? binary;
  try { installedTarget(binary); }
  catch (error) {
    if (error instanceof UnsupportedCodexInstallError || ["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return operation();
    throw new Error("Codex CLI install location could not be read safely", { cause: error });
  }
  fs.mkdirSync(updateDirectory(binary), { recursive: true, mode: 0o700 });
  return withCliSwitch(binary, async () => {
    const result = await operation();
    await observable?.(result);
    return result;
  });
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
