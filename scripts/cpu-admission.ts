import { admissionLockWait } from "./cpu-admission-lock";
import { cpuPriorityFromEnv } from "../src/lib/runtime/cpuPriority";
import { spawnSync } from "node:child_process";
import { dlopen, read, type Pointer } from "bun:ffi";
import fs from "node:fs";
import path from "node:path";
import { cpuPressurePolicy } from "../src/lib/runtime/cpuPressure";
import { GateCpuPressure } from "../src/lib/runtime/gateCpuPressure";
import { ACTIVE_GATE_PREFIX, inheritedCpuSlot, cpuAdmissionFile, CpuAdmissionQueue, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS } from "../src/lib/runtime/cpuAdmission";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuQueueDetail, ordinal } from "../src/lib/runtime/cpuQueueText";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";
import type { ProcessIdentity } from "../src/lib/processIdentity";

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
    // Both platform-specific errno accessors have a pointer return ABI.
    const address = library.symbols[errno]!() as Pointer | null;
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
const transitionedGatePrefix = ACTIVE_GATE_PREFIX + "command:bounded:drained:";
let lockFd: ReturnType<typeof nativeSlotLock> | undefined;
let clockTicks: number | undefined;
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

// The pre-cap Linux wrapper can consume its ticket and exec the owned
// runner without opening a slot file. Observe both sides of that exec and
// the runner's cleanup supervisors when establishing a drained pool.
function legacyLinuxGateRunning(queue: CpuAdmissionQueue): boolean {
  const sandbox = signalSandboxContext();
  const proc = sandbox?.hostProc ?? "/proc";
  const uid = fs.statSync(path.join(proc, "self")).uid;
  const pool = fs.realpathSync(dir);
  const epoch = sandbox?.hostEpoch ?? owner.bootEpoch;
  const waiting = new Set(queue.waitingGateOwners().flatMap(data => {
    const identity = JSON.parse(data);
    return epoch && identity.bootEpoch === epoch && Number.isSafeInteger(identity.pid) &&
      typeof identity.startIdentity === "string" && identity.startIdentity.startsWith(`${identity.pid}:`)
      ? [identity.startIdentity] : [];
  }));
  const readArgv = (base: string) => fs.readFileSync(path.join(base, "cmdline")).subarray(0, -1).toString().split("\0");
  const readCwd = (base: string) => () => fs.readlinkSync(path.join(base, "cwd"));
  const checkoutEntry = (entry: string, directoryName: string, cwd: () => string) => {
    const script = path.isAbsolute(entry) ? entry : path.resolve(cwd(), entry);
    const directory = fs.realpathSync(path.dirname(script));
    const root = path.dirname(directory);
    if (path.basename(directory) === directoryName && fs.existsSync(path.join(root, ".git")) &&
      fs.existsSync(path.join(root, "scripts", "gate-runner")) && fs.existsSync(script)) return path.join(directory, path.basename(script));
  };
  const isHookParent = (command: string[], cwd: () => string) => {
    const argv = path.basename(command[0] ?? "") === "bash" && command[2] === "--in-cpu-scope" && path.basename(command[1] ?? "") === "gate-slot.sh"
      ? command.slice(3) : command;
    // This identifies the hook command. Older wrappers could admit it directly.
    const name = path.basename(argv[0] ?? "");
    const entry = name === "bun" && argv.length === 3 && argv[2] === "pre-push" && path.basename(argv[1] ?? "") === "local-gate.ts"
      ? argv[1] : (name === "bash" || name === "sh") && path.basename(argv[1] ?? "") === "pre-push" ? argv[1] : name === "pre-push" ? argv[0] : undefined;
    return entry !== undefined && checkoutEntry(entry, name === "bun" ? "scripts" : ".githooks", cwd) !== undefined;
  };
  const publicationPrepare = (argv: string[], cwd: () => string) => {
    if (argv.length === 4 && path.basename(argv[0]!) === "bun" && path.basename(argv[1]!) === "local-gate.ts" &&
      argv[2] === "pre-push" && argv[3] === "--publication-prepare") {
      const entry = checkoutEntry(argv[1]!, "scripts", cwd);
      if (entry) return fs.realpathSync(entry);
    }
  };
  const isPrepareSupervisor = (command: string[], cwd: () => string, readParent: () => string | undefined) => {
    // local-gate bootstraps an owned copy of itself before dispatching the
    // admitted child. The same argv sent through a legacy gate can take a slot.
    const script = publicationPrepare(command, cwd);
    if (script === undefined) return false;
    const parent = readParent();
    return parent !== undefined && script === publicationPrepare(readArgv(parent), readCwd(parent));
  };
  const recordedParent = (identity: ProcessIdentity | undefined) => identity && identity.bootEpoch === epoch &&
    cpuOwnerStatus(identity) === "alive" ? path.join(proc, String(identity.pid)) : undefined;
  const readStat = (base: string) => {
    const stat = fs.readFileSync(path.join(base, "stat"), "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  };
  // In the slotless protocol the shell execs the runner in place. Its
  // original ticket contains this exact kernel identity even after exec.
  let history: ReturnType<CpuAdmissionQueue["legacyGateHistory"]> | undefined;
  const skippedAdmission = (launcher: string) => {
    const born = Number(readStat(launcher)[19]);
    if (!epoch || !Number.isSafeInteger(born) || born <= 0) return false;
    const { cutover, retirements } = history ??= queue.legacyGateHistory(epoch);
    if (cutover.boot !== null) {
      // An upgrade cannot reconstruct claims made before observation began.
      // Boot time is monotonic. Round the procfs hundredths up at the boundary.
      if (!cutover.boot.startsWith("linux:")) return false;
      if (cutover.boot.split(":")[1] === epoch.split(":")[1]) {
        if (!cutover.clock || cutover.clock !== fs.readlinkSync(path.join(proc, "self/ns/time")) ||
          cutover.uptime === null || !Number.isFinite(cutover.uptime) || cutover.uptime <= 0) return false;
        clockTicks ??= Number(spawnSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000 }).stdout?.trim());
        if (!Number.isSafeInteger(clockTicks) || clockTicks <= 0 || born <= (cutover.uptime + 0.01) * clockTicks) return false;
      }
    }
    return !retirements.has(`${path.basename(launcher)}:${born}`);
  };
  const samePool = (candidate: string | undefined, cwd: string): boolean => {
    try { return fs.realpathSync(path.resolve(cwd, candidate || "/var/tmp")) === pool; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const readEnvironment = (base: string) => {
    const fields = fs.readFileSync(path.join(base, "environ"), "utf8").split("\0");
    return (key: string) => fields.find(value => value.startsWith(key + "="))?.slice(key.length + 1);
  };
  const serviceCommand = (argv: string[], runner: string) => {
    // The service's Linux check worker keeps its own argv while it supervises
    // the command. Accept the entry beside this exact owned runner.
    const worker = path.join(path.dirname(runner), "check-worker-entry.py");
    return path.basename(argv[0] ?? "") === "python3" && argv[1] === "-I" && argv[2] === worker ? argv.slice(3) : argv;
  };
  const childrenOf = (base: string) => new Set(fs.readdirSync(path.join(base, "task")).flatMap(thread =>
    fs.readFileSync(path.join(base, "task", thread, "children"), "utf8").split(/\s+/).filter(child => /^[1-9]\d*$/.test(child))));
  const hookHasQueuedGate = (hook: string, parent: string, membership: string) => {
    const command = readArgv(hook);
    // An ordinary hook may be wrapped by the service runner while it opens
    // the queue for its own cleanup command. Prove the nested hook argv from
    // that live wrapper before accepting the relationship.
    const hookCommand = path.basename(command[0] ?? "") === "bun" && path.basename(command[1] ?? "") === "owned-runner.ts"
      ? command.slice(2) : command;
    if (path.basename(hookCommand[0] ?? "") !== "bun" || !isHookParent(hookCommand, readCwd(hook)) ||
      readStat(hook)[1] !== path.basename(parent) || fs.readFileSync(path.join(hook, "cgroup"), "utf8") !== membership) return false;
    const cwd = readCwd(hook)();
    const env = readEnvironment(hook);
    if (!samePool(env("LLV_GATE_LOCK_DIR"), cwd) || env("LLV_GATE_SLOT_LEASE") !== undefined) return false;
    const script = fs.realpathSync(path.resolve(cwd, hookCommand[1]!));
    for (const pid of childrenOf(hook)) {
      const gate = path.join(proc, pid);
      const stat = readStat(gate);
      if (stat[1] !== path.basename(hook) || !waiting.has(`${pid}:${stat[19]}`)) continue;
      const rawArgs = readArgv(gate);
      const args = rawArgs.length > 3 && rawArgs[2] === "--in-cpu-scope" && path.basename(rawArgs[1] ?? "") === "gate-slot.sh"
        ? [...rawArgs.slice(0, 2), ...rawArgs.slice(3)] : rawArgs;
      const cwd = readCwd(gate)();
      if (args.length === 6 && path.basename(args[0]!) === "bash" && path.basename(args[2]!) === "bun" &&
        args[4] === "pre-push" && args[5] === "--admitted" &&
        fs.realpathSync(path.resolve(cwd, args[3]!)) === script &&
        path.resolve(cwd, args[1]!) === path.join(path.dirname(path.resolve(cwd, args[3]!)), "gate-slot.sh") &&
        fs.readFileSync(path.join(gate, "cgroup"), "utf8") === membership) return true;
    }
    return false;
  };
  const queuedHookBelow = (parent: string, membership: string) =>
    [...childrenOf(parent)].some(pid => hookHasQueuedGate(path.join(proc, pid), parent, membership));
  const queuedHookInTree = (root: string) => {
    const seen = new Set<string>();
    const visit = (parent: string, depth: number): boolean => {
      if (depth >= 8 || seen.size >= 256) return false;
      for (const pid of childrenOf(parent)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const child = path.join(proc, pid);
        let membership: string;
        try { membership = fs.readFileSync(path.join(child, "cgroup"), "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (hookHasQueuedGate(child, parent, membership) || visit(child, depth + 1)) return true;
      }
      return false;
    };
    return visit(root, 0);
  };
  const serviceClients = new Map<string, { unit: string; runner: string }>();
  const bornAfterPriorGrant = (base: string) => {
    const last = queue.lastAdmission();
    if (last === null || !Number.isFinite(last) || last <= 0) return false;
    const bootTime = /^btime (\d+)$/m.exec(fs.readFileSync(path.join(proc, "stat"), "utf8"))?.[1];
    const uptime = Number(fs.readFileSync(path.join(proc, "uptime"), "utf8").split(" ")[0]);
    if (!bootTime || !Number.isFinite(uptime)) return false;
    const bootEpoch = Number(bootTime);
    // btime is second-granularity. Refuse the inference if wall and monotonic
    // clocks diverged, and leave two seconds of uncertainty around the grant.
    if (Math.abs(Date.now() / 1000 - bootEpoch - uptime) > 2) return false;
    clockTicks ??= Number(spawnSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1_000 }).stdout?.trim());
    if (!Number.isSafeInteger(clockTicks) || clockTicks <= 0) return false;
    const grantUptime = last / 1000 - bootEpoch;
    const born = Number(readStat(base)[19]);
    return born > (grantUptime + 2) * clockTicks;
  };
  const waitingGateInService = (unit: string) => {
    const group = `/${unit}`;
    for (const identity of waiting) {
      const pid = identity.slice(0, identity.indexOf(":"));
      const base = path.join(proc, pid);
      try {
        if (readStat(base)[19] !== identity.slice(identity.indexOf(":") + 1)) continue;
        const inService = (entries: string[]) => entries.some(line => line.endsWith(group) || line.includes(`${group}/`));
        let ancestor = base, joined = false;
        for (let depth = 0; depth < 32; depth++) {
          if (inService(fs.readFileSync(path.join(ancestor, "cgroup"), "utf8").split("\n"))) { joined = true; break; }
          const parent = readStat(ancestor)[1];
          if (!/^[1-9]\d*$/.test(parent) || parent === path.basename(ancestor)) break;
          ancestor = path.join(proc, parent);
        }
        if (!joined) continue;
        const argv = readArgv(base);
        if (path.basename(argv[1] ?? "") !== "gate-slot.sh") continue;
        const cwd = readCwd(base)();
        const env = readEnvironment(base);
        if (!samePool(env("LLV_GATE_LOCK_DIR"), cwd) || env("LLV_GATE_SLOT_LEASE") !== undefined) continue;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  };
  const isHookRunner = (argv: string[], base: string, parentPid: string | undefined) => {
    const command = argv.slice(argv[2] === "--portable" || argv[2] === "--namespace" ? 3 : 2);
    const cwd = readCwd(base);
    if (isPrepareSupervisor(command, cwd, () => parentPid ? path.join(proc, parentPid) : undefined)) return true;
    if (!isHookParent(command, cwd)) return false;
    const runner = fs.realpathSync(path.resolve(cwd(), argv[1]!));
    const children = childrenOf(base);
    for (const pid of children) {
      const child = path.join(proc, pid), args = readArgv(child);
      if (readStat(child)[1] !== path.basename(base)) continue;
      if (path.basename(args[0] ?? "") === "systemd-run" && args.at(-2) === "--service" && args.at(-3) === runner) {
        const unit = args.find(arg => arg.startsWith("--unit=delegatus-gate-"))?.slice(7);
        if (unit) {
          if (samePool(readEnvironment(base)("LLV_GATE_LOCK_DIR"), cwd())) {
            serviceClients.set(args.at(-1)!, { unit, runner });
          }
          // An upgraded queue can first open from a nested cleanup runner
          // while the ordinary hook which owns it is already alive. Prove
          // that direct hook-to-queued-runner relationship before treating
          // the pre-observer service as a legacy holder.
          return skippedAdmission(base) || queuedHookInTree(base) ||
            bornAfterPriorGrant(base) && waitingGateInService(unit);
        }
      }
      if (args[1] === path.join(path.dirname(runner), "test-child-guardian.ts")) {
        const guardianOwner = JSON.parse(args[3]!);
        if (guardianOwner.bootEpoch !== epoch || guardianOwner.pid !== Number(path.basename(base)) ||
          guardianOwner.startIdentity !== `${path.basename(base)}:${readStat(base)[19]}`) continue;
        const membership = fs.readFileSync(path.join(base, "cgroup"), "utf8");
        const queued = [...children].some(pid => {
          const member = path.join(proc, pid);
          if (hookHasQueuedGate(member, base, membership)) return true;
          const argv = readArgv(member), command = serviceCommand(argv, runner);
          return command !== argv && isHookParent(command, readCwd(member)) &&
            readStat(member)[1] === path.basename(base) && fs.readFileSync(path.join(member, "cgroup"), "utf8") === membership &&
            queuedHookBelow(member, membership);
        });
        // A queued child proves that this live ordinary hook is supervising
        // its own cleanup admission. This relationship is usable even when
        // the hook predates the observer installed by that first queue open.
        return queued;
      }
    }
    return false;
  };
  const serviceCouldUsePool = (base: string, runner: string, file: string) => {
    // The service command inherits the launch environment and the supervisor
    // stamps its real cgroup. This can still establish scope when the launch
    // record's temporary directory has already been collected.
    const group = /^0::(\/.+\/delegatus-gate-[0-9a-f-]+\.service)$/m.exec(fs.readFileSync(path.join(base, "cgroup"), "utf8"))?.[1];
    if (!group) return true;
    const children = childrenOf(base);
    if (!children.size) return true;
    return [...children].some(child => {
      const member = path.join(proc, child);
      const env = readEnvironment(member);
      if (env("LLV_OWNED_TEST_RUN_CGROUP") !== group) return true;
      // A worker moves into its own entry leaf before it starts the hook.
      // Require kernel membership as well as the supervisor's launch stamp.
      const membership = fs.readFileSync(path.join(member, "cgroup"), "utf8");
      const groups = membership.split("\n");
      if (!groups.includes(`0::${group}`) && !groups.includes(`0::${group}/entry-${child}`)) return true;
      const cwd = readCwd(member);
      if (!samePool(env("LLV_GATE_LOCK_DIR"), cwd())) return false;
      if (env("LLV_GATE_SLOT_LEASE") !== undefined) return true;
      const argv = readArgv(member);
      const command = serviceCommand(argv, runner);
      if (command[2] === "--in-cpu-scope") {
        const wrapper = fs.realpathSync(path.resolve(cwd(), command[1]!));
        if (fs.realpathSync(path.join(path.dirname(wrapper), "owned-runner.ts")) !== fs.realpathSync(runner)) return true;
      }
      if (isHookParent(command, cwd)) {
        const client = serviceClients.get(file);
        if (client?.unit !== path.basename(group) || client.runner !== fs.realpathSync(runner)) return true;
        if (command !== argv) return !queuedHookBelow(member, membership);
        // The direct-Bun runner stamps its own systemd invocation on the hook.
        // Pre-exemption holders forward the caller's environment, even when
        // their hook queues a nested gate after consuming its slotless ticket.
        const invocation = env("INVOCATION_ID");
        return !invocation || !/^[0-9a-f]{32}$/.test(invocation) || invocation !== readEnvironment(base)("INVOCATION_ID") ||
          !hookHasQueuedGate(member, base, membership);
      }
      const parent = env("LLV_OWNED_RUN_PARENT_IDENTITY");
      return !(parent && isPrepareSupervisor(command, cwd, () => recordedParent(JSON.parse(parent))));
    });
  };
  const readCandidate = (entry: string, services: string[], inspectService = false) => {
    const base = path.join(proc, entry);
    try {
      const argv = readArgv(base);
      const script = path.basename(argv[1] ?? "");
      if (!["gate-slot.sh", "owned-runner.ts", "test-child-guardian.ts"].includes(script)) return false;
      const fields = readStat(base);
      if (["Z", "X", "x"].includes(fields[0]!)) return false;
      if (script === "gate-slot.sh" && argv[2] !== "--in-cpu-scope" &&
        (Number(entry) === owner.pid || waiting.has(`${entry}:${fields[19]}`))) return false;
      const cwd = readCwd(base);
      if (script === "gate-slot.sh" && isHookParent(argv.slice(2), cwd) && skippedAdmission(base)) return false;
      if (script === "owned-runner.ts" && argv[2] === "--service") {
        if (!inspectService) { services.push(entry); return false; }
        // The user manager's supervisor has a clean environment. Its private
        // launch record carries the caller's pool and whether it is a hook
        // parent which deliberately runs outside the gate pool.
        try {
          const launch = JSON.parse(fs.readFileSync(path.join(base, "root", argv[3]!), "utf8"));
          if (isPrepareSupervisor(serviceCommand(launch.command, argv[1]!), () => launch.cwd, () => recordedParent(launch.parent))) return false;
          if (isHookParent(serviceCommand(launch.command, argv[1]!), () => launch.cwd) &&
            !serviceCouldUsePool(base, argv[1]!, argv[3]!)) return false;
          return samePool(launch.env.LLV_GATE_LOCK_DIR, launch.cwd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return serviceCouldUsePool(base, argv[1]!, argv[3]!);
        }
      }
      if (script === "owned-runner.ts" && isHookRunner(argv, base, fields[1])) return false;
      if (script === "test-child-guardian.ts") {
        const runner = JSON.parse(argv[3]!);
        if (String(runner.pid) === fields[1] && runner.bootEpoch === epoch && cpuOwnerStatus(runner) === "alive") {
          const runnerBase = path.join(proc, String(runner.pid));
          const launch = readArgv(runnerBase);
          if (path.basename(launch[1] ?? "") === "owned-runner.ts" &&
            isHookRunner(launch, runnerBase, readStat(runnerBase)[1])) return false;
        }
      }
      const candidate = readEnvironment(base)("LLV_GATE_LOCK_DIR");
      return samePool(candidate, candidate && !path.isAbsolute(candidate) ? cwd() : "/");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      // A live supervisor whose metadata cannot be read is uncertain.
      return fs.existsSync(path.join(base, "stat"));
    }
  };
  const occupied = () => {
    serviceClients.clear();
    const services: string[] = [];
    return fs.readdirSync(proc).some(entry => {
      if (!/^[1-9]\d*$/.test(entry)) return false;
      try {
        return fs.statSync(path.join(proc, entry)).uid === uid && readCandidate(entry, services);
      }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    }) || services.some(entry => readCandidate(entry, services, true));
  };
  // Re-list after inspecting the original processes: cleanup can pass to a
  // newly spawned supervisor while an older process is exiting.
  return occupied() || occupied();
}
/** A held slot without a matching cap lock belongs to the older protocol
 * (or to the hand-run gate). Let it finish before sharing the pool. */
function fullSlotLimit(queue: CpuAdmissionQueue, ownSlot?: string): number | "legacy-drain" | undefined {
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
  // The held cap lock is the lifetime proof for a current holder's queue
  // fence. An old claim cannot slip in while that fence is visible.
  // A final claimant's provisional marker is excluded by ownSlot above.
  const transitioned = gates.some(gate => gate.slot !== null && gate.key.startsWith(transitionedGatePrefix) &&
    heldMarkers.has(capLock(gate.slot, gate.cap)));
  if (!transitioned && process.platform === "linux" && queue.lastAdmission() !== null && legacyLinuxGateRunning(queue)) return "legacy-drain";
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
        text = cap === "legacy-drain" ? `Waiting for legacy heavy commands to drain · ${duration} min`
          : `Waiting for a heavy command slot · all ${cap} busy · ${duration} min`;
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
