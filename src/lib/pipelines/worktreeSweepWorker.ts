import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper, unrefLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import type { WorktreeSweepMode, WorktreeSweepReport } from "./worktreeSweep";

export const WORKTREE_SWEEP_DEADLINE_MS = 45 * 60_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
export type SweepWorkerLaunch = { executable: string; entry: string; args?: string[] };
export function worktreeSweepWorkerLaunch(cwd = process.cwd()): SweepWorkerLaunch {
  const source = path.join(cwd, "src/lib/worktreeSweep.worker.ts");
  const bundle = path.join(cwd, ".next/server/worktree-sweep-worker.js");
  const container = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(container)) return { executable: container, entry: source };
  if (fs.existsSync(bundle)) return { executable: process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun", entry: bundle };
  return { executable: process.execPath, entry: source };
}

type Pending = { resolve: (report: WorktreeSweepReport) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>; failure?: Error };
/** The leased child keeps directory observers between passes. No filesystem
 * inspections, registry snapshots or report writes run on the Viewer loop.
 * The guardian contains its Git/namespace children on owner loss or deadline.
 */
export class WorktreeSweepWorker {
  private child?: ChildProcess;
  private pending?: Pending;
  private output = "";
  private replyBytes = 0;
  private closed: Promise<void> = Promise.resolve();
  constructor(private readonly launch = worktreeSweepWorkerLaunch(), private readonly timeoutMs = WORKTREE_SWEEP_DEADLINE_MS) {}

  private start() {
    const child = this.child = spawnLeasedHelper("worktree-sweep", {
      command: this.launch.executable, args: [this.launch.entry, ...(this.launch.args ?? [])], cwd: process.cwd(),
      // Read state already migrated by the serving Viewer. No startup authority.
      env: { ...process.env, LLV_STATE_OWNER: "tool" },
    }, undefined, { input: true, stdout: "pipe", stderr: "inherit" });
    this.output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (!this.pending) { this.fail(new Error("worktree sweep worker answered without a request")); return; }
      this.replyBytes += Buffer.byteLength(chunk);
      if (this.replyBytes > MAX_REPLY_BYTES) { this.fail(new Error("worktree sweep worker reply exceeded its bound")); return; }
      this.output += chunk;
      const newline = this.output.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(this.output.slice(0, newline));
        this.output = this.output.slice(newline + 1);
        if (!response || response.error || !response.report || !Array.isArray(response.report.kept)
          || !Array.isArray(response.report.removed) || !Array.isArray(response.report.errors))
          throw new Error(response?.error || "worktree sweep worker returned an invalid report");
        if (this.pending.failure) return;
        const pending = this.pending;
        clearTimeout(pending.timer);
        this.pending = undefined;
        unrefLeasedHelper(child);
        pending.resolve(response.report);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    leasedHelperInput(child).on("error", error => this.fail(error));
    child.once("error", error => this.fail(error));
    this.closed = new Promise<void>(resolve => child.once("close", (code, signal) => {
      if (this.child === child) this.child = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(pending.failure ?? new Error(`worktree sweep worker exited with ${code ?? signal}`));
      }
      resolve();
    }));
  }

  private fail(error: Error) {
    if (this.pending) this.pending.failure ??= error;
    if (this.child) endLeasedHelper(this.child);
  }

  run(mode: WorktreeSweepMode): Promise<WorktreeSweepReport> {
    if (this.pending) return Promise.reject(new Error("worktree sweep is already running"));
    return withViewerOperation("worktrees.sweep", () => new Promise<WorktreeSweepReport>((resolve, reject) => {
      if (!this.child) this.start();
      const child = this.child!;
      child.ref();
      for (const stream of child.stdio) (stream as unknown as { ref?: () => void } | null)?.ref?.();
      this.replyBytes = 0;
      const timer = setTimeout(() => this.fail(new Error(`worktree sweep exceeded ${this.timeoutMs} ms`)), this.timeoutMs);
      this.pending = { resolve, reject, timer };
      leasedHelperInput(child).write(JSON.stringify({ mode }) + "\n");
    }));
  }

  async close() {
    if (this.child) this.fail(new Error("worktree sweep worker stopped"));
    await this.closed;
  }
}

const shared = globalThis as typeof globalThis & { __delegatusWorktreeSweepWorker?: WorktreeSweepWorker };
export function runWorktreeSweepOffThread(mode: WorktreeSweepMode) {
  return (shared.__delegatusWorktreeSweepWorker ??= new WorktreeSweepWorker()).run(mode);
}
export async function stopWorktreeSweepWorker() {
  const worker = shared.__delegatusWorktreeSweepWorker;
  shared.__delegatusWorktreeSweepWorker = undefined;
  await worker?.close();
}
