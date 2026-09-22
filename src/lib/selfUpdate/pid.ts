/* A process named by the PID recorded when it was started, and by nothing
   else (#2007). `startIdentity` is field 22 of /proc/<pid>/stat (the start
   time in clock ticks), the same identity `bin/self-update-supervisor.mjs`
   records, so a PID reused after an exit never matches its record. */
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

export function readStartIdentity(pid: number): string | null {
  return statFields(pid)?.[19] ?? null;
}

/** Alive means present and not a zombie. */
export function isAlive(pid: number): boolean {
  const state = statFields(pid)?.[0];
  return state !== undefined && state !== "Z" && state !== "X";
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
