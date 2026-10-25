import { bindHostExitWriter, hostExitText, hostExitWriterPending, hostExitWriterRegistered, readHostExit, readHostExitSpool, reclaimHostExit, recordHostExit, recordHostStop } from "./hostExit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import WebSocket from "ws";
import { procBackend } from "@/lib/proc";
import { redactBounded } from "@/lib/monitor/redact";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { signalProcessGroup } from "@/lib/processGroup";
import type { ProcessIdentity } from "@/lib/agent/registry";
import { startupStderrText } from "./startupStderr";
import { bindSignalDomain, nativeProcessId, normalizeSignalBoundaryOff, recordSignalBoundaryOff, signalAgentDomain, signalBoundaryOff, signalDomain, type AgentSignalDomain, type SignalBoundaryOff } from "./agentSignalSandbox";

export interface CodexSocketOwner { endpoint: string; process: ProcessIdentity; signalDomain?: AgentSignalDomain; signalBoundary?: SignalBoundaryOff }
export type CodexTransport = Pick<ChildProcessWithoutNullStreams, "pid" | "stdin" | "stdout" | "stderr" | "kill"> & EventEmitter;
const prefix = "codex-unix:";

/** Uses the serving interpreter and builtins only, including on installations
 * where the optional namespace launcher/Python is unavailable. */
export const socketWaitOwnerSource = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const [directory, binary, ...argv] = JSON.parse(process.argv.at(-1));
const atomic = (file, value, first = false) => {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = file + "." + crypto.randomUUID();
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (first) { try { fs.linkSync(temporary, file); } catch(e) { if(e.code!=="EEXIST") throw e; } }
    else fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { fs.rmSync(temporary, {force:true}); }
};
const child = require("node:child_process").spawn(binary, argv, {stdio:"inherit", detached:true});
let settled = false;
const finish = (code, signal, error) => {
  if(settled) return; settled = true;
  const value = {code, signal, at:new Date().toISOString()};
  if(error) { fs.writeSync(2, "agent engine could not start: " + error.message + "\n"); value.error=error.code; }
  atomic(path.join(directory,"native-exit.json"), value);
  const binding = path.join(directory,"host-exit.json");
  if(fs.existsSync(binding)) {
    const bound = JSON.parse(fs.readFileSync(binding,"utf8"));
    if(!bound.discard) {
      atomic(bound.file, value, true);
      fs.rmSync(bound.file.replace(/\.exit\.json$/, ".writer.json"), {force:true});
    }
  }
  if(fs.existsSync(path.join(directory,"attached"))) fs.rmSync(directory,{recursive:true,force:true});
  process.exitCode = code ?? (signal ? 128 + require("node:os").constants.signals[signal] : 127);
};
child.once("error", error=>finish(null,null,error));
child.once("exit", (code,signal)=>finish(code,signal));
try { atomic(path.join(directory,"native.json"), {pid:child.pid ?? null}); }
catch(error) {
  fs.writeSync(2,"native wait owner readiness failed: " + (error.code ?? error.name) + "\n");
  try { atomic(path.join(directory,"native-stop.json"), {path:"codex-socket-startup-cleanup",operationId:crypto.randomUUID(),signal:"SIGKILL",at:new Date().toISOString()}); }
  catch { fs.writeSync(2,"native startup stop intent could not be persisted\n"); }
  try { process.kill(-child.pid,"SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}
`;

export function codexSocketPath(endpoint: string): string | null {
  if (!endpoint.startsWith(prefix)) return null;
  const file = endpoint.slice(prefix.length);
  return path.isAbsolute(file) && path.basename(file) === "rpc.sock" ? file : null;
}

function verifiedSocket(owner: CodexSocketOwner): string | null {
  const file = codexSocketPath(owner.endpoint);
  if (!file || !owner.process.startIdentity || processIdentityStatus(owner.process) !== "alive") return null;
  try {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || process.getuid && directory.uid !== process.getuid()) return null;
    let physical = file;
    if (fs.lstatSync(file).isSymbolicLink()) {
      // 0.162.1 advertises an alias to a SHA-256-named socket in its protected
      // daemon directory. Resolve it in the recorded process's mount namespace:
      // the container Viewer and its host CLI can have different /tmp roots.
      const target = fs.readlinkSync(file);
      const digest = createHash("sha256").update(path.join(fs.realpathSync(path.dirname(file)), path.basename(file))).digest("hex");
      if (!path.isAbsolute(target) || path.basename(target) !== digest || path.basename(path.dirname(target)) !== `codex-daemon-${directory.uid}`) return null;
      physical = process.platform === "linux" ? `/proc/${owner.process.pid}/root${target}` : target;
    }
    const parent = fs.lstatSync(path.dirname(physical));
    const socket = fs.lstatSync(physical);
    return parent.isDirectory() && (parent.mode & 0o077) === 0
      && socket.isSocket() && (socket.mode & 0o077) === 0
      && (process.getuid === undefined || parent.uid === process.getuid() && socket.uid === process.getuid()) ? physical : null;
  } catch { return null; }
}

export function verifiedCodexSocketOwner(owner: CodexSocketOwner): boolean { return verifiedSocket(owner) !== null; }

/** Bytes of native stderr kept for a startup diagnostic. Everything after is discarded. */
const STDERR_KEEP_BYTES = 16 * 1024;

interface StderrDrain { writer: number; finished: Promise<void> }

/** Native stderr goes to a FIFO read by a detached drain that keeps the first
 * STDERR_KEEP_BYTES in `file` and discards the rest, so a listener that outlives
 * its Viewer never fills the disk and never sees a closed stderr. `finished`
 * settles when every writer closed. Resolves to null when the drain could not
 * start; the caller then discards native stderr. */
async function startStderrDrain(fifo: string, file: string): Promise<StderrDrain | null> {
  const made = await new Promise<boolean>(resolve => {
    execFile("mkfifo", ["-m", "600", fifo], { timeout: 5_000 }, error => resolve(!error));
  });
  if (!made) return null;
  let writer: number | undefined;
  try {
    // A writer must exist before the drain opens the read end.
    writer = fs.openSync(fifo, fs.constants.O_RDWR);
    // The shell creates the empty sink before launch. Do not let dd truncate a
    // wrapper's diagnostic through its alias when the FIFO ends without bytes.
    // dd copies the first bytes unbuffered; cat then discards the rest.
    const script = `umask 077; exec 3<"$1" 4>"$2" || exit 1; echo ready; exec >/dev/null
trap '' HUP; dd bs=1 count="$3" conv=notrunc <&3 >&4 2>/dev/null; cat <&3 >/dev/null`;
    const drain = spawn("sh", ["-c", script, "sh", fifo, file, String(STDERR_KEEP_BYTES)], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const finished = new Promise<void>(resolve => { drain.once("close", () => resolve()); drain.once("error", () => resolve()); });
    drain.unref();
    const ready = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 5_000);
      drain.stdout!.once("data", () => { clearTimeout(timer); resolve(true); });
      drain.once("close", () => { clearTimeout(timer); resolve(false); });
    });
    drain.stdout!.destroy();
    if (ready) return { writer, finished };
    drain.kill("SIGKILL");
  } catch { /* fall through to discarding */ }
  if (writer !== undefined) fs.closeSync(writer);
  return null;
}

/** A private native app-server listener outlives its Viewer connection. The
 * registry's process identity and writer claim fence admission to this socket. */
export class CodexSocketTransport extends EventEmitter implements CodexTransport {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  readonly endpoint: string;
  readonly startIdentity: string;
  readonly bootEpoch: string;
  /** Settles once every writer of the startup stderr drain closed, which is
   * a moment after the native process ended. Resolved for a reconnected owner. */
  stderrDrained: Promise<void> = Promise.resolve();
  private socket: WebSocket | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly durableExitExpected: boolean;
  private readonly directoryIdentity: { ino: number; dev: number };

  private constructor(owner: CodexSocketOwner) {
    super();
    this.pid = owner.process.pid;
    this.startIdentity = owner.process.startIdentity!;
    this.bootEpoch = owner.process.bootEpoch!;
    this.endpoint = owner.endpoint;
    this.durableExitExpected = hostExitWriterPending(owner.process) || Boolean(readHostExit(owner.process)?.exit);
    this.directoryIdentity = fs.lstatSync(path.dirname(codexSocketPath(owner.endpoint)!));
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { callback(new Error("Codex callback connection is closed")); return; }
      this.socket.send(String(chunk).trimEnd(), callback);
    }, final: callback => { this.socket?.close(); callback(); } });
    // Install connection error handlers before a caller can send any bytes.
    this.stdin.on("error", () => {});
    this.stdout.on("error", () => {});
    this.stderr.on("error", () => {});
    this.on("error", () => {});
  }

  static async reconnect(owner: CodexSocketOwner): Promise<CodexSocketTransport> {
    if (!verifiedCodexSocketOwner(owner)) throw new Error("Codex callback owner cannot be verified");
    const transport = new CodexSocketTransport(owner);
    if (owner.signalDomain) {
      if (owner.signalDomain.native.startIdentity !== owner.process.startIdentity || owner.signalDomain.native.bootEpoch !== owner.process.bootEpoch) throw new Error("Codex callback signal identity changed");
      bindSignalDomain(transport, owner.signalDomain);
    } else if (normalizeSignalBoundaryOff(owner.signalBoundary)) recordSignalBoundaryOff(transport, owner.signalBoundary!);
    try { await transport.connect(); }
    catch (error) { transport.disconnect(); throw error; }
    if (!verifiedCodexSocketOwner(owner)) { transport.disconnect(); throw new Error("Codex callback owner changed while connecting"); }
    transport.poll = setInterval(() => {
      if (procBackend.processIdentity(transport.pid) !== transport.startIdentity) transport.processEnded();
    }, 100);
    transport.poll.unref();
    return transport;
  }

  static async launch(command: string, args: string[], options: SpawnOptionsWithoutStdio,
    wrap?: (base: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams) => (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams,
    launch?: (command: string, args: string[], options: SpawnOptionsWithoutStdio,
      base: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams) => Promise<ChildProcessWithoutNullStreams>,
  ): Promise<CodexSocketTransport> {
    const root = path.join(process.env.HOME ?? os.homedir(), ".cache", "delegatus", "s");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (Buffer.byteLength(root) > 72) throw new Error("Codex callback socket directory exceeds the native socket path limit");
    const directory = fs.mkdtempSync(path.join(root, "dlg-codex-"));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "rpc.sock");
    const diagnosticFile = path.join(directory, "startup.stderr");
    const fifo = path.join(directory, "startup.fifo");
    let supervisedProcess: ProcessIdentity | undefined;
    let launchHandle: ChildProcessWithoutNullStreams | undefined;
    let supervisionReady: Promise<void> = Promise.resolve();
    const drain = await startStderrDrain(fifo, diagnosticFile);
    let writer: number | null = drain?.writer ?? null;
    fs.rmSync(fifo, { force: true });
    let diagnosticFd = drain ? fs.openSync(diagnosticFile, "r") : undefined;
    const diagnostic = async (ended: boolean) => {
      if (diagnosticFd === undefined) return "";
      const fd = diagnosticFd;
      // The drain copies byte by byte on its own schedule. Once the process ended its
      // last bytes are in flight until the drain finishes; a live one is read when steady.
      let size = fs.fstatSync(fd).size;
      if (ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([drain!.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
        if (timer) clearTimeout(timer);
        size = fs.fstatSync(fd).size;
      } else {
        for (let still = 0, waited = 0; (still < 2 || size === 0) && waited < 500; waited += 10) {
          await new Promise(resolve => setTimeout(resolve, 10));
          const next = fs.fstatSync(fd).size;
          still = next === size ? still + 1 : 0;
          size = next;
        }
      }
      return startupStderrText(fd, size);
    };
    const startupFailure = (reason: string, ownership = false) => new Error(ownership
      ? `Codex callback listener ownership could not be verified (${reason})`
      : `Codex callback listener failed before dispatch: ${reason}`);
    const closeDiagnostic = () => {
      if (diagnosticFd !== undefined) fs.closeSync(diagnosticFd);
      diagnosticFd = undefined;
      if (writer !== null) fs.closeSync(writer);
      writer = null;
      fs.rmSync(diagnosticFile, { force: true });
    };
    const failureMessage = (reason: string, detail: string, handle = launchHandle): string => {
      let native = supervisedProcess;
      let domain: AgentSignalDomain | undefined;
      try { domain = handle && signalDomain(handle); native = domain?.native ?? native; } catch { /* The launch refusal already names an invalid receipt. */ }
      const recorded = readHostExit(native);
      const evidence = recorded?.exit ? recorded : domain ? recorded : readHostExitSpool(directory);
      // No host was admitted. Keep its terminal evidence in the returned
      // failure, retained by the launch attempt, rather than orphaned slots.
      let cleanupRefused = false;
      for (const identity of [native, supervisedProcess]) {
        try { if (identity?.startIdentity && !hostExitWriterPending(identity)) reclaimHostExit(identity); }
        catch { cleanupRefused = true; }
      }
      const retained = evidence?.exit ? `; ${hostExitText(evidence)} at ${evidence.exit.at}` : "";
      return redactBounded(`${redactBounded(reason, 1600)}${retained}${cleanupRefused ? "; exit receipt cleanup refused" : ""}${detail && !reason.includes(detail) ? `; stderr: ${detail}` : ""}`, 2400);
    };
    const base = (binary: string, argv: string[], env: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams => {
      // Keep native stdio independent of the Viewer: a bounded drain outlives it.
      // A wrapper reads its own diagnostic name back after its setup fails.
      if (writer !== null && env.env?.LLV_SIGNAL_DIAGNOSTIC) fs.symlinkSync(diagnosticFile, env.env.LLV_SIGNAL_DIAGNOSTIC);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ["-e", socketWaitOwnerSource, "--", JSON.stringify([directory, binary, ...argv])], { ...env, stdio: ["ignore", "ignore", writer ?? "ignore"] });
      }
      finally {
        if (writer !== null) fs.closeSync(writer);
        writer = null;
      }
      {
        supervisionReady = (async () => {
          const ready = path.join(directory, "native.json");
          const deadline = performance.now() + 10_000;
          while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          if (!fs.existsSync(ready)) throw startupFailure("native wait owner did not become ready");
          const pid = JSON.parse(fs.readFileSync(ready, "utf8")).pid;
          if (!Number.isSafeInteger(pid) || pid <= 1) throw startupFailure("native wait owner returned an invalid pid");
          supervisedProcess = captureProcessIdentity(pid);
          if (supervisedProcess.startIdentity) bindHostExitWriter(directory, supervisedProcess, captureProcessIdentity(child.pid!));
        })();
        // A launch adapter may wait for native output before returning its
        // handle. Discover its pid independently of that adapter.
        void supervisionReady.catch(() => {});
      }
      const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
      // Bun exposes read-only stream properties. The memory-cell adapter needs
      // stream handles, while the native process itself keeps no Viewer pipes.
      return launchHandle = new Proxy(child, { get(target, key) {
        if (key === "spawnReady") return supervisionReady;
        if (key === "pid") return supervisedProcess?.pid ?? target.pid;
        if (key === "kill") return (signal: NodeJS.Signals = "SIGTERM") => {
          if (!supervisedProcess || processIdentityStatus(supervisedProcess) !== "alive") return false;
          try { process.kill(supervisedProcess.pid, signal); return true; } catch { return false; }
        };
        if (key === "stdin" || key === "stdout" || key === "stderr") return streams[key];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as ChildProcessWithoutNullStreams;
    };
    let child: ChildProcessWithoutNullStreams;
    try { child = launch ? await launch(command, [...args, "--listen", `unix://${file}`],
      { ...options, env: { ...(options.env ?? process.env), LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1", LLV_SIGNAL_KEEP_NATIVE_STDERR: "1" } }, base)
      : (wrap ? wrap(base) : base)(command, [...args, "--listen", `unix://${file}`], options); }
    catch (error) {
      const detail = await diagnostic(true);
      closeDiagnostic();
      const reason = error instanceof Error ? error.message : String(error);
      // A wrapper that read the same redacted startup stderr already carries it.
      const message = failureMessage(reason, detail);
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(message);
    }
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    // spawn reports errors such as ENOENT on the next turn, without a pid.
    if (!child.pid) await new Promise<void>(resolve => setImmediate(resolve));
    let monitorIdentity = child.pid ? procBackend.processIdentity(child.pid) : null;
    let pid = nativeProcessId(child);
    let identity: string | null = null;
    const deadline = Date.now() + 10_000;
    try {
      await supervisionReady;
      monitorIdentity = supervisedProcess?.startIdentity ?? monitorIdentity;
      pid = nativeProcessId(child);
      identity = pid ? procBackend.processIdentity(pid) : null;
      if (supervisedProcess && pid !== supervisedProcess.pid) {
        // The namespace's waiter owns the native record. This outer waiter
        // observed only the launch handle and must leave no receipt for it.
        fs.writeFileSync(path.join(directory, "host-exit.json"), JSON.stringify({ discard: true }), { mode: 0o600 });
        reclaimHostExit(supervisedProcess);
      }
      const nativeExit = () => {
        const retained = readHostExit(signalDomain(child)?.native ?? supervisedProcess)?.exit;
        if (retained) return retained;
        try { return JSON.parse(fs.readFileSync(path.join(directory, "native-exit.json"), "utf8")) as NonNullable<ReturnType<typeof readHostExit>>["exit"]; }
        catch { return null; }
      };
      const endedReason = () => {
        const exited = nativeExit();
        return exited?.signal ? `exited on signal ${exited.signal}` : exited?.code !== null && exited?.code !== undefined
          ? `exited with code ${exited.code}` : child.signalCode ? `exited on signal ${child.signalCode}` : `exited with code ${child.exitCode}`;
      };
      if (!identity && !failure && child.exitCode === null && child.signalCode === null && !nativeExit()) {
        const until = Date.now() + 1_000;
        while (!nativeExit() && child.exitCode === null && child.signalCode === null && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      if (!pid || !identity) throw startupFailure(failure ? redactBounded(failure.message, 300)
        : child.exitCode !== null || child.signalCode !== null || nativeExit() ? endedReason() : "process identity is unavailable",
      !failure && !nativeExit() && child.exitCode === null && child.signalCode === null);
      const owner = { endpoint: prefix + file, process: captureProcessIdentity(pid, undefined, identity), signalDomain: signalDomain(child), signalBoundary: signalBoundaryOff(child) };
      while (!verifiedCodexSocketOwner(owner)) {
        if (failure || child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
          const reason = failure ? redactBounded(failure.message, 300)
            : child.exitCode !== null || child.signalCode !== null ? endedReason() : "timed out after 10000ms";
          throw startupFailure(reason, fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const transport = await this.reconnect(owner);
      if (failure) { transport.disconnect(); throw failure; }
      fs.writeFileSync(path.join(directory, "attached"), "", { mode: 0o600 });
      if (drain) transport.stderrDrained = drain.finished;
      child.on("exit", () => transport.processEnded());
      child.on("close", () => transport.processEnded());
      child.unref();
      return transport;
    } catch (error) {
      const detail = await diagnostic(child.exitCode !== null || child.signalCode !== null);
      const reason = error instanceof Error ? error.message : String(error);
      const message = redactBounded(`${reason}${detail ? `; stderr: ${detail}` : ""}`, 2400);
      if (child.pid && child.exitCode === null && child.signalCode === null
        && monitorIdentity && procBackend.processIdentity(child.pid) !== null && procBackend.processIdentity(child.pid) !== monitorIdentity) {
        throw new Error(`Codex callback setup cleanup identity changed; ${message}`, { cause: error });
      }
      if (child.pid && child.exitCode === null && child.signalCode === null && (!monitorIdentity || procBackend.processIdentity(child.pid) === null || procBackend.processIdentity(child.pid) === monitorIdentity)) {
        const stopped = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
        if (pid && identity) recordHostStop(captureProcessIdentity(pid, undefined, identity), "SIGKILL", "codex-socket-startup-cleanup");
        const signalled = signalAgentDomain(child, "SIGKILL");
        if (signalled === undefined) signalProcessGroup(child.pid, "SIGKILL", process.kill);
        else if (!signalled) throw new Error(`Codex callback setup cleanup identity could not be verified; ${message}`, { cause: error });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([stopped, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Codex callback setup cleanup did not settle; ${message}`, { cause: error })), 3_000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      }
      const complete = failureMessage(reason, detail, child);
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(complete, { cause: error });
    } finally {
      closeDiagnostic();
    }
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (procBackend.processIdentity(this.pid) !== this.startIdentity || procBackend.processExited(this.pid)) return false;
    recordHostStop({ pid: this.pid, startIdentity: this.startIdentity, bootEpoch: this.bootEpoch }, String(signal), "codex-socket-kill");
    if (procBackend.processIdentity(this.pid) !== this.startIdentity) return false;
    try { process.kill(this.pid, signal); return true; } catch { return false; }
  }

  private async connect(): Promise<void> {
    const physical = verifiedSocket({ endpoint: this.endpoint, process: { pid: this.pid, startIdentity: this.startIdentity, bootEpoch: this.bootEpoch } });
    if (!physical) throw new Error("Codex callback socket changed before connection");
    // Older reviewed servers reject compression extension negotiation.
    const socket = new WebSocket(`ws+unix://${physical}:/`, { perMessageDeflate: false, handshakeTimeout: 5_000, maxPayload: 64 * 1024 * 1024 });
    this.socket = socket;
    socket.on("error", error => this.emit("error", error));
    socket.on("message", data => this.stdout.write(`${data.toString()}\n`));
    socket.on("close", () => {
      if (!this.closed) this.emit("error", new Error("Codex callback connection closed"));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Codex callback connection closed before initialization")));
    });
  }

  /** Drops only this connection, used after the owning Viewer has relinquished
   * its claim. Process retirement remains the host's identity-fenced action. */
  disconnect(): void {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.socket?.terminate();
  }

  private processEnded(): void {
    if (this.closed) return;
    const process = { pid: this.pid, startIdentity: this.startIdentity, bootEpoch: this.bootEpoch };
    if (processIdentityStatus(process) === "alive") return;
    if (hostExitWriterPending(process)) return;
    // A detached native waiter persists before its launcher exits. Polling
    // can notice the native death first; keep polling until that write lands.
    let retained = readHostExit(process)?.exit;
    if (!retained) {
      // A pre-upgrade or externally launched listener has no retained waiter.
      if (!this.durableExitExpected || hostExitWriterRegistered(process)) {
        recordHostExit(process, null, null);
        retained = readHostExit(process)?.exit;
      }
    }
    // Replacing the owning row can already have transferred this receipt
    // into launch history. A late local callback must not recreate its files.
    const { code, signal } = retained ?? { code: null, signal: null };
    // Remove only the private directory this connection originally verified.
    const file = codexSocketPath(this.endpoint)!;
    if (procBackend.processIdentity(this.pid) !== this.startIdentity) {
      try {
        const directory = fs.lstatSync(path.dirname(file));
        if (directory.ino === this.directoryIdentity.ino && directory.dev === this.directoryIdentity.dev) {
          const entry = fs.lstatSync(file, { throwIfNoEntry: false });
          if (entry?.isSocket() || entry?.isSymbolicLink()) fs.unlinkSync(file);
          fs.rmdirSync(path.dirname(file));
        }
      } catch { /* A replaced directory or retained foreign file stays in place. */ }
    }
    if (this.closed) return;
    this.disconnect();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
