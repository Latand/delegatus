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
   attributed to a loop-monitor operation. For an apply the Viewer takes the
   account mutation lock, which spawn admission also takes, and lends that
   hold to its worker; it keeps the hold until the import is settled, so no
   launch is admitted against a half-imported account set, not even in the
   moment after a worker dies. A worker that dies mid-apply is recovered here
   at once: committed imports are finished, uncommitted ones restored. A
   recovery that fails keeps the hold and is tried again until it settles;
   launches and further imports wait meanwhile. */

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
  /** The recovery the Viewer runs after a failed apply; tests inject account deps. */
  recover?: () => Promise<RecoveryOutcome[]>;
  /** Waits between attempts of a recovery that failed; the last repeats. */
  recoveryRetryMs?: readonly number[];
}

const RECOVERY_RETRY_MS = [5_000, 30_000, 120_000, 600_000] as const;

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

type ApplyAnswer = TransferWorkerResponse & { recovered?: RecoveryOutcome[] };

/** The apply in progress, with the recovery after it: set until both settled. */
let applying: Promise<unknown> | null = null;

export async function applyBundle(request: TransferImportRequest, options: ServiceOptions = {}): Promise<ApplyAnswer> {
  if (applying) return { ok: false, error: { code: "busy", message: "another import is being applied or undone; wait for its report" } };
  /* Answered once the hold is given back, or earlier when an undo fails and
     the hold stays for its retries. */
  let answer!: (value: ApplyAnswer) => void;
  const answered = new Promise<ApplyAnswer>(resolve => { answer = resolve; });
  const { withAccountMutationLeaseAsync } = await import("@/lib/accounts/accountMutation");
  const run = viewerLoopMonitor.run("transfer.apply", () => withAccountMutationLeaseAsync(async (lease): Promise<ApplyAnswer> => {
    const { response, exit } = await runWorker({ operation: "apply", request, lease }, options);
    if (response?.ok) return response;
    /* Whatever stopped the apply — the worker's death, or an error it
       answered with after its commit — is settled now, still under the hold
       spawn admission waits on: uncommitted writes undone, committed work finished. */
    return settleUnderHold(response ?? stopped(exit!), answer, options);
  }, { holder: "install transfer" }));
  applying = run;
  void run.then(
    final => { applying = null; answer(final); },
    (error: unknown) => { applying = null; answer({ ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } }); },
  );
  return answered;
}

/** Recovery under the hold the apply took, tried until it settles. A failed
    attempt answers the caller at once with `recovery_pending`, and the hold
    stays, so launches and further imports keep waiting. */
async function settleUnderHold(failed: TransferWorkerResponse, early: (value: ApplyAnswer) => void, options: ServiceOptions): Promise<ApplyAnswer> {
  const waits = options.recoveryRetryMs?.length ? options.recoveryRetryMs : RECOVERY_RETRY_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const recovered = await viewerLoopMonitor.run("transfer.recover", () => (options.recover ?? (() => recoverTransferImports()))());
      return { ...failed, recovered };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      console.error(`[transfer] the interrupted import could not be undone yet (attempt ${attempt + 1}); launches wait until it is: ${cause}`);
      early({ ok: false, error: { code: "recovery_pending", message: `${failed.ok ? "the import" : failed.error.message}; undoing it failed (${cause}) and is retried, and no launch is admitted until it settles` } });
      await new Promise(resolve => setTimeout(resolve, waits[Math.min(attempt, waits.length - 1)]));
    }
  }
}

export async function importReport(importId: string | undefined, options: ServiceOptions = {}): Promise<TransferWorkerResponse> {
  const { response, exit } = await runWorker({ operation: "report", importId }, options);
  return response ?? stopped(exit!);
}
