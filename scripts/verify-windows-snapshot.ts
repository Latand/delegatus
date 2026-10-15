import { setTimeout } from "node:timers/promises";

import { refreshWindowsSnapshot, windowsBackend, type WindowsSnapshotCommandResult } from "../src/lib/proc/windows";
import type { ProcSnapshotEntry } from "../src/lib/proc/types";

interface Attempt {
  command: WindowsSnapshotCommandResult;
  listed: ProcSnapshotEntry[];
}

function takeAttempt(): Attempt {
  const command = refreshWindowsSnapshot();
  return { command, listed: windowsBackend.listProcesses() };
}

/** Three fresh commands, each capped at 15 seconds by the backend, with 750 ms
 * total backoff. Failure evidence is JSON-escaped to preserve the raw strings
 * without letting a command line in the CSV act as a CI workflow command. */
export async function requireWindowsSnapshot({
  attempt = takeAttempt,
  sleep = (ms: number) => setTimeout(ms),
  log = (line: string) => console.log(line),
}: {
  attempt?: () => Attempt;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
} = {}): Promise<ProcSnapshotEntry[]> {
  const backoffs = [250, 500];
  for (let index = 0; ; index += 1) {
    const { command, listed } = attempt();
    if (command.status === 0 && command.signal === null && command.error === null && listed.length >= 5) return listed;
    log(`Win32_Process snapshot attempt ${index + 1}/3 failed: ${JSON.stringify({ ...command, processes: listed.length })}`);
    if (index === backoffs.length) {
      throw new Error(`the Win32_Process snapshot listed ${listed.length} processes after 3 attempts; PowerShell or the CSV parse is broken (see command diagnostics above)`);
    }
    await sleep(backoffs[index]!);
  }
}
