// Read-only gate completion waits, shared by the runtime host and gate CLI.
import fs from "node:fs";
import path from "node:path";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited } from "./signalSandboxContext";
import { CUSTODY_CLEANUP_MS, identitySchema, readEnvelope, physical, custodyClock } from "../recordedChecks/wire";

// Leave one minute of the engines' ten-minute foreground window for startup
// and printing the final state and tail. Custom waits share this ceiling.
const MAX_WAIT_MS = 9 * 60_000;
const COMPLETION_RECHECK_MS = 1000;
const TAIL_BYTES = 16_384;
const directory = (log: string) => `${log}.gate`;

export function logTail(log: string): string {
  const fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error("invalid gate log");
    const size = stat.size;
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
 * Recheck the exit path if filesystem notifications are lost. Only the final
 * snapshot reads the tail; log activity does not extend the bound. */
export async function waitForGate(log: string, timeoutMs = MAX_WAIT_MS): Promise<ReturnType<typeof gateSnapshot>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error("invalid wait deadline");
  return observeGate(log, timeoutMs);
}

async function observeGate(log: string, timeoutMs: number, signal?: AbortSignal): Promise<ReturnType<typeof gateSnapshot>> {
  const dir = directory(log);
  if (!fs.existsSync(path.join(dir, "owner.json"))) throw new Error("unknown gate log (no recording ticket)");
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: fs.FSWatcher | undefined;
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer); watcher?.close(); signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => { if (!settled) { cleanup(); reject(error); } };
    const finish = () => {
      if (settled) return;
      cleanup();
      try { resolve(gateSnapshot(log)); } catch (error) { reject(error); }
    };
    const abort = () => fail(new Error("gate completion wait cancelled; command result unknown"));
    try {
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      watcher = fs.watch(dir, (_event, name) => { if ((!name || name.toString() === "exit") && fs.existsSync(path.join(dir, "exit"))) finish(); });
      watcher.on("error", fail);
      const deadline = performance.now() + timeoutMs;
      const arm = () => {
        if (settled) return;
        const remaining = Math.max(0, deadline - performance.now());
        if (remaining === 0 || fs.existsSync(path.join(dir, "exit"))) { finish(); return; }
        timer = setTimeout(arm, Math.min(remaining, COMPLETION_RECHECK_MS));
      };
      arm();
      // An already finished run returns immediately, including after restart.
      if (fs.existsSync(path.join(dir, "exit"))) finish();
      else if (cpuOwnerStatus(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"))) !== "alive") finish();
    } catch (error) { fail(error); }
  });
}

/** One engine callback, through queueing, execution and cleanup. The recorder
 * pins the original deadline; callers cannot extend it by asking again. */
export async function waitForGateCompletion(log: string, signal?: AbortSignal): Promise<ReturnType<typeof gateSnapshot>> {
  log = path.join(fs.realpathSync(path.dirname(log)), path.basename(log));
  const dir = directory(log);
  const directoryIdentity = physical(dir);
  const ticket = readEnvelope(path.join(dir, "completion.json")) as { deadlineUptimeMs: number; recorder: unknown; directoryIdentity: string };
  if (!ticket || !Number.isFinite(ticket.deadlineUptimeMs) || !identitySchema.safeParse(ticket.recorder).success
    || ticket.directoryIdentity !== directoryIdentity) throw new Error("invalid gate completion ticket");
  const original = JSON.stringify(ticket);
  const validate = () => {
    const owner = identitySchema.parse(readEnvelope(path.join(dir, "owner.json")));
    if (JSON.stringify(owner) !== JSON.stringify(ticket.recorder)
      || physical(dir) !== directoryIdentity || JSON.stringify(readEnvelope(path.join(dir, "completion.json"))) !== original
      || owner.bootEpoch !== cpuOwnerIdentity(process.pid).bootEpoch) throw new Error("gate completion ticket identity changed");
  };
  validate();
  const remaining = Math.max(0, ticket.deadlineUptimeMs + CUSTODY_CLEANUP_MS - custodyClock());
  const result = await observeGate(log, remaining, signal);
  validate();
  return result;
}
