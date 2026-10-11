import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CpuPressureGate, cpuPressurePolicy, DEFAULT_CPU_PRESSURE_POLICY, parseCpuPressure } from "../src/lib/runtime/cpuPressure";
import { inheritedCpuSlot, machineCpuAdmissionQueue } from "../src/lib/runtime/cpuAdmission";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuQueueDetail } from "../src/lib/runtime/cpuQueueText";

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
if (mode === "--reuse-slot") process.exit(inheritedCpuSlot() ? 0 : 75);
const queue = machineCpuAdmissionQueue();
if (!key || !pid || !["--wait", "--claim"].includes(mode!)) throw new Error("cpu admission needs a mode, ticket and owner PID");
const owner = captureProcessIdentity(Number(pid));
if (mode === "--claim") {
  const admitted = !queue.check(key, !pressure.check(), owner);
  queue.close();
  process.exit(admitted ? 0 : 75);
}
function slotAvailable(): boolean {
  if (spawnSync("which", ["flock"], { stdio: "ignore" }).status !== 0) return true;
  const dir = process.env.LLV_GATE_LOCK_DIR ?? "/var/tmp";
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= Number(process.env.LLV_GATE_SLOTS ?? 6); i++) {
    if (spawnSync("flock", ["-n", path.join(dir, `llv-heavy-gate.slot${i}.lock`), "true"], { stdio: "ignore" }).status === 0) return true;
  }
  return false;
}
const endWait = reportCpuWait();
const cancel = () => { queue.cancel(key); endWait(); process.exit(130); };
process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
const parentGuard = setInterval(() => {
  if (processIdentityStatus(owner) === "dead" || procBackend.processExited(owner.pid)) cancel();
}, 100);
try {
  let shown = "";
  for (;;) {
    const wait = queue.check(key, !pressure.check(), owner, false);
    if (!wait && slotAvailable()) break;
    const text = wait ? cpuQueueDetail(wait.position, wait.remainingMs) : "Waiting for a heavy command slot";
    if (text !== shown) { console.error(`gate-slot: ${text}`); shown = text; }
    await Bun.sleep(Number(process.env.LLV_GATE_POLL_SECONDS ?? 2) * 1000);
  }
} finally { clearInterval(parentGuard); endWait(); queue.close(); }
