import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import type { AgentMemoryCell } from "./agentMemory";

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

type SignalDomainHandle = { pid?: number };
const domains = new WeakMap<SignalDomainHandle, AgentSignalDomain>();
const pendingReceipts = new WeakMap<SignalDomainHandle, string>();
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
  if (sourceEnv.LLV_GATE_SLOT_LEASE) throw new Error("agent signal sandbox unavailable: cross-user-namespace gate lease transfer is unsupported");
  const base = memory?.wrapSpawn(transportSpawn) ?? transportSpawn ?? ((cmd, argv, opts) => spawn(cmd, argv, { ...opts, stdio: ["pipe", "pipe", "pipe"] }));
  const scope = memory && (memory.plan.mechanism === "scope" || memory.plan.cpu) ? memory.plan.unit : null;
  return await spawnSignalSandbox(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }, base as typeof spawn, scope) as ChildProcessWithoutNullStreams;
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
      const domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(receipt, "utf8")))!;
      if (domain.monitor.pid !== child.pid) throw new Error("agent signal sandbox monitor identity does not match its handle");
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
  if (process.platform !== "linux") throw new Error("agent signal sandbox unavailable: Linux namespaces are required");
  const launcher = launcherFile();
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(options.env?.TMPDIR || os.tmpdir(), "delegatus-signal-")));
  const receipt = path.join(directory, "ready.json");
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), LLV_SIGNAL_LAUNCHER: launcher, LLV_SIGNAL_RECEIPT: receipt, LLV_SIGNAL_AUTOMATIC: "1" };
  const bridged = process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || env.LLV_DOCKER_NSENTER_SHIMS === "1";
  const child = bridged ? start(command, args, { ...options, env })
    : start("python3", [launcher, "--automatic", "--receipt", receipt, ...(scope ? ["--scope", scope] : []), "--", command, ...args], { ...options, env });
  pendingReceipts.set(child, receipt);
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

export function terminalSignalSandboxCommand(command: string): string {
  if (process.platform !== "linux") throw new Error("agent signal sandbox unavailable: Linux namespaces are required");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `python3 ${quote(launcherFile())} --terminal -- /bin/sh -c ${quote(command)}`;
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
  start: typeof spawn = spawn, scope?: string | null): Promise<ChildProcess> {
  if (process.platform !== "linux") throw new Error("agent signal sandbox unavailable: Linux namespaces are required");
  if (options.env?.LLV_GATE_SLOT_LEASE) throw new Error("agent signal sandbox unavailable: cross-user-namespace gate lease transfer is unsupported");
  const launcher = launcherFile();
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(options.env?.TMPDIR || os.tmpdir(), "delegatus-signal-")));
  const receipt = path.join(directory, "ready.json");
  const diagnosticFile = options.env?.LLV_SIGNAL_IGNORE_NATIVE_STDIO === "1" ? `${directory}.stderr` : undefined;
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), LLV_SIGNAL_LAUNCHER: launcher, LLV_SIGNAL_RECEIPT: receipt,
    ...(diagnosticFile ? { LLV_SIGNAL_DIAGNOSTIC: diagnosticFile } : {}) };
  const bridged = process.env.LLV_DOCKER_NSENTER_SHIMS === "1" || env.LLV_DOCKER_NSENTER_SHIMS === "1";
  const child = bridged ? start(command, args, { ...options, env })
    : start("python3", [launcher, "--receipt", receipt, ...(scope ? ["--scope", scope] : []), "--", command, ...args], { ...options, env });
  let stderr = "", failure: Error | undefined, closed = false;
  const diagnostic = (chunk: unknown) => { stderr = (stderr + String(chunk)).slice(-2048); };
  child.stderr?.on("data", diagnostic);
  child.once("error", error => { failure = error; });
  child.once("close", () => { closed = true; });
  const deadline = Date.now() + 15_000;
  try {
    for (;;) {
      if (failure) throw failure;
      if (fs.existsSync(receipt)) {
        const domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(receipt, "utf8")))!;
        if (domain.monitor.pid !== child.pid || domain.directory !== directory || !agentSignalDomainAlive(domain)) throw new Error("agent signal sandbox unavailable: launch identity could not be verified");
        domains.set(child, domain);
        fs.writeFileSync(path.join(directory, "exec.json"), "true", { mode: 0o600 });
        return child;
      }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        if (!stderr.trim() && diagnosticFile && fs.existsSync(diagnosticFile)) {
          const fd = fs.openSync(diagnosticFile, "r");
          try {
            const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 2048));
            fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            stderr = bytes.toString("utf8");
          } finally { fs.closeSync(fd); }
        }
        throw new Error(`agent signal sandbox unavailable: ${stderr.trim() || "readiness was not proved before the launch deadline"}`);
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
