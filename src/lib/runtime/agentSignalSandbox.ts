import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { redactBounded } from "@/lib/monitor/redact";
import type { AgentMemoryCell } from "./agentMemory";
import { STDERR_READ_BYTES, startupStderrText, withoutUnterminatedSecret } from "./startupStderr";

export interface AgentSignalDomain {
  policyVersion: 1;
  monitor: ProcessIdentity;
  bubblewrap: ProcessIdentity;
  init: ProcessIdentity;
  native: ProcessIdentity;
  pidNamespace: string;
  userNamespace: string;
  scope: string;
  directory: string;
  retired?: true;
}

/** A launch that runs without the boundary records why. Hosts publish it
 * beside their registry row; the launch itself is never refused for it. */
export interface SignalBoundaryOff { state: "off"; reason: string }

/** Both sides of the exec barrier derive their waits from these budgets. The
 * launcher falls back to an unprotected exec when its namespace is not ready
 * within the readiness budget. The Viewer waits for a receipt for readiness
 * plus acknowledgement; the namespace waits for its exec signal longer still. */
export const SIGNAL_READINESS_MS = 10_000;
export const SIGNAL_ACK_MS = 15_000;
const BOUNDARY_REASON_MAX_CHARS = 500;

type SignalDomainHandle = { pid?: number };
const domains = new WeakMap<SignalDomainHandle, AgentSignalDomain>();
const pendingReceipts = new WeakMap<SignalDomainHandle, string>();
const boundaryOff = new WeakMap<SignalDomainHandle, SignalBoundaryOff>();
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let fixtureHeadlessSpawn: typeof spawn | null = null;
/** Test preload supplies a transport for protocol fixtures; native
 * qualification clears it to exercise the production launch boundary. */
export function setHeadlessSpawnForTests(transport: typeof spawn | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Headless fixture transport is unavailable outside tests");
  fixtureHeadlessSpawn = transport;
}
export function headlessFixtureTransport(): typeof spawn | null { return fixtureHeadlessSpawn; }

type EngineSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export async function spawnManagedEngine(command: string, args: string[], options: SpawnOptionsWithoutStdio,
  memory: AgentMemoryCell | null | undefined, injected?: EngineSpawn, sourceEnv = options.env ?? process.env,
  transportSpawn?: EngineSpawn): Promise<ChildProcessWithoutNullStreams> {
  if (injected) return (memory?.wrapSpawn(injected) ?? injected)(command, args, options);
  const base = memory?.wrapSpawn(transportSpawn) ?? transportSpawn ?? ((cmd, argv, opts) => spawn(cmd, argv, { ...opts, stdio: ["pipe", "pipe", "pipe"] }));
  const scope = memory && (memory.plan.mechanism === "scope" || memory.plan.cpu) ? memory.plan.unit : null;
  const capabilityEnv = sourceEnv.LLV_GATE_SLOT_LEASE ? { ...(options.env ?? process.env), LLV_GATE_SLOT_LEASE: sourceEnv.LLV_GATE_SLOT_LEASE } : undefined;
  return await spawnSignalSandbox(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }, base as typeof spawn, scope, capabilityEnv) as ChildProcessWithoutNullStreams;
}

/** Why this handle's engine runs without the boundary, if it does. */
export function signalBoundaryOff(child: SignalDomainHandle): SignalBoundaryOff | undefined {
  if (pendingReceipts.has(child)) {
    try { signalDomain(child); } catch { /* A refused receipt is reported by its cleanup caller. */ }
  }
  const off = boundaryOff.get(child);
  return off ? { ...off } : undefined;
}

/** Carries a launch's boundary status to a transport or a reconnected handle. */
export function recordSignalBoundaryOff(child: SignalDomainHandle, value: SignalBoundaryOff | string, launch?: string): void {
  const reason = (typeof value === "string" ? value : value.reason).slice(0, BOUNDARY_REASON_MAX_CHARS) || "the boundary could not be established";
  boundaryOff.set(child, { state: "off", reason });
  if (launch) console.warn(`[signal-sandbox] ${launch} launch runs without the agent signal boundary: ${reason}`);
}

/** Reject malformed persisted boundary status. */
export function normalizeSignalBoundaryOff(value: unknown): SignalBoundaryOff | undefined {
  if (!value || typeof value !== "object") return undefined;
  const off = value as Partial<SignalBoundaryOff>;
  return off.state === "off" && typeof off.reason === "string" && off.reason
    ? { state: "off", reason: off.reason.slice(0, BOUNDARY_REASON_MAX_CHARS) } : undefined;
}

function onPath(binary: string, searchPath: string | undefined): boolean {
  return (searchPath ?? "").split(path.delimiter).some(directory => {
    if (!directory) return false;
    try { fs.accessSync(path.join(directory, binary), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** One capability decision per launch. This side rules out what it can see;
 * the launcher proves the host facts and falls back the same way. */
function signalLauncher(env: NodeJS.ProcessEnv, bridged: boolean): { launcher: string } | { off: string } {
  if (process.platform !== "linux") return { off: `Linux namespaces are unavailable on ${process.platform}` };
  if (env.LLV_GATE_SLOT_LEASE) return { off: "an inherited gate slot lease cannot cross a user namespace" };
  if (process.getuid?.() === 0) return { off: "managed signal domains require a non-root user" };
  if (!bridged && !onPath("python3", env.PATH)) return { off: "required host dependency is missing: python3" };
  try { return { launcher: launcherFile() }; }
  catch (error) { return { off: error instanceof Error ? error.message : String(error) }; }
}

/** The receipt and the namespace scratch beside it. Behind the Docker bridge
 * the launcher runs in the host mount namespace, which shares the mounted home
 * with the container and not its temporary root: a launch keeps a TMPDIR whose
 * physical location is under that home, such as a stage's scratch, and
 * otherwise uses a cache there. Both sides are compared after resolving links,
 * because a link under the home can lead to a directory only the container
 * sees. A Viewer-side setup failure is one more reason the boundary is off. */
function prepareLaunch(capabilityEnv: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, bridged: boolean): { launcher: string; directory: string } | { off: string } {
  const decision = signalLauncher(capabilityEnv, bridged);
  if ("off" in decision) return decision;
  try {
    const temporary = env.TMPDIR || os.tmpdir(), home = os.homedir();
    const physical = (file: string) => { try { return fs.realpathSync(file); } catch { return null; } };
    const [realTemporary, realHome] = [physical(temporary), physical(home)];
    const relative = realTemporary && realHome ? path.relative(realHome, realTemporary) : "..";
    const shared = !bridged || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
    const parent = !bridged ? temporary : shared ? realTemporary! : path.join(home, ".cache/delegatus/signal-runs");
    if (!shared) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    return { launcher: decision.launcher, directory: fs.realpathSync(fs.mkdtempSync(path.join(parent, "delegatus-signal-"))) };
  } catch (error) {
    return { off: `launch scratch is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function launcherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, LLV_SIGNAL_READINESS_MS: String(SIGNAL_READINESS_MS), LLV_SIGNAL_ACK_MS: String(SIGNAL_ACK_MS) };
}

/** `handle` is the process the caller started: the monitor itself, or the
 * launcher that waits outside the transient scope the monitor runs in. */
type SignalReceipt = { domain: AgentSignalDomain; handle: number } | { off: string };
function readReceipt(file: string): SignalReceipt {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.policyVersion === 1 && value.boundary === "off") {
    return { off: typeof value.reason === "string" && value.reason ? value.reason : "the launcher could not establish the boundary" };
  }
  const domain = normalizeAgentSignalDomain(value)!;
  const launcher = value.launcher as ProcessIdentity | undefined;
  if (launcher === undefined) return { domain, handle: domain.monitor.pid };
  if (!Number.isSafeInteger(launcher?.pid) || launcher.pid <= 1 || launcher.bootEpoch !== domain.monitor.bootEpoch
    || [domain.monitor, domain.bubblewrap, domain.init, domain.native].some(identity => identity.pid === launcher.pid)) {
    throw new Error("agent signal sandbox launcher identity is contradictory");
  }
  return { domain, handle: launcher.pid };
}

/** Reject malformed persisted authority. */
export function normalizeAgentSignalDomain(value: unknown): AgentSignalDomain | undefined {
  if (value === undefined) return undefined;
  const domain = value as AgentSignalDomain;
  const validIdentity = (identity: ProcessIdentity | undefined) => identity
    && Number.isSafeInteger(identity.pid) && identity.pid > 1
    && typeof identity.startIdentity === "string" && identity.startIdentity.length > 0
    && typeof identity.bootEpoch === "string" && identity.bootEpoch.length > 0;
  if (!domain || domain.policyVersion !== 1 || !validIdentity(domain.monitor) || !validIdentity(domain.bubblewrap)
    || !validIdentity(domain.init) || !validIdentity(domain.native)
    || !/^pid:\[\d+\]$/.test(domain.pidNamespace) || !/^user:\[\d+\]$/.test(domain.userNamespace)
    || typeof domain.scope !== "string" || !domain.scope.startsWith("/") || domain.scope.includes("..")
    || !domain.scope.endsWith(".scope") || typeof domain.directory !== "string" || !path.isAbsolute(domain.directory)
    || (domain.retired !== undefined && domain.retired !== true)) {
    throw new Error("agent signal sandbox identity is malformed or unsupported");
  }
  const identities = [domain.monitor, domain.bubblewrap, domain.init, domain.native];
  if (new Set(identities.map(identity => identity.pid)).size !== identities.length
    || identities.some(identity => identity.bootEpoch !== domain.monitor.bootEpoch)) throw new Error("agent signal sandbox identity is contradictory");
  // Collection readers expose immutable proxies. Rebuild the validated fields
  // as plain objects so they can be copied and persisted.
  const copy = (identity: ProcessIdentity): ProcessIdentity => ({ pid: identity.pid,
    startIdentity: identity.startIdentity, bootEpoch: identity.bootEpoch });
  return { policyVersion: 1, monitor: copy(domain.monitor), bubblewrap: copy(domain.bubblewrap),
    init: copy(domain.init), native: copy(domain.native), pidNamespace: domain.pidNamespace,
    userNamespace: domain.userNamespace, scope: domain.scope, directory: domain.directory,
    ...(domain.retired ? { retired: true } : {}) };
}

function namespaceOf(pid: number, kind: "pid" | "user"): string | null {
  try { return fs.readlinkSync(`/proc/${pid}/ns/${kind}`); } catch { return null; }
}

/** Every identity is in the launcher's PID namespace. Local PIDs never leave the adapter. */
export function agentSignalDomainAlive(domain: AgentSignalDomain): boolean {
  return [domain.monitor, domain.bubblewrap, domain.init, domain.native].every(identity => processIdentityStatus(identity) === "alive")
    && namespaceOf(domain.init.pid, "pid") === domain.pidNamespace
    && namespaceOf(domain.native.pid, "pid") === domain.pidNamespace
    && namespaceOf(domain.native.pid, "user") === domain.userNamespace;
}

export function verifiedSignalDomainProcesses(domain: AgentSignalDomain): ProcessIdentity[] | undefined {
  const living: ProcessIdentity[] = [];
  for (const record of [domain.monitor, domain.bubblewrap, domain.init, domain.native]) {
    const status = processIdentityStatus(record);
    if (status === "unverified") return undefined;
    if (status === "alive") {
      if (record !== domain.monitor && record !== domain.bubblewrap && namespaceOf(record.pid, "pid") !== domain.pidNamespace) return undefined;
      living.push(record);
    }
  }
  return living;
}

/** Reconnected transports retain the original invocation's signal authority. */
export function bindSignalDomain(handle: SignalDomainHandle, value: AgentSignalDomain): void {
  const domain = normalizeAgentSignalDomain(value)!;
  if (handle.pid !== domain.native.pid || !agentSignalDomainAlive(domain)) throw new Error("agent signal sandbox reconnect identity could not be verified");
  domains.set(handle, domain);
}

export function signalDomain(child: SignalDomainHandle): AgentSignalDomain | undefined {
  const receipt = pendingReceipts.get(child);
  if (receipt && fs.existsSync(receipt)) {
    try {
      const parsed = readReceipt(receipt);
      if ("off" in parsed) {
        // The launcher already executed the engine in its own place.
        pendingReceipts.delete(child);
        recordSignalBoundaryOff(child, parsed.off, "headless");
        fs.rmSync(path.dirname(receipt), { recursive: true, force: true });
        return undefined;
      }
      const domain = parsed.domain;
      if (parsed.handle !== child.pid) throw new Error("agent signal sandbox monitor identity does not match its handle");
      domains.set(child, domain); pendingReceipts.delete(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Normal completion removes the receipt before the close event arrives.
    }
  }
  const domain = domains.get(child);
  if (!domain) return undefined;
  const result = structuredClone(domain);
  if ([domain.monitor, domain.bubblewrap, domain.init, domain.native].every(identity => processIdentityStatus(identity) === "dead")) result.retired = true;
  return result;
}
export function nativeProcessId(child: SignalDomainHandle): number | undefined { return domains.get(child)?.native.pid ?? child.pid; }

/** TERM reaches the verified native process. Escalation ends the owned PID
 * namespace, including descendants that changed session or were reparented. */
export function signalAgentDomain(child: SignalDomainHandle, signal: NodeJS.Signals): boolean | undefined {
  const domain = signalDomain(child);
  if (!domain) return undefined;
  const target = signal === "SIGKILL" ? domain.init : domain.native;
  const status = processIdentityStatus(target);
  if (status === "dead") return true;
  if (status !== "alive" || namespaceOf(target.pid, "pid") !== domain.pidNamespace) return false;
  try { process.kill(target.pid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** File-backed headless callers retain their synchronous handle API. The
 * trusted launcher verifies the kernel and identities before exec and before
 * the native process can read the buffered prompt. Its receipt remains beside
 * the independent monitor for the run's entire lifetime. */
export function spawnHeadlessSignalSandbox(command: string, args: string[], options: SpawnOptions,
  start: typeof spawn = spawn, scope?: string | null): ChildProcess {
  const bridged = process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || options.env?.LLV_DOCKER_NSENTER_SHIMS === "1";
  const prepared = prepareLaunch(options.env ?? process.env, options.env ?? process.env, bridged);
  if ("off" in prepared) {
    // No launcher runs to print the fallback, so a run's own stderr file gets
    // the line here, before the engine's first byte.
    const stderr = Array.isArray(options.stdio) ? options.stdio[2] : undefined;
    if (typeof stderr === "number") {
      try { fs.writeSync(stderr, `agent signal sandbox: boundary off, running unprotected: ${prepared.off}\n`); }
      catch { /* The Viewer log below still names the launch. */ }
    }
    const child = start(command, args, options);
    recordSignalBoundaryOff(child, prepared.off, "headless");
    return child;
  }
  const { launcher, directory } = prepared;
  const receipt = path.join(directory, "ready.json");
  const env: NodeJS.ProcessEnv = { ...launcherEnv(options.env ?? process.env), LLV_SIGNAL_LAUNCHER: launcher, LLV_SIGNAL_RECEIPT: receipt, LLV_SIGNAL_AUTOMATIC: "1" };
  const child = bridged ? start(command, args, { ...options, env })
    : start("python3", [launcher, "--automatic", "--receipt", receipt, ...(scope ? ["--scope", scope] : []), "--", command, ...args], { ...options, env });
  pendingReceipts.set(child, receipt);
  // The launcher's fallback line is in the run's own stderr from its start.
  // Its receipt is read at cleanup, or here, which removes its scratch.
  child.once("close", () => {
    try { signalDomain(child); } catch (error) { console.error("headless signal sandbox receipt refused", error); }
  });
  return child;
}

function launcherFile(): string {
  // The cache is visible on both sides of the container-to-host transition.
  // Source also ships in the npm bin directory and in the standalone image.
  const source = resolveSignalTooling().launcher;
  const body = fs.readFileSync(source);
  const directory = path.join(os.homedir(), ".cache/delegatus/signal-sandbox", createHash("sha256").update(body).digest("hex"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "launch.py");
  if (!fs.existsSync(file)) {
    const temporary = path.join(directory, `${randomUUID()}.py`);
    fs.writeFileSync(temporary, body, { mode: 0o700, flag: "wx" });
    try { fs.linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { fs.unlinkSync(temporary); }
  }
  if (!fs.readFileSync(file).equals(body)) throw new Error("agent signal sandbox unavailable: cached launcher does not match this release");
  return file;
}

// Typed into an interactive shell, so it avoids history expansion's "!".
const TERMINAL_ENTRY = 'if command -v python3 >/dev/null 2>&1; then '
  + 'if [ -r "$1" ]; then exec python3 "$1" --terminal -- /bin/sh -c "$2"; fi; reason="the launcher is unreadable from the pane"; '
  + 'else reason="required host dependency is missing: python3"; fi; '
  + 'echo "agent signal sandbox: boundary off, running unprotected: $reason" >&2; exec /bin/sh -c "$2"';

/** An unavailable boundary leaves the pane command as it was. The pane runs
 * in the tmux server's environment, so the launcher there judges a lease, and
 * a pane without python3 or the launcher runs the command unprotected. */
export function terminalSignalSandboxCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const decision = signalLauncher({ ...env, LLV_GATE_SLOT_LEASE: undefined }, env.LLV_DOCKER_NSENTER_SHIMS === "1");
  if ("off" in decision) {
    console.warn(`[signal-sandbox] terminal launch runs without the agent signal boundary: ${decision.off}`);
    return command;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `/bin/sh -c ${quote(TERMINAL_ENTRY)} sh ${quote(decision.launcher)} ${quote(command)}`;
}

/** Source releases and packed releases use the same capability check. */
export function resolveSignalTooling(cwd = process.cwd()): { launcher: string; gate: string } {
  const bridge = process.env.LLV_DOCKER_NSENTER_SHIMS === "1";
  let directory = path.resolve(cwd);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      const launcher = path.join(directory, "bin/agent-signal-sandbox.py");
      if (manifest.name === "delegatus-cli" && fs.existsSync(path.join(directory, "bin/cli.mjs")) && fs.statSync(launcher).isFile()) {
        const candidates = bridge ? [path.join(directory, "dist/gate")] : [path.join(directory, "scripts"), path.join(directory, "dist/gate")];
        for (const scripts of candidates) {
          try {
            for (const name of ["gate-slot.sh", "owned-runner.ts", "cpu-admission.ts"]) fs.accessSync(path.join(scripts, name), fs.constants.R_OK);
            if (!fs.readFileSync(path.join(scripts, "owned-runner.ts"), "utf8").includes("runSandboxGate")
              || !fs.readFileSync(path.join(scripts, "gate-slot.sh"), "utf8").includes("LLV_SIGNAL_SANDBOX")) continue;
            return bridge ? cacheHostTooling(launcher, scripts)
              : { launcher: fs.realpathSync(launcher), gate: fs.realpathSync(path.join(scripts, "gate-slot.sh")) };
          } catch { /* Try packed tooling beside an incomplete source tree. */ }
        }
      }
    } catch { /* Standalone can carry a manifest below the installation. */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Gate wrapper unavailable: installed Delegatus tooling must support agent signal namespaces before a managed stage can launch");
}

/** Container paths cannot appear in a host agent's test instructions. The
 * bundled tools have no checkout imports and are published atomically into
 * the home mounted at the same path on both sides of the transition. */
function cacheHostTooling(launcher: string, scripts: string): { launcher: string; gate: string } {
  const files = new Map([...["gate-slot.sh", "owned-runner.ts", "cpu-admission.ts", "test-child-guardian.ts"].map(name => [name, fs.readFileSync(path.join(scripts, name))] as const),
    ["launch.py", fs.readFileSync(launcher)] as const]);
  const digest = createHash("sha256");
  for (const [name, body] of files) digest.update(name).update(body);
  const parent = path.join(os.homedir(), ".cache/delegatus/signal-tooling");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = path.join(parent, digest.digest("hex"));
  if (!fs.existsSync(directory)) {
    const temporary = fs.mkdtempSync(path.join(parent, "building-"));
    try {
      for (const [name, body] of files) fs.writeFileSync(path.join(temporary, name), body, { mode: 0o700 });
      try { fs.renameSync(temporary, directory); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  for (const [name, body] of files) {
    if (!fs.readFileSync(path.join(directory, name)).equals(body)) throw new Error("agent signal sandbox unavailable: cached host tooling differs from this release");
  }
  return { launcher: path.join(directory, "launch.py"), gate: path.join(directory, "gate-slot.sh") };
}

/** The resource wrapper remains outside the namespace. An injected spawn is
 * the host tests' protocol seam; production callers always use this adapter. */
export async function spawnSignalSandbox(command: string, args: string[], options: SpawnOptions,
  start: typeof spawn = spawn, scope?: string | null, capabilityEnv = options.env ?? process.env): Promise<ChildProcess> {
  const bridged = process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || options.env?.LLV_DOCKER_NSENTER_SHIMS === "1";
  const prepared = prepareLaunch(capabilityEnv, options.env ?? process.env, bridged);
  if ("off" in prepared) {
    // Main's launch path: the engine under its memory and CPU wrapper only.
    const child = start(command, args, options);
    recordSignalBoundaryOff(child, prepared.off, "managed");
    return child;
  }
  const { launcher, directory } = prepared;
  const receipt = path.join(directory, "ready.json");
  const diagnosticFile = options.env?.LLV_SIGNAL_IGNORE_NATIVE_STDIO === "1" ? `${directory}.stderr` : undefined;
  const env: NodeJS.ProcessEnv = { ...launcherEnv(options.env ?? process.env), LLV_SIGNAL_LAUNCHER: launcher, LLV_SIGNAL_RECEIPT: receipt,
    ...(diagnosticFile ? { LLV_SIGNAL_DIAGNOSTIC: diagnosticFile } : {}) };
  const child = bridged ? start(command, args, { ...options, env })
    : start("python3", [launcher, "--receipt", receipt, ...(scope ? ["--scope", scope] : []), "--", command, ...args], { ...options, env });
  let stderr = "", failure: Error | undefined, closed = false;
  // The head of the output keeps a secret's opening marker with its payload;
  // a clipped tail could start inside one and defeat redaction.
  const diagnostic = (chunk: unknown) => { if (stderr.length < STDERR_READ_BYTES) stderr = (stderr + String(chunk)).slice(0, STDERR_READ_BYTES); };
  child.stderr?.on("data", diagnostic);
  child.once("error", error => { failure = error; });
  child.once("close", () => { closed = true; });
  // The launcher reports an unprotected fallback before its readiness budget
  // ends. Only a launcher that cannot run at all reaches this deadline.
  const deadline = Date.now() + SIGNAL_READINESS_MS + SIGNAL_ACK_MS;
  try {
    for (;;) {
      if (failure) throw failure;
      if (fs.existsSync(receipt)) {
        const parsed = readReceipt(receipt);
        if ("off" in parsed) {
          // The launcher has executed the engine in its own place.
          recordSignalBoundaryOff(child, parsed.off, "managed");
          fs.rmSync(directory, { recursive: true, force: true });
          return child;
        }
        const domain = parsed.domain;
        if (parsed.handle !== child.pid || domain.directory !== directory || !agentSignalDomainAlive(domain)) throw new Error("agent signal sandbox unavailable: launch identity could not be verified");
        domains.set(child, domain);
        fs.writeFileSync(path.join(directory, "exec.json"), "true", { mode: 0o600 });
        return child;
      }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        if (!stderr.trim() && diagnosticFile && fs.existsSync(diagnosticFile)) {
          const fd = fs.openSync(diagnosticFile, "r");
          try { stderr = startupStderrText(fd, fs.fstatSync(fd).size); }
          finally { fs.closeSync(fd); }
        }
        const cause = redactBounded(withoutUnterminatedSecret(stderr), 2048).trim();
        throw new Error(`agent signal sandbox unavailable: ${cause || "readiness was not proved before the launch deadline"}`);
      }
      await pause(10);
    }
  } catch (error) {
    // This handle was created here. Its monitor binds Bubblewrap's lifetime;
    // no lookup by process name or port is used on a partial setup failure.
    if (!closed && child.pid) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await Promise.race([closed, pause(3_000).then(() => { throw new Error("agent signal sandbox setup cleanup did not settle"); })]);
    }
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    child.stderr?.off("data", diagnostic);
    if (diagnosticFile) fs.rmSync(diagnosticFile, { force: true });
  }
}
