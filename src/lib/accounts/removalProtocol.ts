import type { AccountArchiveRemovalReport } from "./removal";

export const REMOVAL_RESULT_PREFIX = "DELEGATUS_ACCOUNT_REMOVAL_RESULT ";

/** Diagnostics may share stdout; exactly one marked result belongs to IPC. */
export function parseRemovalResult(output: string): {
  ok?: boolean;
  result?: AccountArchiveRemovalReport;
  error?: Record<string, unknown> & { message?: unknown };
} {
  const frames = output.split("\n").filter(line => line.startsWith(REMOVAL_RESULT_PREFIX));
  if (frames.length !== 1) throw new Error("account removal worker returned an invalid result");
  return JSON.parse(frames[0]!.slice(REMOVAL_RESULT_PREFIX.length));
}
