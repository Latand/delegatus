import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/** fd 3 belongs only to this shell. The marker is emitted after setup, just
 * before exec, and is closed before the command can inherit it. Older shells
 * without EPOCHREALTIME leave execution time unknown. */
export function timedCommand(command: string[], setup = ""): string[] {
  return ["/bin/bash", "-c", `${setup}printf '%s\\n' "$EPOCHREALTIME" >&3; exec 3>&-; exec "$@"`, "owned-command", ...command];
}

export function observeCommandExecution(child: ChildProcess) {
  let marker = "", endedAt: number | undefined;
  const stream = child.stdio[3] as Readable | null;
  const drained = new Promise<void>(resolve => {
    if (!stream) resolve();
    else { stream.once("close", resolve); stream.once("error", () => resolve()); }
  });
  stream?.on("data", (chunk: Buffer) => { if (marker.length < 128) marker += chunk.toString().slice(0, 129 - marker.length); });
  child.once("exit", () => { endedAt = Date.now(); });
  return async () => {
    if (endedAt === undefined) return {};
    await drained;
    const startedAt = /^\d+\.\d+\n$/.test(marker) ? Math.floor(Number(marker.trim()) * 1000) : undefined;
    return startedAt !== undefined && endedAt !== undefined && startedAt <= endedAt
      ? { executionStartedAt: startedAt, executionEndedAt: endedAt } : {};
  };
}
