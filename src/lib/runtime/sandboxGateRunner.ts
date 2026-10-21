import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { cpuSlotForOwner, inheritedCpuSlot } from "./cpuAdmission";
import { cpuOwnerIdentity, signalSandboxContext } from "./signalSandboxContext";
import { cpuWaitBudget, cpuInheritedWaitMs, cpuBudgetTimer } from "./cpuAdmissionBudget";
import { parseMemorySize } from "./agentMemory";

type Gate = { root: string; inode: string; owner: ProcessIdentity; parent: ProcessIdentity; timeoutMs: number; startedAt: number; directory: string; waitRoot: string };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const handles = new WeakMap<Gate, number>();

function verifiedRoot(gate: Gate): string {
  const context = signalSandboxContext();
  const prefix = context ? `${context.cgroupRoot}/` : "";
  if (!context || !gate.root.startsWith(prefix)
    || !gate.root.slice(prefix.length).split("/").every(part => /^gate-[a-f0-9-]+$/.test(part))) {
    throw new Error("owned runner refused an unverified namespace cgroup");
  }
  let handle = handles.get(gate);
  if (handle === undefined) {
    handle = fs.openSync(gate.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    handles.set(gate, handle);
  }
  if (fs.fstatSync(handle, { bigint: true }).ino.toString() !== gate.inode) throw new Error("owned runner cgroup identity changed");
  return `/proc/self/fd/${handle}`;
}

function removeRoot(gate: Gate): void {
  const anchored = verifiedRoot(gate);
  const current = fs.readlinkSync(anchored);
  if (fs.statSync(current, { bigint: true }).ino.toString() !== gate.inode) throw new Error("owned runner cgroup changed before removal");
  removeEmptyTree(current);
  fs.closeSync(handles.get(gate)!); handles.delete(gate);
}

function removeEmptyTree(directory: string): void {
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) removeEmptyTree(path.join(directory, child.name));
  }
  fs.rmdirSync(directory);
}

async function empty(gate: Gate): Promise<void> {
  const root = verifiedRoot(gate);
  fs.writeFileSync(path.join(root, "cgroup.kill"), "1");
  const deadline = Date.now() + 2_000;
  while (/^populated 1$/m.test(fs.readFileSync(path.join(root, "cgroup.events"), "utf8"))) {
    if (Date.now() >= deadline) throw new Error("owned runner namespace cgroup survived cleanup");
    await pause(10);
  }
}

/** The lowest memory.max on the scope and its ancestors, if any is set. */
function scopeMemoryCeiling(scope: string): number | null {
  let lowest: number | null = null;
  for (let group = scope; group !== "/" && group !== "."; group = path.dirname(group)) {
    try {
      const value = fs.readFileSync(`/sys/fs/cgroup${group}/memory.max`, "utf8").trim();
      if (/^\d+$/.test(value) && (lowest === null || Number(value) < lowest)) lowest = Number(value);
    } catch { /* The root and unreadable ancestors carry no file to read. */ }
  }
  return lowest;
}

/** Separate from the runner and outside the workload leaf. It remains able to
 * end a stopped or hard-killed runner's detached workload. */
export async function guardSandboxGate(file: string): Promise<never> {
  const gate = JSON.parse(fs.readFileSync(file, "utf8")) as Gate;
  verifiedRoot(gate);
  fs.writeFileSync(path.join(gate.directory, "guardian-ready"), "ready");
  for (;;) {
      if (fs.existsSync(path.join(gate.directory, "done"))) break;
      if (processIdentityStatus(gate.owner) !== "alive" || processIdentityStatus(gate.parent) !== "alive"
        || Date.now() - gate.startedAt - cpuInheritedWaitMs() >= gate.timeoutMs + 2_000) {
        console.error("owned runner: namespace owner ended or deadline expired");
        await empty(gate);
        removeRoot(gate);
        fs.rmSync(gate.directory, { recursive: true, force: true });
        fs.rmSync(gate.waitRoot, { recursive: true, force: true });
        if (processIdentityStatus(gate.owner) === "alive") process.kill(gate.owner.pid, "SIGKILL");
        process.exit(124);
      }
      await pause(100);
  }
    await empty(gate);
    process.exit(0);
}

/** Execute locally, inside the already established signal domain. The user
 * manager never starts the workload. A blocked child enters the bounded leaf
 * before its first exec, and a separate guardian owns its whole cgroup. */
export async function runSandboxGate(command: string[], timeoutMs: number, entry: string): Promise<never> {
  const context = signalSandboxContext();
  if (!context) throw new Error("owned runner namespace context is missing");
  const currentGroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
  const parent = currentGroup.startsWith(`${context.scope}/gate-`) && currentGroup.endsWith("/work") ? path.dirname(currentGroup).slice(context.scope.length) : "";
  const root = `${context.cgroupRoot}${parent}/gate-${randomUUID()}`;
  fs.mkdirSync(root);
  const budget = cpuWaitBudget(process.env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-namespace-gate-"));
  let child: ReturnType<typeof spawn> | undefined;
  let guardian: ReturnType<typeof spawn> | undefined;
  let stopTimer = () => {};
  let cancel: (() => void) | undefined;
  let cleanup: Promise<void> | undefined;
  const gate: Gate = { root, inode: fs.statSync(root, { bigint: true }).ino.toString(),
    owner: captureProcessIdentity(process.pid), parent: captureProcessIdentity(process.ppid), timeoutMs, startedAt: Date.now(), directory,
    waitRoot: JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!).at(-1)! };
  try {
    verifiedRoot(gate);
    if (![gate.owner, gate.parent].every(identity => identity.startIdentity && identity.bootEpoch)) throw new Error("owned runner has no verified namespace owner identity");
    const memory = parseMemorySize(process.env.LLV_GATE_MEM ?? "8G");
    const quota = Number((process.env.DELEGATUS_WORK_SCOPE_CPU_QUOTA ?? process.env.LLV_WORK_SCOPE_CPU_QUOTA ?? "300").replace(/%$/, ""));
    if (!memory || !Number.isSafeInteger(quota) || quota <= 0) throw new Error("owned runner needs finite memory and CPU limits");
    // The leaf cannot exceed a limit above it; name the one that binds.
    const ceiling = scopeMemoryCeiling(context.scope);
    if (ceiling !== null && ceiling < memory) {
      console.error(`owned runner: this gate leaf sits inside the agent's scope, so its effective memory cap is ${(ceiling / 2 ** 30).toFixed(2)} GiB, below the gate's ${process.env.LLV_GATE_MEM ?? "8G"}`);
    }
    fs.writeFileSync(path.join(root, "memory.max"), String(memory));
    fs.writeFileSync(path.join(root, "memory.swap.max"), "0");
    fs.writeFileSync(path.join(root, "cpu.max"), `${quota * 200} 20000`);
    fs.writeFileSync(path.join(root, "pids.max"), "4096");
    fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +memory +pids");
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    if (fs.readFileSync(path.join(root, "memory.max"), "utf8").trim() !== String(memory)
      || fs.readFileSync(path.join(root, "cpu.max"), "utf8").trim() !== `${quota * 200} 20000`) throw new Error("owned runner kernel resource limits are missing");
    const file = path.join(directory, "gate.json");
    fs.writeFileSync(file, JSON.stringify(gate), { mode: 0o600 });
    guardian = spawn(process.execPath, [entry, "--namespace-guardian", file], { stdio: ["ignore", "ignore", "inherit"], detached: true, env: budget.env });
    const guarded = new Promise<number>(resolve => {
      guardian!.once("exit", code => resolve(code ?? 1));
      guardian!.once("error", () => resolve(1));
    });
    const readyDeadline = Date.now() + 5_000;
    while (!fs.existsSync(path.join(directory, "guardian-ready"))) {
      if (guardian.exitCode !== null || Date.now() >= readyDeadline) throw new Error("owned runner namespace guardian did not become ready");
      await pause(10);
    }
    const slot = inheritedCpuSlot() ?? cpuSlotForOwner(cpuOwnerIdentity(process.pid));
    if (slot) budget.env.LLV_GATE_SLOT_LEASE = JSON.stringify(slot);
    const cgroup = context.scope + work.slice(context.cgroupRoot.length);
    const barrier = path.join(directory, "exec");
    await new Promise<void>((resolve, reject) => {
      const fifo = spawn("mkfifo", ["-m", "600", barrier], { stdio: "ignore" });
      fifo.once("error", reject);
      fifo.once("exit", code => code === 0 ? resolve() : reject(new Error("owned runner could not create its exec barrier")));
    });
    child = spawn("/bin/bash", ["-c", 'barrier=$1; shift; read -r < "$barrier" || exit 69; export LLV_OWNED_TEST_RUNNER_PID=$$; exec "$@"', "owned-command", barrier, ...command], {
      stdio: ["inherit", "inherit", "inherit"], env: { ...budget.env, LLV_OWNED_TEST_RUN_CGROUP: cgroup },
    });
    const finished = new Promise<number>(resolve => {
      child!.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137)));
      child!.once("error", () => resolve(1));
    });
    let interrupted = 0;
    const endWork = () => cleanup ??= empty(gate);
    cancel = () => { interrupted ||= 143; endWork().catch(error => console.error(error)); };
    process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
    stopTimer = cpuBudgetTimer(timeoutMs, budget.elapsed, () => { interrupted ||= 124; endWork().catch(error => console.error(error)); });
    if (!child.pid) throw new Error("owned runner namespace worker did not start");
    fs.writeFileSync(path.join(work, "cgroup.procs"), String(child.pid));
    if (!fs.readFileSync(`/proc/${child.pid}/cgroup`, "utf8").split("\n").includes(`0::${cgroup}`)) throw new Error("owned runner worker escaped its bounded leaf");
    const barrierDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        const descriptor = fs.openSync(barrier, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        try { fs.writeSync(descriptor, "exec\n"); } finally { fs.closeSync(descriptor); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENXIO" || child.exitCode !== null || Date.now() >= barrierDeadline) throw error;
        await pause(10);
      }
    }
    const code = await Promise.race([finished, guarded.then(code => code || 1)]);
    const survivors = /^populated 1$/m.test(fs.readFileSync(path.join(verifiedRoot(gate), "cgroup.events"), "utf8"));
    if (survivors && code === 0) console.error("owned runner: surviving owned processes in namespace cgroup");
    fs.writeFileSync(path.join(directory, "done"), "done");
    await empty(gate);
    const guardCode = await guarded;
    await finished;
    stopTimer();
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
    budget.close();
    removeRoot(gate);
    fs.rmSync(directory, { recursive: true, force: true });
    return process.exit(interrupted || (guardCode === 124 ? 124 : code || guardCode || (survivors ? 1 : 0)));
  } catch (error) {
    try { await empty(gate); }
    finally {
      child?.kill("SIGKILL");
      guardian?.kill("SIGTERM");
      for (const owned of [child, guardian]) if (owned) await new Promise<void>(resolve => owned.exitCode !== null || owned.signalCode !== null ? resolve() : owned.once("close", () => resolve()));
    }
    removeRoot(gate);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    stopTimer();
    if (cancel) { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
    budget.close();
  }
}
