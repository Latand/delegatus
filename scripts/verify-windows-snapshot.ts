import { setTimeout } from "node:timers/promises";

import { refreshWindowsSnapshot, windowsBackend, type WindowsSnapshotCommandResult } from "../src/lib/proc/windows";
import type { ProcSnapshotEntry } from "../src/lib/proc/types";

interface Attempt {
  command: WindowsSnapshotCommandResult;
  listed: ProcSnapshotEntry[];
}

function takeAttempt(timeoutMs: number): Attempt {
  const command = refreshWindowsSnapshot(timeoutMs);
  return { command, listed: windowsBackend.listProcesses() };
}

function failureReason(command: WindowsSnapshotCommandResult, count: number, timeoutMs: number): string {
  if (command.error?.startsWith("ETIMEDOUT:")) return `PowerShell snapshot timed out after ${timeoutMs} ms`;
  if (command.error) return `PowerShell could not run: ${command.error}`;
  if (command.signal) return `PowerShell was terminated by ${command.signal}`;
  if (command.status !== 0) return `PowerShell exited with status ${command.status}`;
  return count === 0 ? "PowerShell exited successfully; the parsed snapshot is empty" : `the parsed snapshot has only ${count} processes`;
}

/** Three fresh commands, each allowed 30 seconds for cold CIM startup, with
 * 750 ms total backoff (90.75 seconds of command budgets and waits). Failure evidence is JSON-escaped to preserve the raw strings
 * without letting a command line in the CSV act as a CI workflow command. */
export async function requireWindowsSnapshot({
  attempt = takeAttempt,
  sleep = (ms: number) => setTimeout(ms),
  log = (line: string) => console.log(line),
}: {
  attempt?: (timeoutMs: number) => Attempt;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
} = {}): Promise<ProcSnapshotEntry[]> {
  const timeoutMs = 30_000;
  const backoffs = [250, 500];
  for (let index = 0; ; index += 1) {
    const { command, listed } = attempt(timeoutMs);
    if (command.status === 0 && command.signal === null && command.error === null && listed.length >= 5) return listed;
    const reason = failureReason(command, listed.length, timeoutMs);
    log(`Win32_Process snapshot attempt ${index + 1}/3 failed: ${JSON.stringify({ reason, timeoutMs, ...command, processes: listed.length })}`);
    if (index === backoffs.length) {
      throw new Error(`the Win32_Process snapshot failed after 3 attempts: ${reason} (listed ${listed.length} processes; see command diagnostics above)`);
    }
    await sleep(backoffs[index]!);
  }
}
