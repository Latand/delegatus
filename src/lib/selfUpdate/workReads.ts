/* The synchronous reads of one observation, in a process of their own (#2594).

   `probeQuiet` opens with three synchronous reads: the registry health, the
   pipelines and the flows. Each is SQLite and JSON work that nothing can
   interrupt, and on the Viewer's thread no request is answered until it ends,
   however often the reading gives the event loop back around it. An
   observation therefore asks a worker for the three answers and hands them to
   the probe through its ports; the Viewer's thread only waits.

   This is for the display reading alone. A mutation reads the same three
   through the service's own ports, on the spot and afresh. */
import fs from "node:fs";
import path from "node:path";

import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { loadPipelinesForList, pipelineRegistryHealth } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import type { RegistryRecordIssue } from "@/lib/state/registryRecords";
import { STATE_OWNER_ENV } from "@/lib/stateOwnership";

/** How long the worker may take before it is stopped and the reading is unavailable. */
export const WORK_READS_TIMEOUT_MS = 30_000;

/** One read's answer, or the message of what it threw, and how long it took. */
export type WorkRead<T> = ({ value: T } | { error: string }) & { ms: number };

/** The three reads in the probe's order. The probe stops at the first that
    fails, and so does the worker: the ones after it are absent. */
export interface ObservedReads {
  registryHealth: WorkRead<RegistryRecordIssue[]>;
  pipelines?: WorkRead<readonly Pipeline[]>;
  flows?: WorkRead<readonly Flow[]>;
}

function read<T>(load: () => T): WorkRead<T> {
  const started = performance.now();
  try {
    const value = load();
    return { value, ms: performance.now() - started };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: performance.now() - started };
  }
}

/** The worker's side: the production readers, as the Viewer's own ports name them. */
export function answerWorkReads(): ObservedReads {
  const registryHealth = read(pipelineRegistryHealth);
  if ("error" in registryHealth) return { registryHealth };
  const pipelines = read(loadPipelinesForList);
  if ("error" in pipelines) return { registryHealth, pipelines };
  return { registryHealth, pipelines, flows: read(() => loadFlows()) };
}

export interface WorkReadsLaunch { executable: string; workerPath: string; args?: readonly string[] }

export function workReadsWorkerLaunch(cwd = process.cwd()): WorkReadsLaunch {
  const source = path.join(cwd, "src/lib/selfUpdateWork.worker.ts");
  const bundled = path.join(cwd, ".next/server/self-update-work-worker.js");
  const bunContainer = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(bunContainer)) return { executable: bunContainer, workerPath: source };
  if (fs.existsSync(bundled)) {
    return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: bundled };
  }
  return { executable: process.execPath, workerPath: source };
}

function isRead(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.ms === "number" && (typeof record.error === "string" || Array.isArray(record.value));
}

function parseReads(output: string): ObservedReads {
  const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "") as Partial<ObservedReads> | null;
  if (!parsed || !isRead(parsed.registryHealth)
    || (parsed.pipelines !== undefined && !isRead(parsed.pipelines)) || (parsed.flows !== undefined && !isRead(parsed.flows))) {
    throw new Error("the work reads worker answered something else than its reads");
  }
  return parsed as ObservedReads;
}

/**
 * The three reads from a worker process. Rejects when the worker cannot be
 * started, exits badly, answers something unreadable or runs past the bound;
 * the reading is then unavailable with that reason.
 *
 * The worker reads the state the Viewer already migrated and never migrates
 * it itself, so it does not inherit an owner that holds the release fence.
 */
export async function readWorkOffThread(options: { launch?: WorkReadsLaunch; timeoutMs?: number } = {}): Promise<ObservedReads> {
  const launch = options.launch ?? workReadsWorkerLaunch();
  const timeoutMs = options.timeoutMs ?? WORK_READS_TIMEOUT_MS;
  const { spawn } = await import("node:child_process");
  const child = spawn(launch.executable, [launch.workerPath, ...(launch.args ?? [])], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...(process.env[STATE_OWNER_ENV] ? { [STATE_OWNER_ENV]: "tool" } : {}) },
  });
  return new Promise<ObservedReads>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the work reads worker ran past ${timeoutMs} ms and was stopped`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`the work reads worker exited with ${code ?? signal}`);
        resolve(parseReads(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}
