/* The Viewer's side of the launcher record (#2007, checkout mode). The
   writer is `bin/self-update-supervisor.mjs`, run by `bin/cli.mjs`, which
   started both processes and is the only one that stops or starts them. The
   Viewer reads what it recorded and asks for a restart by writing a request
   file; it never signals a process itself. The two sides agree on the JSON
   shape alone. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sameProcess } from "./pid";
import type { ProcessError, ProcessStateName } from "./types";

export type LauncherRole = "web" | "runtime-host";

export interface LauncherProcess {
  state: ProcessStateName;
  pid: number | null;
  startIdentity: string | null;
  startedAt: string | null;
  revision: string | null;
  error: ProcessError | null;
  requestId: string | null;
}

export interface LauncherRecord {
  version: 1;
  launcher: { pid: number; startIdentity: string | null };
  /** null for a packaged install: it is updated by its package manager. */
  checkout: string | null;
  releasesDir: string;
  releasePointer: string;
  requestFile: string;
  port: number;
  socket: string;
  web: LauncherProcess;
  runtimeHost: LauncherProcess;
  updatedAt: string;
}

const STATES: readonly ProcessStateName[] = ["stopped", "stopping", "starting", "healthy", "failed"];

function processEntry(value: unknown): LauncherProcess | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (!STATES.includes(entry.state as ProcessStateName)) return null;
  const text = (key: string) => typeof entry[key] === "string" ? entry[key] as string : null;
  return {
    state: entry.state as ProcessStateName,
    pid: typeof entry.pid === "number" && Number.isSafeInteger(entry.pid) ? entry.pid : null,
    startIdentity: text("startIdentity"),
    startedAt: text("startedAt"),
    revision: text("revision"),
    error: entry.error && typeof entry.error === "object" ? entry.error as ProcessError : null,
    requestId: text("requestId"),
  };
}

export function readLauncherRecord(file: string): LauncherRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const launcher = parsed.launcher as { pid?: unknown; startIdentity?: unknown } | undefined;
  const web = processEntry(parsed.web);
  const runtimeHost = processEntry(parsed.runtimeHost);
  if (parsed.version !== 1 || !launcher || typeof launcher.pid !== "number" || !web || !runtimeHost) return null;
  for (const key of ["releasesDir", "releasePointer", "requestFile", "socket"]) if (typeof parsed[key] !== "string") return null;
  return {
    version: 1,
    launcher: { pid: launcher.pid, startIdentity: typeof launcher.startIdentity === "string" ? launcher.startIdentity : null },
    checkout: typeof parsed.checkout === "string" ? parsed.checkout : null,
    releasesDir: parsed.releasesDir as string,
    releasePointer: parsed.releasePointer as string,
    requestFile: parsed.requestFile as string,
    port: typeof parsed.port === "number" ? parsed.port : 0,
    socket: parsed.socket as string,
    web,
    runtimeHost,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  };
}

/** A record left behind by a launcher that is gone names nobody. */
export function launcherAlive(record: LauncherRecord, same: typeof sameProcess = sameProcess): boolean {
  return record.launcher.startIdentity !== null && same({ pid: record.launcher.pid, startIdentity: record.launcher.startIdentity });
}

/** Files one restart request for the launcher to pick up. Answers its id. */
export function requestRestart(record: LauncherRecord, role: LauncherRole): string {
  const requestId = randomUUID();
  mkdirSync(dirname(record.requestFile), { recursive: true, mode: 0o700 });
  const temporary = `${record.requestFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ requestId, role, requestedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(temporary, record.requestFile);
  return requestId;
}
