import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import WebSocket from "ws";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { signalProcessGroup } from "@/lib/processGroup";
import type { ProcessIdentity } from "@/lib/agent/registry";

export interface CodexSocketOwner { endpoint: string; process: ProcessIdentity }
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
  ): Promise<CodexSocketTransport> {
    const root = path.join(process.env.HOME ?? os.homedir(), ".cache", "delegatus", "s");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (Buffer.byteLength(root) > 72) throw new Error("Codex callback socket directory exceeds the native socket path limit");
    const directory = fs.mkdtempSync(path.join(root, "dlg-codex-"));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "rpc.sock");
    const base = (binary: string, argv: string[], env: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams => {
      const child = spawn(binary, argv, { ...env, stdio: "ignore" });
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
    try { child = (wrap ? wrap(base) : base)(command, [...args, "--listen", `unix://${file}`], options); }
    catch (error) { fs.rmdirSync(directory); throw error; }
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    const identity = child.pid ? procBackend.processIdentity(child.pid) : null;
    try {
      if (!child.pid || !identity) throw failure ?? new Error("Codex callback process identity is unavailable");
      const owner = { endpoint: prefix + file, process: captureProcessIdentity(child.pid, undefined, identity) };
      const deadline = Date.now() + 10_000;
      while (!verifiedCodexSocketOwner(owner)) {
        if (failure || child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw failure ?? new Error("Codex callback listener did not start or its ownership could not be verified");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const transport = await this.reconnect(owner);
      child.on("close", () => transport.processEnded());
      child.unref();
      return transport;
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null && (!identity || procBackend.processIdentity(child.pid) === identity)) {
        signalProcessGroup(child.pid, "SIGKILL", process.kill);
        await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
      }
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
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
