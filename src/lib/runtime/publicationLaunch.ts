import path from "node:path";
import { captureProcessIdentity, type ProcessIdentity } from "../processIdentity";
import { cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS, CPU_QUEUE_UNPOLLED_MS } from "./cpuAdmission";
import { cpuOwnerExited, cpuOwnerStatus } from "./signalSandboxContext";

/** How long a launch record waits for the queue's SQLite writer. */
const LAUNCH_RECORD_LOCK_MS = 10_000;

export type PublicationPreparerStamp = {
  /** Settles once the record is written or abandoned; never rejects. */
  recorded: Promise<void>;
  /** Removes the record after the preparer has ended. Never rejects. */
  release(): Promise<void>;
};

/** The queue file the preparer's own gate helpers open. They resolve it from
 * the environment the Viewer hands them (scripts/cpu-admission.ts). */
function launchQueueFile(env: Readonly<Partial<NodeJS.ProcessEnv>>): string {
  return env.LLV_GATE_LOCK_DIR ? path.join(env.LLV_GATE_LOCK_DIR, "admission.sqlite") : cpuAdmissionFile();
}

/** Opens the queue without a synchronous busy wait and retries a locked writer
 * asynchronously under one deadline. */
async function withLaunchQueue(file: string, lockMs: number, operation: (queue: CpuAdmissionQueue) => void): Promise<void> {
  const deadline = Date.now() + lockMs;
  let delay = 20;
  for (;;) {
    let queue: CpuAdmissionQueue | undefined;
    try {
      queue = new CpuAdmissionQueue(file, Date.now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS,
        { status: cpuOwnerStatus, exited: cpuOwnerExited }, 0);
      operation(queue);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !/^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)*$/.test(code) || Date.now() >= deadline) throw error;
    } finally { queue?.close(); }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(delay, deadline - Date.now()))));
    delay = Math.min(delay * 2, 250);
  }
}

const failureClass = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : "error";
};

/**
 * Records a publication preparer the Viewer has just spawned, so the machine's
 * CPU queue can recognise its cleanup runner as unadmitted whatever version
 * of scripts/local-gate.ts the lane's checkout carries. The launch execs in
 * place (systemd-run --scope, the Bun shims), so the spawned PID and kernel
 * start time are the preparer's own.
 */
export function stampPublicationPreparer(pid: number, operation: string | undefined, env: Readonly<Partial<NodeJS.ProcessEnv>>,
  lockMs = LAUNCH_RECORD_LOCK_MS): PublicationPreparerStamp {
  // Only the Linux classifier distinguishes legacy holders.
  if (process.platform !== "linux" || !operation) return { recorded: Promise.resolve(), release: () => Promise.resolve() };
  let identity: ProcessIdentity | undefined;
  let file: string | undefined;
  const recorded = (async () => {
    file = launchQueueFile(env);
    const captured = captureProcessIdentity(pid);
    // A child that already ended has nothing left to recognise.
    if (!captured.startIdentity || !captured.bootEpoch) return;
    await withLaunchQueue(file, lockMs, queue => queue.recordPublicationLaunch(captured, operation));
    identity = captured;
  })().catch(error => { console.warn(`[publication-launch] the preparer launch was not recorded (${failureClass(error)})`); });
  return {
    recorded,
    release: async () => {
      await recorded;
      if (!identity || !file) return;
      const ended = identity;
      try { await withLaunchQueue(file, lockMs, queue => queue.forgetPublicationLaunch(ended)); }
      catch (error) { console.warn(`[publication-launch] the preparer launch record was kept (${failureClass(error)})`); }
    },
  };
}
