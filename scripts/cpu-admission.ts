import { admissionLockWait } from "./cpu-admission-lock";
import { cpuPriorityFromEnv } from "../src/lib/runtime/cpuPriority";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CpuPressureGate, cpuPressurePolicy, DEFAULT_CPU_PRESSURE_POLICY, parseCpuPressure } from "../src/lib/runtime/cpuPressure";
import { inheritedCpuSlot, cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS } from "../src/lib/runtime/cpuAdmission";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuQueueDetail } from "../src/lib/runtime/cpuQueueText";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";

const policy = cpuPressurePolicy();
const pressure = new CpuPressureGate({ ...(policy ?? DEFAULT_CPU_PRESSURE_POLICY), releaseAfterMs: Number(process.env.LLV_GATE_PSI_RELEASE_SECONDS ?? 10) * 1000 }, {
  now: Date.now,
  sample: () => {
    if (!policy) return null;
    try { return parseCpuPressure(fs.readFileSync(process.env.LLV_GATE_PSI_FILE ?? "/proc/pressure/cpu", "utf8")); }
    catch { return null; }
  },
});
const [mode, key, pid] = process.argv.slice(2);
if (mode === "--reuse-slot") {
  if (inheritedCpuSlot()) process.exit(0);
  if (process.env.LLV_GATE_SLOT_LEASE && signalSandboxContext()) {
    console.error("gate-slot: inherited slot ownership is unverified or crosses a user namespace; cross-boundary lease transfer is unsupported");
    process.exit(69);
  }
  process.exit(75);
}
// The shell owns this monitor across readiness, lock races and retry pauses.
// A completed claim ends it before the command's execution clock starts.
if (mode === "--watch-wait") {
  if (!key || !pid) throw new Error("CPU wait monitor needs a private directory and owner PID");
  const owner = cpuOwnerIdentity(Number(pid));
  const endWait = reportCpuWait();
  const cancel = () => { endWait(); process.exit(130); };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  try {
    fs.writeFileSync(path.join(key, "ready"), "ready", { mode: 0o600 });
    while (!fs.existsSync(path.join(key, "done"))) {
      if (cpuOwnerStatus(owner) === "dead" || cpuOwnerExited(owner)) break;
      await Bun.sleep(100);
    }
  } finally { endWait(); }
  process.exit(0);
}
if (!key || !pid || !["--wait", "--claim"].includes(mode!)) throw new Error("cpu admission needs a mode, ticket and owner PID");
// Capture the owner before opening can yield on a shared store lock.
const owner = cpuOwnerIdentity(Number(pid));
const priority = cpuPriorityFromEnv();
const lockWait = admissionLockWait(Number(process.env.LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS ?? 30_000));
const endWait = reportCpuWait();
let queue: CpuAdmissionQueue | undefined;
function slotAvailable(): boolean {
  if (spawnSync("which", ["flock"], { stdio: "ignore" }).status !== 0) return true;
  const dir = process.env.LLV_GATE_LOCK_DIR ?? "/var/tmp";
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= Number(process.env.LLV_GATE_SLOTS ?? 6); i++) {
    if (spawnSync("flock", ["-n", path.join(dir, `llv-heavy-gate.slot${i}.lock`), "true"], { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}
const cancel = () => {
  // Dead command owners are reaped by the next successful queue check if
  // this best-effort delete cannot obtain the store lock.
  try { queue?.cancel(key); } catch { /* SQLite may still be locked. */ }
  endWait(); queue?.close(); process.exit(130);
};
const checkOwner = () => {
  if (cpuOwnerStatus(owner) === "dead" || cpuOwnerExited(owner)) cancel();
};
process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
const parentGuard = setInterval(checkOwner, 100);
try {
  queue = await lockWait(() => {
    checkOwner();
    return new CpuAdmissionQueue(cpuAdmissionFile(), Date.now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS,
      { status: cpuOwnerStatus, exited: cpuOwnerExited }, 0);
  });
  const check = () => {
    checkOwner();
    return queue!.check(key, !pressure.check(), owner, mode === "--claim", priority);
  };
  if (mode === "--claim") {
    process.exitCode = !await lockWait(check) ? 0 : 75;
  } else {
    let shown = "";
    for (;;) {
      const wait = await lockWait(check);
      if (!wait && slotAvailable()) break;
      const text = wait ? cpuQueueDetail(wait.position, wait.remainingMs, wait.stalledMs, wait.priority) : "Waiting for a heavy command slot";
      if (text !== shown) { console.error(`gate-slot: ${text}`); shown = text; }
      await Bun.sleep(Number(process.env.LLV_GATE_POLL_SECONDS ?? 2) * 1000);
    }
  }
} catch (error) {
  console.error(`gate-slot: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally { clearInterval(parentGuard); endWait(); queue?.close(); }
