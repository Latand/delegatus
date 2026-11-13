// Read-only gate completion waits, shared by the runtime host and gate CLI.
import fs from "node:fs";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited } from "./signalSandboxContext";
import { CUSTODY_CLEANUP_MS, identitySchema, custodyClock } from "../recordedChecks/wire";

// Leave one minute of the engines' ten-minute foreground window for startup
// and printing the final state and tail. Custom waits share this ceiling.
const MAX_WAIT_MS = 9 * 60_000;
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

function readDirectFile(directoryFd: number, name: string): string | null {
  let fd: number;
  try { fd = fs.openSync(`/proc/self/fd/${directoryFd}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error(`invalid gate ${name}`);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

export function gateSnapshot(log: string, directoryFd?: number): { state: string; code: number; tail: string } {
  const ownedFd = directoryFd === undefined;
  const dirFd = directoryFd ?? fs.openSync(directory(log), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
  const ownerText = readDirectFile(dirFd, "owner.json");
  if (ownerText === null) throw new Error("unknown gate log (no recording ticket)");
  const owner = JSON.parse(ownerText);
  const ownerAlive = cpuOwnerStatus(owner) === "alive" && !cpuOwnerExited(owner);
  const logFd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let tail: string;
  try {
    const stat = fs.fstatSync(logFd);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) throw new Error("invalid gate log");
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    fs.readSync(logFd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    tail = buffer.toString("utf8").trimEnd().split("\n").slice(-20).join("\n");
  } finally { fs.closeSync(logFd); }
  const result = readDirectFile(dirFd, "exit");
  if (result !== null) {
    if (!/^\d+\n$/.test(result) || Number(result) > 255) throw new Error("invalid gate exit record");
    return { state: `finished exit=${Number(result)}`, code: Number(result), tail };
  }
  if (!ownerAlive) {
    throw new Error("gate recorder ownership unavailable; no exit result recorded");
  }
  if (readDirectFile(dirFd, "running") !== null) return { state: "running", code: 124, tail };
  const reason = readDirectFile(dirFd, "queued") ?? tail.split("\n").findLast(line => line.startsWith("gate-slot: Waiting"));
  // A slot-only wait is eligible at the head of the CPU queue; the admission
  // helper prints an ordinal when pressure or another ticket holds it back.
  const position = reason?.match(/\b(\d+)(?:st|nd|rd|th)\b/)?.[1]
    ?? (reason?.startsWith("gate-slot: Waiting for a heavy command slot") ? "1" : "pending");
  return { state: `queued position=${position} reason=${reason?.slice("gate-slot: ".length) ?? "admission starting"}`, code: 124, tail };
  } finally { if (ownedFd) fs.closeSync(dirFd); }
}

/** Subscribe before checking so a completion racing the first read wakes us.
 * Only the final snapshot reads the tail; log activity does not extend the bound. */
export async function waitForGate(log: string, timeoutMs = MAX_WAIT_MS): Promise<ReturnType<typeof gateSnapshot>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error("invalid wait deadline");
  return observeGate(log, timeoutMs);
}

async function observeGate(log: string, timeoutMs: number, signal?: AbortSignal): Promise<ReturnType<typeof gateSnapshot>> {
  const dirFd = fs.openSync(directory(log), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const dir = `/proc/self/fd/${dirFd}`;
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: fs.FSWatcher | undefined;
    let settled = false;
    const closeDirectory = () => { if (!settled) { settled = true; fs.closeSync(dirFd); } };
    const finish = () => {
      if (settled) return;
      clearTimeout(timer); watcher?.close(); signal?.removeEventListener("abort", abort);
      try { resolve(gateSnapshot(log, dirFd)); } catch (error) { reject(error); }
      finally { closeDirectory(); }
    };
    const abort = () => {
      if (settled) return;
      clearTimeout(timer); watcher?.close(); signal?.removeEventListener("abort", abort);
      closeDirectory(); reject(new Error("gate completion wait cancelled; command result unknown"));
    };
    try {
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      watcher = fs.watch(dir, (_event, name) => { if ((!name || name.toString() === "exit") && readDirectFile(dirFd, "exit") !== null) finish(); });
      watcher.on("error", error => {
        if (settled) return;
        clearTimeout(timer); watcher?.close(); signal?.removeEventListener("abort", abort);
        closeDirectory(); reject(error);
      });
      const deadline = performance.now() + timeoutMs;
      const arm = () => {
        const remaining = Math.max(0, deadline - performance.now());
        timer = setTimeout(remaining > 2_147_483_647 ? arm : finish, Math.min(remaining, 2_147_483_647));
      };
      arm();
      // An already finished run returns immediately, including after restart.
      if (readDirectFile(dirFd, "exit") !== null) finish();
      else {
        const owner = readDirectFile(dirFd, "owner.json");
        if (owner === null) throw new Error("unknown gate log (no recording ticket)");
        if (cpuOwnerStatus(JSON.parse(owner)) !== "alive") finish();
      }
    } catch (error) {
      if (settled) return;
      clearTimeout(timer); watcher?.close(); signal?.removeEventListener("abort", abort);
      closeDirectory(); reject(error);
    }
  });
}

/** One engine callback, through queueing, execution and cleanup. The recorder
 * pins the original deadline; callers cannot extend it by asking again. */
export async function waitForGateCompletion(log: string, signal?: AbortSignal): Promise<ReturnType<typeof gateSnapshot>> {
  const dirFd = fs.openSync(directory(log), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(dirFd);
  if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid()) { fs.closeSync(dirFd); throw new Error("invalid gate directory"); }
  const directoryIdentity = `${stat.dev}:${stat.ino}`;
  const ticketText = readDirectFile(dirFd, "completion.json");
  const ticket = ticketText === null ? null : JSON.parse(ticketText) as { deadlineUptimeMs: number; recorder: unknown; directoryIdentity: string };
  if (!ticket || !Number.isFinite(ticket.deadlineUptimeMs) || !identitySchema.safeParse(ticket.recorder).success
    || ticket.directoryIdentity !== directoryIdentity) { fs.closeSync(dirFd); throw new Error("invalid gate completion ticket"); }
  const original = JSON.stringify(ticket);
  const validate = () => {
    const ownerText = readDirectFile(dirFd, "owner.json");
    const completionText = readDirectFile(dirFd, "completion.json");
    const owner = identitySchema.parse(ownerText === null ? null : JSON.parse(ownerText));
    if (JSON.stringify(owner) !== JSON.stringify(ticket.recorder)
      || `${fs.fstatSync(dirFd).dev}:${fs.fstatSync(dirFd).ino}` !== directoryIdentity || JSON.stringify(completionText === null ? null : JSON.parse(completionText)) !== original
      || owner.bootEpoch !== cpuOwnerIdentity(process.pid).bootEpoch) throw new Error("gate completion ticket identity changed");
  };
  try {
    validate();
    const remaining = Math.max(0, ticket.deadlineUptimeMs + CUSTODY_CLEANUP_MS - custodyClock());
    const result = await observeGate(log, remaining, signal);
    validate();
    return result;
  } finally { fs.closeSync(dirFd); }
}
