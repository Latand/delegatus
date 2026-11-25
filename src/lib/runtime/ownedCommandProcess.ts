import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { Readable } from "node:stream";

/** Shell status of a command: its exit code, or 128+N for signal N. A
 * signal without a number (a handle that never reported) keeps `unknown`. */
export function commandStatus(code: number | null, signal: string | null, unknown = 137): number {
  if (code !== null) return code;
  const named = signal ? (os.constants.signals as Record<string, number | undefined>)[signal] : undefined;
  const numbered = signal ? /^SIG(\d+)$/.exec(signal)?.[1] : undefined;
  return named ? 128 + named : numbered ? 128 + Number(numbered) : unknown;
}

/** Bun's node:child_process reports neither an exit code nor a signal for a
 * signal it has no name for (Linux real-time signals, 34 and above), so a
 * supervisor read it as SIGKILL. Bun.spawn's exit status keeps 128+N; an
 * unnamed signal is reported as `SIG<N>`. The returned handle implements the
 * ChildProcess surface the owned supervisors use: pid, exitCode, signalCode,
 * stdio[3] as a readable stream, kill, and the error, exit and close events. */
export function spawnOwnedCommand(argv: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; marker: boolean }): ChildProcess {
  const handle = new EventEmitter() as EventEmitter & {
    pid?: number; exitCode: number | null; signalCode: string | null; killed: boolean;
    stdio: (Readable | null)[]; kill(signal?: NodeJS.Signals | number): boolean;
  };
  Object.assign(handle, { exitCode: null, signalCode: null, killed: false, stdio: [null, null, null] });
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(argv, { cwd: options.cwd, env, stdio: options.marker ? ["inherit", "inherit", "inherit", "pipe"] : ["inherit", "inherit", "inherit"] });
  } catch (error) {
    handle.kill = () => false;
    process.nextTick(() => handle.emit("error", error));
    return handle as unknown as ChildProcess;
  }
  handle.pid = proc.pid;
  const fd = options.marker ? (proc.stdio as unknown[])[3] : undefined;
  const marker = typeof fd === "number" ? Readable.fromWeb(Bun.file(fd).stream() as never) : null;
  if (marker) handle.stdio[3] = marker;
  handle.kill = signal => {
    if (handle.exitCode !== null || handle.signalCode !== null) return false;
    proc.kill(signal); handle.killed = true; return true;
  };
  const drained = marker ? new Promise<void>(resolve => { marker.once("close", resolve); marker.once("error", () => resolve()); }) : Promise.resolve();
  void proc.exited.then(async status => {
    handle.exitCode = proc.exitCode;
    handle.signalCode = proc.signalCode ?? (proc.exitCode === null && status > 128 ? `SIG${status - 128}` : null);
    handle.emit("exit", handle.exitCode, handle.signalCode);
    await drained;
    handle.emit("close", handle.exitCode, handle.signalCode);
  });
  return handle as unknown as ChildProcess;
}
