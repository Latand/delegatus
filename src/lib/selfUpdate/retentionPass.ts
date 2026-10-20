import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { spawnLeasedHelper, leasedHelperInput, endLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { retentionWorkerLaunch } from "./retentionWorker";
import type { LauncherRecord } from "./launcher";
import type { RetentionInputs, RetentionReport } from "./retention";

type Current = { record: LauncherRecord; inputs: RetentionInputs };
const validReport = (report: RetentionReport | undefined): report is RetentionReport => !!report
  && typeof report.at === "string" && Number.isFinite(Date.parse(report.at))
  && Number.isFinite(report.reclaimedCacheBytes) && report.reclaimedCacheBytes >= 0
  && Array.isArray(report.removed) && report.removed.every(row => typeof row.dir === "string" && typeof row.sha === "string" && Number.isFinite(row.bytes) && row.bytes >= 0)
  && Array.isArray(report.kept) && report.kept.every(row => typeof row.dir === "string" && typeof row.reason === "string" && Number.isFinite(row.bytes) && row.bytes >= 0)
  && Array.isArray(report.errors) && report.errors.every(error => typeof error === "string");
const scheduleDeadline = (expire: () => void, ms: number) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); };

/** The whole filesystem pass is off the Viewer loop, including Git status,
 * generated-tree inspection and trash snapshots. Each guard asks the owner
 * for its current safety inputs instead of replaying the initial snapshot. */
export async function runRetentionPass(record: LauncherRecord, inputs: RetentionInputs, options: {
  reportFile: string; env: Readonly<Record<string, string | undefined>>;
  current: () => Current | Promise<Current>;
  launch?: ReturnType<typeof retentionWorkerLaunch>; timeoutMs?: number; now?: number; signal?: AbortSignal;
  schedule?: typeof scheduleDeadline;
}): Promise<RetentionReport> {
  return withViewerOperation("self-update.retention", async () => {
    options.signal?.throwIfAborted();
    const launch = options.launch ?? retentionWorkerLaunch();
    const child: ChildProcess = spawnLeasedHelper("self-update.retention", {
      command: launch.executable, args: [launch.entry, ...(launch.args ?? []), "--retention-pass"], cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_OWNER: "tool" },
    }, undefined, { input: true, stdout: "pipe", stderr: "inherit" });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    let cancelDeadline: (() => void) | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<RetentionReport>((resolve, reject) => {
        let output = ""; let settled = false;
        const fail = (error: Error) => { if (settled) return; settled = true; reject(error); endLeasedHelper(child); };
        abort = () => fail(new Error("retention owner stopped"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        cancelDeadline = (options.schedule ?? scheduleDeadline)(() => fail(new Error("retention pass deadline")), options.timeoutMs ?? 120_000);
        child.once("error", fail);
        child.once("close", (code, signal) => fail(new Error(`retention pass exited before its report (${signal ?? code})`)));
        const input = leasedHelperInput(child);
        input.on("error", fail);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          if (settled) return;
          output += chunk;
          if (Buffer.byteLength(output) > 1024 * 1024) { fail(new Error("retention pass reply exceeded its bound")); return; }
          for (let end; (end = output.indexOf("\n")) !== -1;) {
            const line = output.slice(0, end); output = output.slice(end + 1);
            try {
              const message = JSON.parse(line);
              if (message.kind === "current" && Number.isSafeInteger(message.id)) {
                void Promise.resolve().then(options.current).then(current => {
                  if (!settled) input.write(JSON.stringify({ id: message.id, current }) + "\n");
                }, () => { if (!settled) input.write(JSON.stringify({ id: message.id, error: "retention owner unavailable" }) + "\n"); });
              } else if (message.kind === "report" && validReport(message.report)) {
                settled = true; resolve(message.report);
              } else throw new Error("invalid retention pass reply");
            } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
          }
        });
        input.write(JSON.stringify({ kind: "retain", record, inputs, reportFile: options.reportFile, now: options.now,
          env: { LLV_SELF_UPDATE_KEEP_RELEASES: options.env.LLV_SELF_UPDATE_KEEP_RELEASES } }) + "\n");
      });
    } finally {
      cancelDeadline?.();
      if (abort) options.signal?.removeEventListener("abort", abort);
      endLeasedHelper(child);
      await closed;
    }
  });
}

/** Only the leased retention entry calls this. No root observer reaches it. */
export async function serveRetentionPass(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const pending = new Map<number, { resolve: (value: Current) => void; reject: (error: Error) => void }>();
  let sequence = 0; let started = false;
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  await new Promise<void>((resolve, reject) => {
    lines.on("line", line => {
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("retention input exceeded its bound");
        const message = JSON.parse(line);
        if (message.kind === "retain" && !started) {
          started = true;
          // Retention's completion log belongs on stderr beside helper logs.
          console.log = console.error;
          void import("./retention").then(({ retainReleases }) => retainReleases(message.record, message.inputs, {
            reportFile: message.reportFile, env: message.env, now: message.now === undefined ? Date.now : () => message.now,
            current: () => new Promise<Current>((resolve, reject) => {
              const id = ++sequence; pending.set(id, { resolve, reject }); send({ kind: "current", id });
            }),
          })).then(report => { send({ kind: "report", report }); resolve(); }, reject);
        } else {
          const request = pending.get(message.id);
          if (!request) throw new Error("unknown retention safety reply");
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else if (message.current?.record && message.current?.inputs) request.resolve(message.current);
          else request.reject(new Error("invalid retention safety reply"));
        }
      } catch (error) { reject(error); }
    });
    lines.once("close", () => { for (const request of pending.values()) request.reject(new Error("retention owner disconnected")); reject(new Error("retention owner disconnected")); });
  });
  lines.close();
}
