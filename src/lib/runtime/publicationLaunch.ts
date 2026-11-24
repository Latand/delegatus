import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureProcessIdentity, type ProcessIdentity } from "../processIdentity";
import { cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CPU_QUEUE_UNPOLLED_MS,
  PUBLICATION_LAUNCH_PROOF_ENV, publicationLaunchDigest } from "./cpuAdmission";
import { cpuOwnerExited, cpuOwnerStatus } from "./signalSandboxContext";

/** How long a launch record waits for the queue's SQLite writer. */
const LAUNCH_RECORD_LOCK_MS = 10_000;

export type PublicationPreparerStamp = {
  /** Settles once the record is written or abandoned; never rejects. */
  recorded: Promise<void>;
  /** Stops a pending record and removes a written one after the preparer has
   * ended. It never waits for a busy queue writer. Never rejects. */
  release(): Promise<void>;
};

/** A fresh secret for one preparer launch. The Viewer hands it to the process
 * it spawns in `PUBLICATION_LAUNCH_PROOF_ENV`; the queue keeps its digest. */
export function newPublicationLaunchProof(): string {
  return randomBytes(32).toString("base64url");
}

/** The queue file the preparer's own gate helpers open. They resolve
 * LLV_GATE_LOCK_DIR against their working directory, the directory the
 * preparer starts in (scripts/cpu-admission.ts), so a relative value is
 * resolved against that directory here too. */
export function publicationLaunchQueueFile(env: Readonly<Partial<NodeJS.ProcessEnv>>, cwd: string): string {
  if (!env.LLV_GATE_LOCK_DIR) return cpuAdmissionFile();
  const directory = path.resolve(cwd, env.LLV_GATE_LOCK_DIR);
  let canonical = directory;
  try { canonical = fs.realpathSync(directory); } catch { /* the gate creates it on first use */ }
  return path.join(canonical, "admission.sqlite");
}

const busy = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)*$/.test(code);
};

/** Opens the queue without a synchronous busy wait and retries a locked writer
 * asynchronously under one monotonic deadline, while `proceed` holds. Returns
 * whether the operation ran. */
async function withLaunchQueue(file: string, lockMs: number, operation: (queue: CpuAdmissionQueue) => void,
  proceed: () => boolean, onWait: (wake: () => void) => void = () => {}): Promise<boolean> {
  const deadline = performance.now() + lockMs;
  let delay = 20;
  for (;;) {
    if (!proceed()) return false;
    let queue: CpuAdmissionQueue | undefined;
    try {
      queue = new CpuAdmissionQueue(file, Date.now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS,
        { status: cpuOwnerStatus, exited: cpuOwnerExited }, 0);
      operation(queue);
      return true;
    } catch (error) {
      if (!busy(error) || performance.now() >= deadline) throw error;
    } finally { queue?.close(); }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, Math.min(delay, deadline - performance.now())));
      onWait(() => { clearTimeout(timer); resolve(); });
    });
    delay = Math.min(delay * 2, 250);
  }
}

const failureClass = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : "error";
};

/**
 * Records a publication preparer the Viewer has just spawned in `cwd` with
 * `env`, so the machine's CPU queue can recognise its cleanup runner as
 * unadmitted whatever version of scripts/local-gate.ts the lane's checkout
 * carries. The launch execs in place (systemd-run --scope, the Bun shims), so
 * the spawned PID and kernel start time are the preparer's own, and the proof
 * in `env` is in its exec environment. Without a proof nothing is recorded.
 */
export function stampPublicationPreparer(pid: number, operation: string | undefined, env: Readonly<Partial<NodeJS.ProcessEnv>>,
  cwd: string, lockMs = LAUNCH_RECORD_LOCK_MS): PublicationPreparerStamp {
  const proof = env[PUBLICATION_LAUNCH_PROOF_ENV];
  // Only the Linux classifier distinguishes legacy holders.
  if (process.platform !== "linux" || !operation || !proof) return { recorded: Promise.resolve(), release: () => Promise.resolve() };
  let identity: ProcessIdentity | undefined;
  let file: string | undefined;
  let released = false;
  let wake: (() => void) | undefined;
  const recorded = (async () => {
    file = publicationLaunchQueueFile(env, cwd);
    const captured = captureProcessIdentity(pid);
    // A child that already ended has nothing left to recognise.
    if (!captured.startIdentity || !captured.bootEpoch) return;
    // A busy writer is retried only while the preparer can still use the record.
    const wanted = () => !released && cpuOwnerStatus(captured) !== "dead";
    if (await withLaunchQueue(file, lockMs, queue => queue.recordPublicationLaunch(captured, operation, publicationLaunchDigest(proof)),
      wanted, next => { wake = next; })) identity = captured;
  })().catch(error => { console.warn(`[publication-launch] the preparer launch was not recorded (${failureClass(error)})`); });
  return {
    recorded,
    release: async () => {
      released = true;
      wake?.();
      await recorded;
      if (!identity || !file) return;
      const ended = identity;
      identity = undefined;
      // The preparer has ended, so its row can no longer match a live process
      // and the next record prunes it. One attempt, without waiting.
      try { await withLaunchQueue(file, 0, queue => queue.forgetPublicationLaunch(ended), () => true); }
      catch (error) { console.warn(`[publication-launch] the preparer launch record was kept (${failureClass(error)})`); }
    },
  };
}
