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
import { PRIVATE_KEY_BLOCK } from "@/lib/view/compactText";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { signalProcessGroup } from "@/lib/processGroup";
import type { ProcessIdentity } from "@/lib/agent/registry";
import { bindSignalDomain, nativeProcessId, normalizeSignalBoundaryOff, recordSignalBoundaryOff, signalAgentDomain, signalBoundaryOff, signalDomain, type AgentSignalDomain, type SignalBoundaryOff } from "./agentSignalSandbox";

export interface CodexSocketOwner { endpoint: string; process: ProcessIdentity; signalDomain?: AgentSignalDomain; signalBoundary?: SignalBoundaryOff }
export type CodexTransport = Pick<ChildProcessWithoutNullStreams, "pid" | "stdin" | "stdout" | "stderr" | "kill"> & EventEmitter;
const prefix = "codex-unix:";

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

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** Bytes of native stderr kept for a startup diagnostic. Everything after is discarded. */
const STDERR_KEEP_BYTES = 16 * 1024;
const STDERR_READ_BYTES = 8192;

/** A key block whose footer was clipped (or never printed) matches no complete-block
 * pattern, so its payload is cut from the header on before redaction sees the text. */
function withoutUnterminatedSecret(text: string): string {
  const complete = text.replace(PRIVATE_KEY_BLOCK, "[redacted]");
  const header = PRIVATE_KEY_HEADER.exec(complete);
  return header ? `${complete.slice(0, header.index)}[redacted]` : complete;
}

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
    // dd copies the first bytes unbuffered; cat then discards the rest.
    const script = `umask 077; exec 3<"$1" 4>"$2" || exit 1; echo ready; exec >/dev/null
trap '' HUP; dd bs=1 count="$3" <&3 >&4 2>/dev/null; cat <&3 >/dev/null`;
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
  private socket: WebSocket | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly directoryIdentity: { ino: number; dev: number };

  private constructor(owner: CodexSocketOwner) {
    super();
    this.pid = owner.process.pid;
    this.startIdentity = owner.process.startIdentity!;
    this.bootEpoch = owner.process.bootEpoch!;
    this.endpoint = owner.endpoint;
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
      // Keep the first complete lines: cutting a raw tail can expose a suffix
      // of a credential whose prefix fell outside the retained bytes.
      const bytes = Buffer.alloc(Math.min(size, STDERR_READ_BYTES));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
      let text = bytes.toString("utf8");
      if (size > bytes.length) text = text.slice(0, Math.max(0, text.lastIndexOf("\n"))) + "\n[stderr clipped]";
      return redactBounded(withoutUnterminatedSecret(text), 2048);
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
    const base = (binary: string, argv: string[], env: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams => {
      // Keep native stdio independent of the Viewer: a bounded drain outlives it.
      // A wrapper reads its own diagnostic name back after its setup fails.
      if (writer !== null && env.env?.LLV_SIGNAL_DIAGNOSTIC) fs.symlinkSync(diagnosticFile, env.env.LLV_SIGNAL_DIAGNOSTIC);
      let child: ReturnType<typeof spawn>;
      try { child = spawn(binary, argv, { ...env, stdio: ["ignore", "ignore", writer ?? "ignore"] }); }
      finally {
        if (writer !== null) fs.closeSync(writer);
        writer = null;
      }
      const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
      // Bun exposes read-only stream properties. The memory-cell adapter needs
      // stream handles, while the native process itself keeps no Viewer pipes.
      return new Proxy(child, { get(target, key) {
        if (key === "stdin" || key === "stdout" || key === "stderr") return streams[key];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }) as ChildProcessWithoutNullStreams;
    };
    let child: ChildProcessWithoutNullStreams;
    try { child = launch ? await launch(command, [...args, "--listen", `unix://${file}`],
      { ...options, env: { ...(options.env ?? process.env), LLV_SIGNAL_IGNORE_NATIVE_STDIO: "1" } }, base)
      : (wrap ? wrap(base) : base)(command, [...args, "--listen", `unix://${file}`], options); }
    catch (error) {
      const detail = await diagnostic(true);
      closeDiagnostic();
      fs.rmdirSync(directory);
      throw new Error(redactBounded(`${error instanceof Error ? error.message : String(error)}${detail ? `; stderr: ${detail}` : ""}`, 2400));
    }
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    // spawn reports errors such as ENOENT on the next turn, without a pid.
    if (!child.pid) await new Promise<void>(resolve => setImmediate(resolve));
    const monitorIdentity = child.pid ? procBackend.processIdentity(child.pid) : null;
    const pid = nativeProcessId(child);
    const identity = pid ? procBackend.processIdentity(pid) : null;
    try {
      if (!pid || !identity) throw startupFailure(failure ? redactBounded(failure.message, 300)
        : child.exitCode !== null ? `exited with code ${child.exitCode}`
          : child.signalCode !== null ? `exited on signal ${child.signalCode}` : "process identity is unavailable",
      !failure && child.exitCode === null && child.signalCode === null);
      const owner = { endpoint: prefix + file, process: captureProcessIdentity(pid, undefined, identity), signalDomain: signalDomain(child), signalBoundary: signalBoundaryOff(child) };
      const deadline = Date.now() + 10_000;
      while (!verifiedCodexSocketOwner(owner)) {
        if (failure || child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
          const reason = failure ? redactBounded(failure.message, 300)
            : child.exitCode !== null ? `exited with code ${child.exitCode}`
              : child.signalCode !== null ? `exited on signal ${child.signalCode}` : "timed out after 10000ms";
          throw startupFailure(reason, fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const transport = await this.reconnect(owner);
      child.on("close", () => transport.processEnded());
      child.unref();
      return transport;
    } catch (error) {
      const detail = await diagnostic(child.exitCode !== null || child.signalCode !== null);
      const message = redactBounded(`${error instanceof Error ? error.message : String(error)}${detail ? `; stderr: ${detail}` : ""}`, 2400);
      if (child.pid && child.exitCode === null && child.signalCode === null
        && monitorIdentity && procBackend.processIdentity(child.pid) !== monitorIdentity) {
        throw new Error(`Codex callback setup cleanup identity changed; ${message}`, { cause: error });
      }
      if (child.pid && child.exitCode === null && child.signalCode === null && (!monitorIdentity || procBackend.processIdentity(child.pid) === monitorIdentity)) {
        const stopped = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
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
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(message, { cause: error });
    } finally {
      closeDiagnostic();
    }
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
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
    this.emit("exit");
    this.emit("close");
  }
}
