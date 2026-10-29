// One background recorder, any number of resumable foreground waits. Admission
// and descendant cleanup remain with the unmodified command path in gate-slot.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited } from "../src/lib/runtime/signalSandboxContext";
import { descriptorDigest, manifestSchema, readEnvelope, writeEnvelope, verifyManifest, physical, reportSchema, producerCommandIdentity, custodyClock, type Descriptor, type Terminal } from "../src/lib/recordedChecks/wire";
export { buildManifest } from "../src/lib/recordedChecks/wire";

// Leave one minute of the engines' ten-minute foreground window for startup
// and printing the final state and tail. Custom waits share this ceiling.
const MAX_WAIT_MS = 9 * 60_000;
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
export async function waitForGate(log: string, timeoutMs = MAX_WAIT_MS): Promise<ReturnType<typeof gateSnapshot>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error("invalid wait deadline");
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

export async function recordGate(log: string, command: string[], manifestFile?: string): Promise<number> {
  const manifest = manifestFile ? manifestSchema.parse(readEnvelope(manifestFile)) : null;
  if (manifest) {
    await verifyManifest(manifest);
    if (manifest.deadline <= Date.now() || manifest.cwd !== process.cwd()) throw new Error("recorded check has an expired deadline or different cwd");
    if (!manifest.roots.some(root => root.purpose === "evidence" && log.startsWith(root.directory + path.sep))) throw new Error("recorded log is outside its registered roots");
  }
  const dir = directory(log);
  // Exclusive creation makes this log an immutable run identity. Never replace
  // an earlier run or accidentally truncate an existing caller's output.
  fs.mkdirSync(dir, { mode: 0o700 });
  let fd: number;
  try { fd = fs.openSync(log, "ax", 0o600); }
  catch (error) { fs.rmdirSync(dir); throw error; }
  try { fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(cpuOwnerIdentity(process.pid)), { mode: 0o600 }); }
  catch (error) { fs.closeSync(fd); throw error; }
  let descriptor: Descriptor | null = null;
  if (manifest) {
    const input = { version: 1 as const, runId: randomBytes(32).toString("hex"), manifest, argv: command,
      recorder: cpuOwnerIdentity(process.pid) as Descriptor["recorder"], directoryIdentity: physical(dir), startedAt: Date.now(),
      deadlineUptimeMs: custodyClock() + Math.max(0, manifest.deadline - Date.now()) };
    descriptor = { ...input, wrapper: null, descriptorDigest: descriptorDigest(input) };
    writeEnvelope(path.join(dir, "descriptor.json"), descriptor);
  }
  let code = 127;
  let wrapperSignal: string | null = null;
  let cancellation: Terminal["cancellation"] = null;
  const originalRemaining = descriptor ? Math.max(0, descriptor.deadlineUptimeMs - custodyClock()) : Infinity;
  const monotonicDeadline = performance.now() + originalRemaining;
  const inheritedAllowance = Number(process.env.LLV_OWNED_RUN_TIMEOUT_MS ?? 900_000);
  const executionAllowance = Math.min(manifest?.executionMs ?? Infinity,
    Number.isFinite(inheritedAllowance) && inheritedAllowance > 0 ? inheritedAllowance : 900_000);
  try {
    const child = spawn("bash", [path.join(import.meta.dir, "gate-slot.sh"), ...command], {
      stdio: ["ignore", fd, "pipe"],
      env: { ...process.env, LLV_GATE_WAIT_STARTED: path.join(dir, "running"), ...(descriptor ? {
        LLV_RECORDED_CHECK_DIRECTORY: dir, LLV_RECORDED_CHECK_ID: descriptor.runId,
        LLV_GATE_RUNNER: "off", LLV_OWNED_RUN_TIMEOUT_MS: String(executionAllowance),
      } : {}) },
    });
    if (descriptor) {
      descriptor.wrapper = producerCommandIdentity(child.pid) as Descriptor["recorder"] | null;
      writeEnvelope(path.join(dir, "descriptor.json"), descriptor);
    }
    console.log("gate-slot: recording started");
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
    const cancel = (reason: NonNullable<Terminal["cancellation"]>["reason"], signal: NodeJS.Signals) => {
      cancellation ??= { reason, at: Date.now() };
      if (descriptor) writeEnvelope(path.join(dir, "cancellation.json"), cancellation);
      child.kill(signal);
    };
    const terminate = () => cancel("SIGTERM", "SIGTERM");
    const interrupt = () => cancel("SIGINT", "SIGINT");
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      const remaining = monotonicDeadline - performance.now();
      if (remaining <= 0) cancel("deadline", "SIGTERM");
      else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    if (manifest) armDeadline();
    process.on("SIGTERM", terminate); process.on("SIGINT", interrupt);
    try {
      code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exit, signal) => { wrapperSignal = signal; resolve(exit ?? 128 + (signal ? constants.signals[signal] : 0)); });
      });
    } finally { clearTimeout(deadlineTimer); process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); }
  } catch (error) {
    fs.writeSync(fd, `gate recorder: ${error instanceof Error ? error.message : error}\n`);
  } finally { fs.closeSync(fd); }
  // Publish only after the owned gate has finished cleanup and closed output.
  if (descriptor) {
    let report = null;
    const reports: Terminal["reports"] = [];
    try { report = reportSchema.parse(readEnvelope(path.join(dir, "supervisor.json"))); } catch { /* Missing close proof stays unknown. */ }
    for (const kind of ["portable", "service", "namespace"]) {
      try {
        const entry = reportSchema.parse(readEnvelope(path.join(dir, `${kind}.json`)));
        if (entry.runId === descriptor.runId && entry.descriptorDigest === descriptor.descriptorDigest) reports.push(entry);
      } catch { /* A path unused by this invocation has no producer. */ }
    }
    // The namespace producer owns the command inside its boundary. Preserve
    // the service's separate close and require both cleanup receipts.
    const command = reports.find(entry => entry.kind === "namespace") ?? report;
    if (command) report = { ...command, cleanup: reports.length > 0 && reports.every(entry => entry.phase === "close" && entry.cleanup === "confirmed")
      ? "confirmed" as const : "unknown" as const };
    if (report?.boundary === "namespace" && !reports.some(entry => entry.kind === "namespace"))
      report = { ...report, command: null, commandExit: null, commandSignal: null };
    writeEnvelope(path.join(dir, "result.json"), { version: 1, runId: descriptor.runId, descriptorDigest: descriptor.descriptorDigest,
      wrapperExit: code, wrapperSignal, cancellation, closedAt: Date.now(), report, reports } satisfies Terminal);
  }
  fs.writeFileSync(path.join(dir, "exit.tmp"), `${code}\n`, { mode: 0o600 });
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
  return code;
}

if (import.meta.main) {
  try {
    const [mode, filename, ...args] = process.argv.slice(2);
    if (!filename) throw new Error("usage: gate-slot.sh --record LOG command [args...] | --wait LOG [timeout-seconds]");
    const log = path.resolve(filename);
    if (mode === "--record" && args.length) {
      const manifestFile = args[0] === "--manifest" ? args[1] : undefined;
      if (args[0] === "--manifest" && (!manifestFile || args[2] !== "--")) throw new Error("manifest recording requires --manifest FILE -- COMMAND");
      process.exitCode = await recordGate(log, manifestFile ? args.slice(3) : args, manifestFile);
    }
    else if (mode === "--wait" && args.length <= 1) {
      const ms = args[0] === undefined ? undefined : Number(args[0]) * 1000;
      const result = await waitForGate(log, ms);
      console.log(`gate-slot: ${result.state} | tail=${JSON.stringify(result.tail)}`);
      process.exitCode = result.code;
    } else throw new Error("invalid gate wait arguments");
  } catch (error) {
    console.error(`gate-slot: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
