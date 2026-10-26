// One background recorder, any number of resumable foreground waits. Admission
// and descendant cleanup remain with the unmodified command path in gate-slot.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited } from "../src/lib/runtime/signalSandboxContext";

const DEFAULT_WAIT_MS = 9 * 60_000;
const TAIL_BYTES = 16_384;
const directory = (log: string) => `${log}.gate`;

export function logTail(log: string): string {
  const fd = fs.openSync(log, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString("utf8").trimEnd().split("\n").slice(-20).join("\n");
  } finally { fs.closeSync(fd); }
}

export function gateSnapshot(log: string): { state: string; code: number; tail: string } {
  const dir = directory(log);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  const ownerAlive = cpuOwnerStatus(owner) === "alive" && !cpuOwnerExited(owner);
  const tail = logTail(log);
  if (fs.existsSync(path.join(dir, "exit"))) {
    const result = fs.readFileSync(path.join(dir, "exit"), "utf8");
    if (!/^\d+\n$/.test(result) || Number(result) > 255) throw new Error("invalid gate exit record");
    return { state: `finished exit=${Number(result)}`, code: Number(result), tail };
  }
  if (!ownerAlive) {
    throw new Error("gate recorder ownership unavailable; no exit result recorded");
  }
  if (fs.existsSync(path.join(dir, "running"))) return { state: "running", code: 124, tail };
  const queued = path.join(dir, "queued");
  const reason = fs.existsSync(queued) ? fs.readFileSync(queued, "utf8")
    : tail.split("\n").findLast(line => line.startsWith("gate-slot: Waiting"));
  // A slot-only wait is eligible at the head of the CPU queue; the admission
  // helper prints an ordinal when pressure or another ticket holds it back.
  const position = reason?.match(/\b(\d+)(?:st|nd|rd|th)\b/)?.[1]
    ?? (reason?.startsWith("gate-slot: Waiting for a heavy command slot") ? "1" : "pending");
  return { state: `queued position=${position} reason=${reason?.slice("gate-slot: ".length) ?? "admission starting"}`, code: 124, tail };
}

/** Subscribe before checking so a completion racing the first read wakes us.
 * Only the final snapshot reads the tail; log activity does not extend the bound. */
export async function waitForGate(log: string, timeoutMs = DEFAULT_WAIT_MS): Promise<ReturnType<typeof gateSnapshot>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) throw new Error("invalid wait deadline");
  const dir = directory(log);
  if (!fs.existsSync(path.join(dir, "owner.json"))) throw new Error("unknown gate log (no recording ticket)");
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: fs.FSWatcher | undefined;
    const finish = () => {
      clearTimeout(timer); watcher?.close();
      try { resolve(gateSnapshot(log)); } catch (error) { reject(error); }
    };
    try {
      watcher = fs.watch(dir, (_event, name) => { if ((!name || name.toString() === "exit") && fs.existsSync(path.join(dir, "exit"))) finish(); });
      watcher.on("error", error => { clearTimeout(timer); watcher?.close(); reject(error); });
      timer = setTimeout(finish, timeoutMs);
      // An already finished run returns immediately, including after restart.
      if (fs.existsSync(path.join(dir, "exit"))) finish();
      else if (cpuOwnerStatus(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"))) !== "alive") finish();
    } catch (error) { clearTimeout(timer); watcher?.close(); reject(error); }
  });
}

async function record(log: string, command: string[]): Promise<number> {
  const dir = directory(log);
  // Exclusive creation makes this log an immutable run identity. Never replace
  // an earlier run or accidentally truncate an existing caller's output.
  fs.mkdirSync(dir, { mode: 0o700 });
  let fd: number;
  try { fd = fs.openSync(log, "ax", 0o600); }
  catch (error) { fs.rmdirSync(dir); throw error; }
  try { fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(cpuOwnerIdentity(process.pid)), { mode: 0o600 }); }
  catch (error) { fs.closeSync(fd); throw error; }
  console.log("gate-slot: recording started");
  let code = 127;
  try {
    const child = spawn("bash", [path.join(import.meta.dir, "gate-slot.sh"), ...command], {
      stdio: ["ignore", fd, "pipe"],
      env: { ...process.env, LLV_GATE_WAIT_STARTED: path.join(dir, "running") },
    });
    // Retain admission detail independently of the bounded log tail: lock
    // diagnostics can otherwise push the latest position out of that tail.
    const decoder = new StringDecoder("utf8");
    let partial = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      fs.writeSync(fd, chunk);
      const lines = (partial + decoder.write(chunk)).split("\n");
      partial = lines.pop()!.slice(-TAIL_BYTES);
      for (const line of lines) if (line.startsWith("gate-slot: Waiting")) {
        fs.writeFileSync(path.join(dir, "queued.tmp"), line, { mode: 0o600 });
        fs.renameSync(path.join(dir, "queued.tmp"), path.join(dir, "queued"));
      }
    });
    const terminate = () => { child.kill("SIGTERM"); };
    const interrupt = () => { child.kill("SIGINT"); };
    process.on("SIGTERM", terminate); process.on("SIGINT", interrupt);
    try {
      code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exit, signal) => resolve(exit ?? 128 + (signal ? constants.signals[signal] : 0)));
      });
    } finally { process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); }
  } catch (error) {
    fs.writeSync(fd, `gate recorder: ${error instanceof Error ? error.message : error}\n`);
  } finally { fs.closeSync(fd); }
  // Publish only after the owned gate has finished cleanup and closed output.
  fs.writeFileSync(path.join(dir, "exit.tmp"), `${code}\n`, { mode: 0o600 });
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
  return code;
}

if (import.meta.main) {
  try {
    const [mode, filename, ...args] = process.argv.slice(2);
    if (!filename) throw new Error("usage: gate-slot.sh --record LOG command [args...] | --wait LOG [timeout-seconds]");
    const log = path.resolve(filename);
    if (mode === "--record" && args.length) process.exitCode = await record(log, args);
    else if (mode === "--wait" && args.length <= 1) {
      const ms = args[0] === undefined ? DEFAULT_WAIT_MS : Number(args[0]) * 1000;
      if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) throw new Error("invalid wait deadline");
      const result = await waitForGate(log, ms);
      console.log(`gate-slot: ${result.state} | tail=${JSON.stringify(result.tail)}`);
      process.exitCode = result.code;
    } else throw new Error("invalid gate wait arguments");
  } catch (error) {
    console.error(`gate-slot: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
