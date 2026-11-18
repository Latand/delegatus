import { admissionLockWait } from "./cpu-admission-lock";
import { cpuPriorityFromEnv } from "../src/lib/runtime/cpuPriority";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cpuPressurePolicy } from "../src/lib/runtime/cpuPressure";
import { GateCpuPressure } from "../src/lib/runtime/gateCpuPressure";
import { inheritedCpuSlot, cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS } from "../src/lib/runtime/cpuAdmission";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuQueueDetail, ordinal } from "../src/lib/runtime/cpuQueueText";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";

const policy = cpuPressurePolicy();
const pressure = new GateCpuPressure(policy ? { ...policy, releaseAfterMs: Number(process.env.LLV_GATE_PSI_RELEASE_SECONDS ?? 10) * 1000 } : null);
const [mode, key, pid, claimSlot] = process.argv.slice(2);
if (mode === "--reuse-slot") {
  if (inheritedCpuSlot()) process.exit(0);
  if (process.env.LLV_GATE_SLOT_BROKER && process.env.LLV_GATE_SLOT_LEASE) {
    try {
      const lease = process.env.LLV_GATE_SLOT_LEASE, directory = process.env.LLV_GATE_LOCK_DIR, slots = process.env.LLV_GATE_SLOTS, issuer = process.env.LLV_GATE_SLOT_BROKER;
      // The image also ships this raw queue helper beside its bundled tools.
      // Ordinary queue operations need no broker client; bundled/cache copies
      // find their sibling, while the raw image helper uses the shipped dist.
      const sibling = path.join(import.meta.dir, "check-worker-client.mjs");
      const { reuseGateSlot } = await import(fs.existsSync(sibling) ? sibling : path.join(import.meta.dir, "../dist/gate/check-worker-client.mjs"));
      if (await reuseGateSlot()) {
        const owner = JSON.parse(lease).owner;
        if (process.env.LLV_GATE_SLOT_LEASE !== lease || process.env.LLV_GATE_LOCK_DIR !== directory || process.env.LLV_GATE_SLOTS !== slots || process.env.LLV_GATE_SLOT_BROKER !== issuer
          || cpuOwnerStatus(owner) !== "alive" || cpuOwnerExited(owner)) throw new Error("slot lease changed while validating");
        process.exit(0);
      }
    }
    catch (error) { console.error(`gate-slot: slot lease broker refused: ${(error as Error).message}`); process.exit(69); }
  }
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
const configuredSlots = Number(process.env.LLV_GATE_SLOTS || 6);
const flock = Bun.which("flock");
/** Return the effective cap only if it is full. The final claim runs under
 * the shell's admission lock and excludes the slot it just took. */
function fullSlotLimit(ownSlot?: string): number | undefined {
  if (!flock) return undefined;
  const dir = process.env.LLV_GATE_LOCK_DIR ?? "/var/tmp";
  const files = fs.readdirSync(dir);
  const locked = (file: string) => {
    const result = spawnSync(flock, ["-n", path.join(dir, file), "/bin/sh", "-c", ":"], { stdio: "ignore", timeout: 1_000 });
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    throw new Error("could not probe a heavy command slot lock");
  };
  let cap = configuredSlots;
  for (const file of files) {
    const match = /^llv-heavy-gate\.cap([1-9]\d*)\.lock$/.exec(file);
    if (match && Number(match[1]) < cap && locked(file)) cap = Number(match[1]);
  }
  let busy = 0;
  for (const file of files) {
    const match = /^llv-heavy-gate\.slot([1-9]\d*)\.lock$/.exec(file);
    if (match && match[1] !== ownSlot && locked(file) && ++busy >= cap) return cap;
  }
  return undefined;
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
  const check = async () => {
    checkOwner();
    const reason = await pressure.check();
    // Sampling yields: the command must still own its ticket before a write.
    checkOwner();
    // Mark this as a gate ticket in both modes. The queue applies its durable
    // pressure bound, and the shell takes a slot before calling --claim.
    const wait = queue!.check(key, !reason, owner, mode === "--claim", priority, true);
    return { reason, wait };
  };
  if (mode === "--claim") {
    if (claimSlot && fullSlotLimit(claimSlot) !== undefined) process.exitCode = 75;
    else {
      const { reason, wait } = await lockWait(check);
      if (wait?.heldBy === "pressure" && reason) console.error(`gate-slot: ${reason}`);
      process.exitCode = !wait ? 0 : 75;
    }
  } else {
    let shown = "";
    for (;;) {
      const { reason, wait } = await lockWait(check);
      let text;
      if (wait) {
        text = wait.heldBy === "pressure" && reason && !wait.stalledMs
          ? `${reason} · ${ordinal(wait.position)} in CPU queue · waited ${Math.floor(wait.waitedMs / 60_000)} min`
          : cpuQueueDetail(wait.position, wait.waitedMs, wait.stalledMs, wait.priority, wait.heldBy);
      } else {
        const cap = fullSlotLimit();
        if (cap === undefined) break;
        const { waitedMs, stalledMs } = queue.slotWait(key);
        const duration = stalledMs === undefined ? `waited ${Math.floor(waitedMs / 60_000)}` : `stalled for ${Math.floor(stalledMs / 60_000)}`;
        text = `Waiting for a heavy command slot · all ${cap} busy · ${duration} min`;
      }
      if (text !== shown) { console.error(`gate-slot: ${text}`); shown = text; }
      await Bun.sleep(Number(process.env.LLV_GATE_POLL_SECONDS ?? 2) * 1000);
    }
  }
} catch (error) {
  console.error(`gate-slot: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally { clearInterval(parentGuard); endWait(); queue?.close(); }
