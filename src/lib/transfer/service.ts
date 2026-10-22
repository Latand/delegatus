import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";

import { recoverTransferImports, type RecoveryOutcome } from "./importer";
import type { TransferImportRequest } from "./types";
import type { TransferWorkerRequest, TransferWorkerResponse } from "./workerProtocol";

/* The serving Viewer's side of the transfer (docs/design/install-memory-transfer.md
   §4.1): every step runs in a worker process of its own under a helper lease,
   attributed to a loop-monitor operation. The apply worker holds the account
   mutation lock, which spawn admission also takes, so no launch is admitted
   against a half-imported account set. A worker that dies mid-apply is recovered here
   at once: committed imports are finished, uncommitted ones restored. */

const WORKER_TIMEOUT_MS = 15 * 60_000;

export type WorkerLaunch = { executable: string; workerPath: string };

export function transferWorkerLaunch(cwd = process.cwd()): WorkerLaunch {
  const source = path.join(cwd, "src/lib/transfer/transfer.worker.ts");
  const bundled = path.join(cwd, ".next/server/transfer-worker.js");
  const bunContainer = "/usr/local/bin/bun-container";
  if (fs.existsSync(source) && fs.existsSync(bunContainer)) return { executable: bunContainer, workerPath: source };
  if (fs.existsSync(bundled)) return { executable: process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun"), workerPath: bundled };
  return { executable: process.execPath, workerPath: source };
}

export interface ServiceOptions {
  launch?: WorkerLaunch;
  timeoutMs?: number;
  /** Extra environment for the worker; the exit tests name a fault here. */
  env?: Record<string, string>;
}

async function runWorker(request: TransferWorkerRequest, options: ServiceOptions): Promise<{ response: TransferWorkerResponse | null; exit: string | null }> {
  const launch = options.launch ?? transferWorkerLaunch();
  const directory = stateDir();
  const { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } = await import("@/lib/helperLease");
  const child = spawnLeasedHelper("install-transfer", {
    command: launch.executable,
    args: [launch.workerPath],
    cwd: process.cwd(),
    env: { ...process.env, LLV_STATE_DIR: directory, ...options.env },
  }, directory, { input: true, stdout: "pipe", stderr: "inherit", followRelease: false });
  const input = leasedHelperInput(child);
  return new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;
    const timeout = setTimeout(() => { timedOut = true; endLeasedHelper(child); }, timeoutMs);
    timeout.unref?.();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { output += chunk; });
    input.on("error", () => { /* the exit below reports it */ });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return resolve({ response: null, exit: `ran past ${timeoutMs} ms and was stopped` });
      if (code !== 0) return resolve({ response: null, exit: `exited with ${code ?? signal}` });
      try { resolve({ response: JSON.parse(output.trim().split("\n").at(-1) ?? "") as TransferWorkerResponse, exit: null }); }
      catch { resolve({ response: null, exit: "answered nothing readable" }); }
    });
    input.end(JSON.stringify(request));
  });
}

function stopped(exit: string, recovered?: RecoveryOutcome[]): TransferWorkerResponse & { recovered?: RecoveryOutcome[] } {
  return { ok: false, error: { code: "worker_stopped", message: `the transfer worker ${exit}` }, ...(recovered ? { recovered } : {}) };
}

/** Write an uploaded or piped bundle where the worker can read it, owner-only. */
export function holdIncomingBundle(bytes: Uint8Array): string {
  const directory = path.join(stateDir(), "transfer", "incoming");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${crypto.randomUUID()}.dlgt`);
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  return file;
}

export async function exportBundle(sections: string[] | undefined, options: ServiceOptions = {}): Promise<{ response: TransferWorkerResponse; bytes: Buffer | null }> {
  return viewerLoopMonitor.run("transfer.export", async () => {
    const directory = path.join(stateDir(), "transfer", "outgoing");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const outFile = path.join(directory, `${crypto.randomUUID()}.dlgt`);
    try {
      const { response, exit } = await runWorker({ operation: "export", sections, outFile }, options);
      if (!response) return { response: stopped(exit!), bytes: null };
      return { response, bytes: response.ok ? fs.readFileSync(outFile) : null };
    } finally { fs.rmSync(outFile, { force: true }); }
  });
}

export async function previewBundle(bytes: Uint8Array, input: { mappings?: Record<string, string>; replace?: string[] }, options: ServiceOptions = {}): Promise<TransferWorkerResponse> {
  return viewerLoopMonitor.run("transfer.preview", async () => {
    const bundleFile = holdIncomingBundle(bytes);
    try {
      const { response, exit } = await runWorker({ operation: "preview", bundleFile, ...input }, options);
      return response ?? stopped(exit!);
    } finally { fs.rmSync(bundleFile, { force: true }); }
  });
}

let applying: Promise<unknown> | null = null;

export async function applyBundle(request: TransferImportRequest, options: ServiceOptions = {}): Promise<TransferWorkerResponse & { recovered?: RecoveryOutcome[] }> {
  if (applying) return { ok: false, error: { code: "busy", message: "another import is being applied; wait for its report" } };
  const run = viewerLoopMonitor.run("transfer.apply", async () => {
    const { response, exit } = await runWorker({ operation: "apply", request }, options);
    if (response) return response;
    /* The worker died between its checkpoint and its cleanup: settle it now
       rather than at the next activation. */
    return stopped(exit!, await viewerLoopMonitor.run("transfer.recover", () => recoverTransferImports()));
  });
  applying = run;
  try { return await run; }
  finally { applying = null; }
}

export async function importReport(importId: string | undefined, options: ServiceOptions = {}): Promise<TransferWorkerResponse> {
  const { response, exit } = await runWorker({ operation: "report", importId }, options);
  return response ?? stopped(exit!);
}
