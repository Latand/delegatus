/* A process named by the PID recorded when it was started, and by nothing
   else (#2007). `startIdentity` is field 22 of /proc/<pid>/stat (the start
   time in clock ticks), the same identity `bin/self-update-supervisor.mjs`
   records, so a PID reused after an exit never matches its record. */
import { procBackend } from "@/lib/proc";
import { spawnSync } from "node:child_process";
import { windowsStartIdentity } from "../../../bin/windows-process-identity.mjs";
import { readFileSync } from "node:fs";

export interface RecordedPid { pid: number; startIdentity: string }

function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    /* The command name may hold spaces and parentheses; fields resume after the last ")". */
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

export function readStartIdentity(pid: number, platform: NodeJS.Platform = process.platform, run: typeof spawnSync = spawnSync): string | null {
  if (platform === "win32") return windowsStartIdentity(pid, run);
  const identity = statFields(pid)?.[19];
  if (identity) return identity;
  if (platform === "darwin") {
    const result = run("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
    return result.status === 0 && result.stdout.trim() ? `ps:${result.stdout.trim()}` : null;
  }
  return null;
}

/** Alive means present and not a zombie. */
export function isAlive(pid: number): boolean {
  const state = statFields(pid)?.[0];
  if (state !== undefined) return state !== "Z" && state !== "X";
  if (process.platform !== "linux") { try { process.kill(pid, 0); return true; } catch { return false; } }
  return false;
}

export function sameProcess(record: RecordedPid): boolean {
  return isAlive(record.pid) && readStartIdentity(record.pid) === record.startIdentity;
}

/** Signals the process group a recorded PID leads, after checking once more
    that the PID is still the process that was recorded. */
export function signalGroup(record: RecordedPid, signal: NodeJS.Signals): boolean {
  if (!sameProcess(record)) return false;
  try {
    process.kill(-record.pid, signal);
    return true;
  } catch {
    try { process.kill(record.pid, signal); return true; } catch { return false; }
  }
}


/** The launcher records its own start identity and the host answers in the
    process backend's. The recorded process must be alive, and the answer must
    be the identity this side reads for the recorded PID. */
export function runtimeHostMatches(record: { pid: number | null; startIdentity: string | null },
  health: { pid: number; startIdentity?: string | null } | null, alive: (pid: number, identity: string) => boolean,
  identity: (pid: number) => string | null): boolean {
  if (!health || record.pid === null || record.startIdentity === null || health.pid !== record.pid
    || !health.startIdentity || !alive(record.pid, record.startIdentity)) return false;
  return health.startIdentity === identity(record.pid);
}
