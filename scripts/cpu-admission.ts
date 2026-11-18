import { admissionLockWait } from "./cpu-admission-lock";
import { cpuPriorityFromEnv } from "../src/lib/runtime/cpuPriority";
import { spawnSync } from "node:child_process";
import { dlopen, read } from "bun:ffi";
import fs from "node:fs";
import path from "node:path";
import { cpuPressurePolicy } from "../src/lib/runtime/cpuPressure";
import { GateCpuPressure } from "../src/lib/runtime/gateCpuPressure";
import { ACTIVE_GATE_PREFIX, inheritedCpuSlot, cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS } from "../src/lib/runtime/cpuAdmission";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuQueueDetail, ordinal } from "../src/lib/runtime/cpuQueueText";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";

const policy = cpuPressurePolicy();
const pressure = new GateCpuPressure(policy ? { ...policy, releaseAfterMs: Number(process.env.LLV_GATE_PSI_RELEASE_SECONDS ?? 10) * 1000 } : null);
const [mode, key, pid, claimSlot] = process.argv.slice(2);
function nativeSlotLock() {
  const errno = process.platform === "darwin" ? "__error" : "__errno_location";
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errno]: { args: [], returns: "ptr" },
  });
  return (fd: number) => {
    if (library.symbols.flock!(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
    const address = library.symbols[errno]!();
    if (address && read.i32(address) === (process.platform === "darwin" ? 35 : 11)) return false;
    throw new Error("could not acquire a heavy command slot lock");
  };
}
if (mode === "--lock-fd") {
  // The shell already opened this descriptor. flock attaches to the shared
  // open file description, so the shell retains it when the helper exits.
  try {
    if (!key || !/^[789]$/.test(key)) throw new Error("invalid heavy command slot descriptor");
    process.exit(nativeSlotLock()(Number(key)) ? 0 : 1);
  } catch (error) {
    console.error(`gate-slot: ${(error as Error).message}`);
    process.exit(70);
  }
}
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
if (!key || !pid || !["--wait", "--claim", "--release-slot"].includes(mode!)) throw new Error("cpu admission needs a mode, ticket and owner PID");
// Capture the owner before opening can yield on a shared store lock.
const owner = cpuOwnerIdentity(Number(pid));
const priority = cpuPriorityFromEnv();
const lockWait = admissionLockWait(Number(process.env.LLV_CPU_ADMISSION_LOCK_TIMEOUT_MS ?? 30_000));
const endWait = mode === "--release-slot" ? () => {} : reportCpuWait();
let queue: CpuAdmissionQueue | undefined;
const configuredSlots = Number(process.env.LLV_GATE_SLOTS || 6);
if (!Number.isSafeInteger(configuredSlots) || configuredSlots < 1) throw new Error("LLV_GATE_SLOTS must be a positive safe integer");
const portable = process.platform === "win32";
if (claimSlot && (portable ? claimSlot !== "portable" : !/^[1-9]\d*$/.test(claimSlot) || Number(claimSlot) > configuredSlots)) {
  throw new Error("invalid heavy command slot");
}
const flock = Bun.which("flock");
const dir = process.env.LLV_GATE_LOCK_DIR ?? "/var/tmp";
const capLock = (slot: number, cap: number) => `llv-heavy-gate.slot${slot}.cap${cap}.lock`;
let lockFd: ReturnType<typeof nativeSlotLock> | undefined;
function locked(file: string): boolean {
  const filename = path.join(dir, file);
  if (flock) {
    const result = spawnSync(flock, ["-n", filename, "/bin/sh", "-c", ":"], { stdio: "ignore", timeout: 1_000 });
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    throw new Error("could not probe a heavy command slot lock");
  }
  lockFd ??= nativeSlotLock();
  const fd = fs.openSync(filename, "a");
  try { return !lockFd(fd); } finally { fs.closeSync(fd); }
}
/** A held slot without a matching cap lock belongs to the older protocol
 * (or to the hand-run gate). Let it finish before sharing the pool. */
function fullSlotLimit(queue: CpuAdmissionQueue, ownSlot?: string): number | undefined {
  let cap = configuredSlots;
  let busy = 0;
  const gates = queue.activeGateSlots();
  if (portable) {
    for (const gate of gates) {
      if (gate.slot !== null) continue;
      if (cpuOwnerStatus(JSON.parse(gate.owner)) === "dead") queue.releaseGateSlot(gate.key, gate.owner);
      else { busy++; cap = Math.min(cap, gate.cap); }
    }
    return busy >= cap ? cap : undefined;
  }
  const markedSlots = new Set<string>();
  const heldMarkers = new Set<string>();
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const match = /^llv-heavy-gate\.slot([1-9]\d*)\.cap([1-9]\d*)\.lock$/.exec(file);
    if (match && match[1] !== ownSlot && locked(file)) {
      heldMarkers.add(file);
      markedSlots.add(match[1]!);
      cap = Math.min(cap, Number(match[2]));
    }
  }
  for (const gate of gates) {
    if (gate.slot !== null && String(gate.slot) !== ownSlot && !heldMarkers.has(capLock(gate.slot, gate.cap))) {
      queue.releaseGateSlot(gate.key, gate.owner);
    }
  }
  for (const file of files) {
    const match = /^llv-heavy-gate\.slot([1-9]\d*)\.lock$/.exec(file);
    if (match && match[1] !== ownSlot && locked(file)) {
      if (!markedSlots.has(match[1]!)) return 1;
      if (++busy >= cap) return cap;
    }
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
async function serveQueue(queue: CpuAdmissionQueue) {
  if (mode === "--release-slot") {
    await lockWait(() => queue.releaseGateSlot(`${ACTIVE_GATE_PREFIX}${key}`, JSON.stringify(owner)));
    return;
  }
  const check = async () => {
    checkOwner();
    const reason = await pressure.check();
    // Sampling yields: the command must still own its ticket before a write.
    checkOwner();
    // Mark this as a gate ticket in both modes. The queue applies its durable
    // pressure bound, and the shell takes a slot before calling --claim.
    const gateSlot = mode === "--claim" && claimSlot ? {
      lastBeforeProbe: queue.lastAdmission(), slot: portable ? null : Number(claimSlot), cap: configuredSlots,
    } : undefined;
    if (gateSlot && fullSlotLimit(queue, claimSlot) !== undefined) return { reason, wait: null, slotBlocked: true };
    checkOwner();
    const wait = queue.check(key!, !reason, owner, mode === "--claim", priority, true, gateSlot);
    return { reason, wait, slotBlocked: false };
  };
  if (mode === "--claim") {
    const { reason, wait, slotBlocked } = await lockWait(check);
    if (wait?.heldBy === "pressure" && reason) console.error(`gate-slot: ${reason}`);
    process.exitCode = !wait && !slotBlocked ? 0 : 75;
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
        const cap = await lockWait(() => fullSlotLimit(queue));
        if (cap === undefined) break;
        const { waitedMs, stalledMs } = queue.slotWait(key!);
        const duration = stalledMs === undefined ? `waited ${Math.floor(waitedMs / 60_000)}` : `stalled for ${Math.floor(stalledMs / 60_000)}`;
        text = `Waiting for a heavy command slot · all ${cap} busy · ${duration} min`;
      }
      if (text !== shown) { console.error(`gate-slot: ${text}`); shown = text; }
      await Bun.sleep(Number(process.env.LLV_GATE_POLL_SECONDS ?? 2) * 1000);
    }
  }
}
try {
  queue = await lockWait(() => {
    checkOwner();
    return new CpuAdmissionQueue(cpuAdmissionFile(), Date.now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS,
      { status: cpuOwnerStatus, exited: cpuOwnerExited }, 0);
  });
  await serveQueue(queue);
} catch (error) {
  console.error(`gate-slot: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally { clearInterval(parentGuard); endWait(); queue?.close(); }
