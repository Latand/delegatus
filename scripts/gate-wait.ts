import { retainForegroundCheckTiming } from "../src/lib/recordedChecks/timing";
// One background recorder, any number of resumable foreground waits. Admission
// and descendant cleanup remain with the unmodified command path in gate-slot.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { descriptorDigest, manifestSchema, readEnvelope, writeEnvelope, verifyManifest, physical, reportSchema, producerCommandIdentity, custodyClock, type Descriptor, type Terminal } from "../src/lib/recordedChecks/wire";
export { buildManifest } from "../src/lib/recordedChecks/wire";

import { waitForGate } from "../src/lib/runtime/gateWait";
export { waitForGate, waitForGateCompletion, gateSnapshot, logTail } from "../src/lib/runtime/gateWait";

// A native dynamic tool can hold a model call beyond the exec tool's yield.
// This is a foreground hold, with no claim of custody across a stage exit.
export const COMPLETION_WAIT_MS = 4 * 60 * 60_000;
const TAIL_BYTES = 16_384;
const directory = (log: string) => `${log}.gate`;

/** Only a closed producer observation contributes time; an unavailable
 * observation source cannot change execution or the terminal check receipt. */
export function closedQueueSpans(directory: string | null): { start: number; end: number }[] | undefined {
  if (!directory) return undefined;
  try {
    return fs.readdirSync(directory).filter(name => name.endsWith(".json")).sort().slice(0, 256).flatMap(name => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        return value.closed === true && Number.isFinite(value.start) && Number.isFinite(value.end) && value.end >= value.start
          ? [{ start: value.start as number, end: value.end as number }] : [];
      } catch { return []; }
    });
  } catch { return undefined; }
}

export async function recordGate(log: string, command: string[], manifestFile?: string): Promise<number> {
  log = path.join(fs.realpathSync(path.dirname(log)), path.basename(log));
  const manifest = manifestFile ? manifestSchema.parse(readEnvelope(manifestFile)) : null;
  if (manifest) {
    await verifyManifest(manifest);
    if (manifest.deadlineUptimeMs <= custodyClock() || manifest.clockBootEpoch !== cpuOwnerIdentity(process.pid).bootEpoch
      || manifest.cwd !== process.cwd()) throw new Error("recorded check has an expired deadline, changed boot or different cwd");
    if (!manifest.roots.some(root => root.purpose === "evidence" && log.startsWith(root.directory + path.sep))) throw new Error("recorded log is outside its registered roots");
  }
  const dir = directory(log);
  // Exclusive creation makes this log an immutable run identity. Never replace
  // an earlier run or accidentally truncate an existing caller's output.
  fs.mkdirSync(dir, { mode: 0o700 });
  let fd: number;
  try { fd = fs.openSync(log, "ax", 0o600); }
  catch (error) { fs.rmdirSync(dir); throw error; }
  try { writeEnvelope(path.join(dir, "owner.json"), cpuOwnerIdentity(process.pid)); }
  catch (error) { fs.closeSync(fd); throw error; }
  let descriptor: Descriptor | null = null;
  if (manifest) {
    const input = { version: 1 as const, runId: randomBytes(32).toString("hex"), manifest, argv: command,
      recorder: cpuOwnerIdentity(process.pid) as Descriptor["recorder"], directoryIdentity: physical(dir), startedAt: Date.now(),
      startedUptimeMs: custodyClock(), deadlineUptimeMs: manifest.deadlineUptimeMs };
    descriptor = { ...input, wrapper: null, descriptorDigest: descriptorDigest(input) };
    writeEnvelope(path.join(dir, "descriptor.json"), descriptor);
  }
  let queueTiming: string | null = path.join(dir, "queue-timing");
  try { if (queueTiming) fs.mkdirSync(queueTiming, { mode: 0o700 }); }
  catch { queueTiming = null; }
  let code = 127;
  let wrapperSignal: string | null = null;
  let cancellation: Terminal["cancellation"] = null;
  const deadlineUptimeMs = descriptor?.deadlineUptimeMs ?? custodyClock() + COMPLETION_WAIT_MS;
  fs.writeFileSync(path.join(dir, "completion.json"), JSON.stringify({ recorder: cpuOwnerIdentity(process.pid), directoryIdentity: physical(dir), deadlineUptimeMs }), { mode: 0o600, flag: "wx" });
  const originalRemaining = Math.max(0, deadlineUptimeMs - custodyClock());
  const monotonicDeadline = performance.now() + originalRemaining;
  const inheritedAllowance = Number(process.env.LLV_OWNED_RUN_TIMEOUT_MS ?? 900_000);
  const executionAllowance = Math.min(manifest?.executionMs ?? Infinity,
    Number.isFinite(inheritedAllowance) && inheritedAllowance > 0 ? inheritedAllowance : 900_000);
  try {
    const child = spawn("bash", [path.join(import.meta.dir, "gate-slot.sh"), ...command], {
      stdio: ["ignore", fd, "pipe"],
      env: { ...process.env, LLV_GATE_WAIT_STARTED: path.join(dir, "running"),
        LLV_GATE_TIMING_DIRECTORY: dir, LLV_GATE_TIMING_DIRECTORY_IDENTITY: physical(dir),
        ...(queueTiming ? { LLV_RECORDED_CHECK_WAIT_ROOT: queueTiming } : {}), ...(descriptor ? {
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
      cancellation ??= { reason, at: Date.now(), atUptimeMs: custodyClock() };
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
    armDeadline();
    process.on("SIGTERM", terminate); process.on("SIGINT", interrupt);
    try {
      code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exit, signal) => { wrapperSignal = signal; resolve(exit ?? 128 + (signal ? constants.signals[signal] : 0)); });
      });
    } finally { clearTimeout(deadlineTimer); process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); }
  } catch (error) {
    fs.writeSync(fd, `gate recorder: ${error instanceof Error ? error.message : error}\n`);
  } finally { fs.fsyncSync(fd); fs.closeSync(fd); }
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
    cancellation ??= reports.map(entry => entry.cancellation).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.atUptimeMs - right.atUptimeMs)[0] ?? null;
    const queueSpans = closedQueueSpans(queueTiming);
    writeEnvelope(path.join(dir, "result.json"), { version: 1, runId: descriptor.runId, descriptorDigest: descriptor.descriptorDigest,
      wrapperExit: code, wrapperSignal, cancellation, queueSpans, closedAt: Date.now(), closedUptimeMs: custodyClock(), report, reports,
      dispatch: fs.existsSync(path.join(dir, "running")) || report || reports.length ? "started" : "not-started" } satisfies Terminal);
  }
  retainForegroundCheckTiming(dir, closedQueueSpans(queueTiming));
  const exit = fs.openSync(path.join(dir, "exit.tmp"), "wx", 0o600);
  try { fs.writeFileSync(exit, `${code}\n`); fs.fsyncSync(exit); } finally { fs.closeSync(exit); }
  fs.renameSync(path.join(dir, "exit.tmp"), path.join(dir, "exit"));
  const finalDirectory = fs.openSync(dir, "r");
  try { fs.fsyncSync(finalDirectory); } finally { fs.closeSync(finalDirectory); }
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
