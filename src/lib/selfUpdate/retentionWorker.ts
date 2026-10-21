import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnLeasedHelper, leasedHelperInput, endLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { validRetentionScan, type RetentionScan } from "./retentionInspection";

export interface RetentionInspection {
  scan(directory: string): Promise<RetentionScan>;
  bytes(directory: string): Promise<number>;
  close(): Promise<void>;
}
export class RetentionInspectionError extends Error {}
export type RetentionLaunch = { executable: string; entry: string; args?: string[] };
export function retentionWorkerLaunch(cwd = process.cwd()): RetentionLaunch {
  const source = path.join(cwd, "src/lib/retention.worker.ts");
  const bundle = path.join(cwd, ".next/server/retention-worker.js");
  const container = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(container)) return { executable: container, entry: source };
  if (fs.existsSync(bundle)) return { executable: process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun", entry: bundle };
  return { executable: process.execPath, entry: source };
}

/** One pass owns one leased helper and one outstanding bounded request. Closing
 * waits for the recorded guardian and its contained children, including on failure. */
export class RetentionWorker implements RetentionInspection {
  private child?: ChildProcess;
  private closed: Promise<void> = Promise.resolve();
  private pending?: { kind: "scan" | "bytes"; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private output = "";
  private failure?: Error;
  constructor(private readonly launch = retentionWorkerLaunch(), private readonly timeoutMs = 60_000) {}
  private fail(error: Error) {
    this.failure ??= new RetentionInspectionError(error.message);
    if (this.child) endLeasedHelper(this.child);
  }
  private start() {
    const child = this.child = spawnLeasedHelper("self-update.retention", {
      command: this.launch.executable, args: [this.launch.entry, ...(this.launch.args ?? [])], cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_OWNER: "tool" },
    }, undefined, { input: true, stdout: "pipe", stderr: "inherit" });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (this.failure) return;
      this.output += chunk;
      if (Buffer.byteLength(this.output) > 1024 * 1024) { this.fail(new Error("retention helper reply exceeded its bound")); return; }
      if (!this.output.includes("\n")) return;
      try {
        const value = JSON.parse(this.output);
        const pending = this.pending;
        if (!pending || value.error || value.kind !== pending.kind) throw new Error(value.error || "invalid retention helper reply");
        const result = value.result;
        const valid = pending.kind === "bytes" ? Number.isSafeInteger(result) && result >= 0
          : validRetentionScan(result);
        if (!valid) throw new Error("partial or invalid retention helper reply");
        clearTimeout(pending.timer); this.pending = undefined; this.output = "";
        pending.resolve(result);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.once("error", error => this.fail(error));
    leasedHelperInput(child).on("error", error => this.fail(error));
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      this.child = undefined;
      this.failure ??= new RetentionInspectionError(`retention helper exited with ${code ?? signal}`);
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = undefined; }
      resolve();
    }));
  }
  private async request(kind: "scan" | "bytes", directory: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.pending) throw new RetentionInspectionError("overlapping retention inspections");
    return withViewerOperation("self-update.retention", () => new Promise((resolve, reject) => {
      try {
        if (!this.child) this.start();
        const timer = setTimeout(() => this.fail(new Error("retention helper deadline")), this.timeoutMs);
        this.pending = { kind, resolve, reject, timer };
        leasedHelperInput(this.child!).write(JSON.stringify({ kind, directory }) + "\n");
      } catch (error) { reject(new RetentionInspectionError(String(error))); }
    }));
  }
  scan(directory: string) { return this.request("scan", directory) as Promise<RetentionScan>; }
  bytes(directory: string) { return performanceSpans.wait("self-update.bytes", () => this.request("bytes", directory) as Promise<number>); }
  async close() { this.fail(new Error("retention helper closed")); await this.closed; }
}
