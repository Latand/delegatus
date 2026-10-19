import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { spawnLeasedHelper, leasedHelperInput, endLeasedHelper } from "@/lib/helperLease";
import { withViewerOperation, viewerLoopMonitor, type ViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import type { ImportRecord, ImportRequest } from "./importTypes";
import { validateImportId } from "./importTypes";

const host = globalThis as typeof globalThis & { __delegatusMemoryImport?: { directory: string; id: string; done: Promise<ImportRecord> } };
const phases = { backup: "memory.import.backup", candidates: "memory.import.candidates", retention: "memory.import.retention" } as const satisfies Record<string, ViewerOperation>;
const exists = async (file: string) => fs.access(file).then(() => true, () => false);

export async function memoryImportLaunch(cwd = process.cwd()) {
  const source = path.join(cwd, "src/lib/memoryImport.worker.ts");
  const container = "/usr/local/bin/bun-container";
  return { executable: await exists(container) ? container : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun",
    entry: await exists(source) ? source : path.join(cwd, ".next/server/memory-import-worker.js") };
}

/** Explicit background operation for slice 3. No request handler starts an
 * import in slice 2. The shared owner admits one job, sends only a small
 * request and receives counts; candidate text never crosses this pipe. */
export function runMemoryImport(request: ImportRequest, ports: { observeOperation?: (operation: ViewerOperation, current: ViewerOperation | undefined) => void | Promise<void> } = {}): Promise<ImportRecord> {
  validateImportId(request.importId);
  const directory = stateDir(), active = host.__delegatusMemoryImport;
  if (active) return active.directory === directory && active.id === request.importId ? active.done : Promise.reject(Error("memory import already running"));
  const frame = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(frame) > 64 * 1024) return Promise.reject(Error("memory import request exceeds its bound"));
  const done = withViewerOperation("memory.import", () => performanceSpans.wait("memory.import", async () => {
    await ports.observeOperation?.("memory.import", viewerLoopMonitor.current());
    const launch = await memoryImportLaunch();
    return await new Promise<ImportRecord>((resolve, reject) => {
      const child = spawnLeasedHelper("memory.import", { command: launch.executable, args: [launch.entry], cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: directory, LLV_STATE_OWNER: "viewer" } }, directory, { input: true, stdout: "pipe", stderr: "ignore" });
      let output = "", result: ImportRecord | undefined, failure: Error | undefined;
      let endPhase: (() => void) | undefined;
      const fail = (error: Error) => { failure ??= error; endLeasedHelper(child); };
      const timer = setTimeout(() => fail(Error("memory import helper deadline; reconcile the import record before retrying")), 5 * 60_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (failure) return;
        output += chunk;
        if (Buffer.byteLength(output) > 16 * 1024) { fail(Error("memory import helper reply exceeds its bound")); return; }
        for (;;) {
          const end = output.indexOf("\n");
          if (end < 0) break;
          const line = output.slice(0, end); output = output.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.phase && Object.hasOwn(phases, value.phase)) {
              endPhase?.();
              const phaseComplete = new Promise<void>(settle => { endPhase = settle; });
              void withViewerOperation(phases[value.phase as keyof typeof phases], async () => {
                await ports.observeOperation?.(phases[value.phase as keyof typeof phases], viewerLoopMonitor.current());
                await phaseComplete;
              });
            } else if (value.recovery && value.error === "failed" && ["integrity", "backup_refused", "source_changed", "interrupted", "failed"].includes(value.recovery.reason)
              && typeof value.recovery.statusPersistenceFailed === "boolean" && typeof value.recovery.sourceRestorationFailed === "boolean") {
              const { reason, statusPersistenceFailed, sourceRestorationFailed } = value.recovery;
              fail(Error(`memory import: ${reason};${statusPersistenceFailed ? " status persistence failed;" : ""}${sourceRestorationFailed ? " memory source restoration failed" : ""}`));
            } else if (value.result?.id === request.importId && value.result.state === "ready" && Number.isSafeInteger(value.result.parts)) result = value.result;
            else if (["integrity", "backup_refused", "source_changed", "interrupted", "failed"].includes(value.error)) fail(Error(`memory import: ${value.error}`));
            else throw Error("memory import helper refused");
          } catch { fail(Error("memory import helper refused")); }
        }
      });
      child.once("error", () => fail(Error("could not start memory import helper")));
      const input = leasedHelperInput(child);
      input.on("error", () => fail(Error("memory import helper input closed")));
      input.end(frame);
      child.once("close", code => {
        clearTimeout(timer); endPhase?.();
        if (failure) reject(failure);
        else if (code !== 0 || !result || output) reject(Error("memory import failed; read its private status record"));
        else resolve(result);
      });
    });
  })).finally(() => { if (host.__delegatusMemoryImport?.done === done) host.__delegatusMemoryImport = undefined; });
  host.__delegatusMemoryImport = { directory, id: request.importId, done };
  return done;
}
