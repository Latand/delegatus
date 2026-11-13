import { ownGateSandboxes } from "./gateSandboxRecords";
import { timedCommand, observeCommandExecution } from "../src/lib/recordedChecks/commandTiming";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { captureProcessIdentity, processIdentityStatus, systemBootEpoch, type ProcessIdentity } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { admitPortableTestRunner } from "../src/lib/testing/portableTestAdmission";
import { cpuBudgetTimer, cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { cpuSlotForOwner, inheritedCpuSlot } from "../src/lib/runtime/cpuAdmission";
import { runSandboxGate, guardSandboxGate } from "../src/lib/runtime/sandboxGateRunner";
import { cpuOwnerIdentity, hostProcessIdentity, signalSandboxContext } from "../src/lib/runtime/signalSandboxContext";
import { sandboxGateEntryCommand } from "../src/lib/runtime/sandboxGateEntry";
import { gateServiceProperties } from "../src/lib/runtime/cpuPlacement";
import { GateTasks, GATE_TASKS_MAX, GATE_TASK_LIMIT_EXIT, gateTaskProperties, gateTaskResult, gateTaskFailure, warnGateTaskFallback, type GateTaskSnapshot } from "./gate-tasks";
import { producerReport, producerCommandIdentity, recordedSupervisorObligation, recordedSupervisorRefusal, supervisorCancellation, reportSchema, readEnvelope, writeEnvelope, digest, type ProducerReport } from "../src/lib/recordedChecks/wire";
import { startCheckBroker } from "./check-worker-broker";
import { prepareTestHome } from "./check-test-home";
import { withTestAdmission } from "./check-admission";
import { withCompilerEntry } from "./check-compiler-entry";

/** `namespace` marks a caller inside an agent signal domain. Its identities
 * are translated to the host, where the service checks them, and the service
 * runs the command inside the owner's namespaces. */
type Launch = { command: string[]; cwd: string; env: NodeJS.ProcessEnv; owner: ProcessIdentity; parent?: ProcessIdentity; unit: string; timeoutMs: number; namespace?: true };
const args = process.argv.slice(2);
if (!["--service", "--namespace-guardian"].includes(args[0] ?? "")) ownGateSandboxes();
const timeoutMs = Number(process.env.LLV_OWNED_RUN_TIMEOUT_MS ?? 900_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("owned runner needs a positive finite deadline");

// Test preloads travel through package scripts and shells. Compiler admission
// is installed at its source entry below, independently of runtime options.
const runtimePreload = path.join(import.meta.dir, "check-runtime-preload.mjs");
const option = `--preload=${pathToFileURL(runtimePreload).href}`;
if (!process.env.BUN_OPTIONS?.includes(option)) process.env.BUN_OPTIONS = `${process.env.BUN_OPTIONS ?? ""} ${option}`.trim();
const launchOwner = args[0] === "--service"
  ? (JSON.parse(fs.readFileSync(args[1]!, "utf8")) as Launch).owner : undefined;
const broker = await startCheckBroker(launchOwner);
process.env.LLV_CHECK_BROKER = broker.address;
delete process.env.DELEGATUS_CHECK_BROKER;
const offset = args[0] === "--budget" ? 2 : ["--portable", "--namespace"].includes(args[0] ?? "") ? 1 : 0;
if (args[offset] && !args[offset]!.startsWith("--")) {
  const command = args.slice(offset), preload = path.join(import.meta.dir, "check-test-preload.ts");
  const admitted = withTestAdmission(command, preload);
  const startup = prepareTestHome();
  if (startup) {
    Object.assign(process.env, startup.env);
    process.once("exit", startup.release);
  }
  const compiler = withCompilerEntry(admitted);
  if (compiler) process.once("exit", compiler.release);
  args.splice(offset, args.length - offset, ...(compiler?.command ?? admitted));
}

// Resolve automatic admission before dispatch so fallback has the same owner,
// deadline and signal handlers as an explicitly portable invocation.
if (process.platform === "linux" && args.length && !args[0]!.startsWith("--")
  && !signalSandboxContext()
  && (!Bun.which("systemd-run") || spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status !== 0)) {
  console.error("owned runner: no reachable user systemd manager; using the documented portable cleanup fallback");
  args.unshift("--portable");
}

if (args[0] === "--namespace-guardian") {
  await guardSandboxGate(args[1]!);
} else if (args[0] === "--namespace") {
  warnGateTaskFallback("namespace cleanup fallback has no systemd gate unit");
  await runSandboxGate(args.slice(1), timeoutMs, import.meta.path);
} else if (args[0] === "--budget") {
  const allowance = Number(args[1]), command = args.slice(2);
  if (!Number.isFinite(allowance) || allowance <= 0 || !command.length) throw new Error("owned runner budget needs a finite allowance and a command");
  const budget = cpuWaitBudget(process.env);
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: { ...budget.env, LLV_OWNED_RUN_PARENT_IDENTITY: JSON.stringify(captureProcessIdentity(process.pid)) } });
  const close = new Promise<number>(resolve => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137)));
    child.once("error", error => { console.error(`owned runner: budget launch failed: ${error.message}`); resolve(1); });
  });
  let stopped = 0, cleanup: Promise<void> | undefined;
  const stop = (code: number) => {
    stopped ||= code;
    cleanup ??= stopFixtureProcess(child).catch(error => { console.error(`owned runner: budget cleanup failed: ${error.message}`); budget.close(); process.exit(1); });
  };
  process.on("SIGTERM", () => stop(143)); process.on("SIGINT", () => stop(130));
  const stopTimer = cpuBudgetTimer(allowance, budget.elapsed, () => { console.error("owned runner: execution guard expired"); stop(124); });
  const code = await close;
  await cleanup;
  stopTimer();
  try { await broker.close(); } finally { budget.close(); }
  process.exit(stopped || code);
} else if (args[0] === "--portable") {
  warnGateTaskFallback("no systemd user gate unit on this host");
  // The fallback uses the same spawn ledger and independent guardian as direct
  // test runs. This is also the documented Linux fallback when no user
  // systemd manager is reachable (for example, in a development container).
  admitPortableTestRunner();
  const command = args.slice(1);
  if (!command.length) throw new Error("owned runner needs a command");
  const recorded = recordedSupervisorObligation();
  const refused = recordedSupervisorRefusal(recorded);
  if (refused) {
    producerReport("portable", null, { phase: "close", cleanup: "confirmed" });
    process.exit(refused === "deadline" ? 124 : 137);
  }
  const parent = process.env.LLV_OWNED_RUN_PARENT_IDENTITY
    ? JSON.parse(process.env.LLV_OWNED_RUN_PARENT_IDENTITY) as ProcessIdentity : undefined;
  const parentAlive = () => !parent || (processIdentityStatus(parent) === "alive" && !procBackend.processExited(parent.pid));
  if (!parentAlive()) process.exit(137);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-owned-run-"));
  fs.chmodSync(directory, 0o700);
  const ledger = path.join(directory, "children.jsonl");
  fs.writeFileSync(ledger, "", { mode: 0o600 });
  const guardianOwner = captureProcessIdentity(process.pid);
  const guardian = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-child-guardian.ts"), ledger, JSON.stringify(guardianOwner)], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  guardian.unref();
  const budget = cpuWaitBudget(process.env);
  const slot = inheritedCpuSlot() ?? cpuSlotForOwner(captureProcessIdentity(process.pid));
  if (slot) {
    budget.env.LLV_GATE_SLOT_LEASE = JSON.stringify(slot);
    broker.provideCpuSlot(slot, process.env);
    budget.env.LLV_GATE_SLOT_BROKER = broker.address;
  }
  // A portable child cannot inherit a native parent's scope admission.
  delete budget.env.LLV_OWNED_TEST_RUNNER_PID;
  delete budget.env.LLV_OWNED_TEST_RUN_CGROUP;
  // exec binds admission to the command PID, just as the systemd service does.
  // A test preload can consequently accept this run without attempting to
  // re-enter another runner.
  const portableCommand = process.platform === "linux"
    ? timedCommand(command, 'export LLV_PORTABLE_TEST_RUNNER_PID=$$; ')
    : command;
  // Only timedCommand's Linux shell writes and closes fd 3. Native Windows
  // commands have no marker writer; an unused inherited pipe can remain open
  // after the command exits and strand the verdict in execution() below.
  const child = spawn(portableCommand[0]!, portableCommand.slice(1), {
    stdio: process.platform === "linux" ? ["inherit", "inherit", "inherit", "pipe"] : "inherit",
    env: budget.env,
  });
  const execution = observeCommandExecution(child);
  if (child.pid) fs.appendFileSync(ledger, `${JSON.stringify(captureProcessIdentity(child.pid))}\n`);
  const commandIdentity = producerCommandIdentity(child.pid);
  producerReport("portable", commandIdentity);
  let commandExit: number | null = null, commandSignal: string | null = null;
  const close = new Promise<number>(resolve => {
    child.once("exit", (code, signal) => { commandExit = code; commandSignal = signal; resolve(code ?? (signal === "SIGTERM" ? 143 : 137)); });
    child.once("error", () => resolve(1));
  });
  let interrupted = 0;
  let cancellation: ProducerReport["cancellation"] = null;
  let cleanup: Promise<void> | undefined, cleanupFailed = false;
  const cancel = (code: number, signal: NodeJS.Signals = "SIGTERM") => {
    interrupted ||= code;
    cleanup ??= (async () => {
      if (signal === "SIGINT") {
        child.kill(signal);
        await Promise.race([close, Bun.sleep(500)]);
      }
      await stopFixtureProcess(child);
    })().catch(error => {
      cleanupFailed = true;
      console.error(`owned runner: portable cleanup failed: ${error.message}`);
    });
  };
  const parentTimer = setInterval(() => {
    const refusal = recordedSupervisorRefusal(recorded);
    if (refusal) cancellation ??= supervisorCancellation(refusal);
    if (refusal || !parentAlive()) cancel(refusal === "deadline" ? 124 : 137);
  }, 100);
  process.on("SIGTERM", () => cancel(143)); process.on("SIGINT", () => cancel(130, "SIGINT"));
  const stopTimer = cpuBudgetTimer(timeoutMs, budget.elapsed, () => cancel(124));
  const code = await close;
  await cleanup;
  clearInterval(parentTimer); stopTimer(); budget.close();
  fs.writeFileSync(`${ledger}.done`, "done");
  await Promise.race([guardian.exited, Bun.sleep(3_000).then(() => { guardian.kill("SIGKILL"); throw new Error("owned runner guardian exceeded cleanup deadline"); })]);
  await broker.close();
  let guardianConfirmed = guardian.exitCode === 0;
  if (recorded) {
    try {
      const receipt = readEnvelope(`${ledger}.cleanup.json`) as { owner?: unknown; complete?: boolean; cancellation?: ProducerReport["cancellation"] };
      guardianConfirmed = receipt.complete === true && digest(receipt.owner) === digest(guardianOwner);
      if (guardianConfirmed) cancellation ??= receipt.cancellation ?? null;
    } catch { guardianConfirmed = false; }
  }
  fs.rmSync(directory, { recursive: true, force: true });
  producerReport("portable", commandIdentity, { ...await execution(), phase: "close", commandExit, commandSignal, cancellation, cleanup: cleanupFailed || !guardianConfirmed ? "unknown" : "confirmed" });
  process.exit(cleanupFailed ? 1 : interrupted || code || guardian.exitCode || 0);
} else if (args[0] === "--service") {
  const file = args[1]!;
  const launch: Launch = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  process.once("exit", () => {
    // A killed client cannot retire its private admission/observation files.
    if (processIdentityStatus(launch.owner) === "dead") fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
  // An identity recorded in another PID namespace can never be proven alive
  // here; without this check its owner looks dead and the command ends at once.
  if (launch.owner.bootEpoch !== systemBootEpoch()) {
    console.error("gate-slot: the caller runs in a PID namespace this gate service cannot see. Run gate-slot with the LLV_SIGNAL_SANDBOX its agent was launched with; the command did not run.");
    process.exit(69);
  }
  // This process reads the host's kernel; the namespace marker is the command's.
  const hostEnv = { ...launch.env };
  delete hostEnv.LLV_SIGNAL_SANDBOX;
  const notifySocket = process.env.NOTIFY_SOCKET;
  const invocation = process.env.INVOCATION_ID;
  process.env = { ...hostEnv, NOTIFY_SOCKET: notifySocket, INVOCATION_ID: invocation };
  process.env.LLV_CHECK_BROKER = broker.address;
  delete process.env.DELEGATUS_CHECK_BROKER;
  launch.env.LLV_CHECK_BROKER = broker.address;
  delete launch.env.DELEGATUS_CHECK_BROKER;
  const recorded = recordedSupervisorObligation();
  const budget = cpuWaitBudget(launch.env);
  const slot = inheritedCpuSlot(hostEnv) ?? cpuSlotForOwner(launch.owner, hostEnv);
  if (slot) {
    budget.env.LLV_GATE_SLOT_LEASE = JSON.stringify(slot);
    broker.provideCpuSlot(slot, hostEnv);
    budget.env.LLV_GATE_SLOT_BROKER = broker.address;
  }
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!cgroup?.endsWith(`/${launch.unit}`)) throw new Error("owned runner was not admitted to its declared service cgroup");
  const tasks = new GateTasks(path.join("/sys/fs/cgroup", cgroup));
  const taskFile = `${file}.tasks`;
  const saveTasks = () => {
    const snapshot = tasks.sample();
    fs.writeFileSync(`${taskFile}.tmp`, JSON.stringify({ cgroup, snapshot }), { mode: 0o600 });
    fs.renameSync(`${taskFile}.tmp`, taskFile);
    return snapshot;
  };
  try {
    if (tasks.verify(GATE_TASKS_MAX) === "unavailable") {
      warnGateTaskFallback(`pids controller is absent in ${launch.unit}`, budget.env);
    }
    saveTasks();
  } catch (error) {
    console.error(`GATE_TASK_LIMIT_UNAVAILABLE: ${launch.unit}: ${(error as Error).message}; command did not run`);
    budget.close(); process.exit(69);
  }
  const serviceEvidence = { unit: launch.unit, invocation: process.env.INVOCATION_ID ?? "", cgroup };
  const refused = recordedSupervisorRefusal(recorded);
  if (refused) {
    producerReport("service", null, { service: serviceEvidence, phase: "close", cleanup: "pending" });
    budget.close(); process.exit(refused === "deadline" ? 124 : 137);
  }
  const members = () => fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number).filter(pid => pid > 0 && pid !== process.pid && !procBackend.processExited(pid));
  // exec preserves the shell's kernel start identity and binds the admission
  // token to this command's PID. A nested test cannot reuse its parent's token.
  const shell = timedCommand(launch.command, 'export LLV_OWNED_TEST_RUNNER_PID=$$; ');
  const argv = launch.namespace ? sandboxGateEntryCommand(launch.owner, launch.cwd, shell) : shell;
  const child = spawn(argv[0]!, argv.slice(1), { cwd: launch.cwd, env: { ...budget.env, INVOCATION_ID: invocation, LLV_OWNED_TEST_RUN_CGROUP: cgroup }, stdio: ["inherit", "inherit", "inherit", "pipe"] });
  const execution = observeCommandExecution(child);
  // Capture before any await; systemd owns every fork in the cgroup from birth.
  const identity = producerCommandIdentity(child.pid);
  producerReport("service", identity, { service: serviceEvidence, boundary: launch.namespace ? "namespace" : "direct" });
  let commandExit: number | null = null, commandSignal: string | null = null;
  let cancellation: ProducerReport["cancellation"] = null;
  let settled = false;
  let stopExecutionTimer = () => {};
  const finish = async (code: number) => {
    if (settled) return;
    settled = true;
    clearInterval(taskTimer);
    stopExecutionTimer();
    await stopNotify();
    try { if (saveTasks().denied > 0) code = GATE_TASK_LIMIT_EXIT; }
    catch (error) { console.error(`GATE_TASK_OBSERVATION_FAILED: ${launch.unit}: ${(error as Error).message}`); code = 1; }
    const survivors = members().filter(pid => pid !== identity?.pid || processIdentityStatus(identity!) === "alive");
    try { await broker.close(); } finally { budget.close(); }
    // A deadline ends the main process before systemd drains the cgroup.
    // Its pending children are expected; the waiting client returns only after
    // that cleanup. A normal exit with children still refuses the check.
    if (survivors.length) console.error(`owned runner: ${code === 124 ? "processes awaiting deadline cleanup" : "surviving owned processes"}: ${survivors.map(pid => `${pid} (${procBackend.processIdentity(pid)})`).join(", ")}`);
    // Exit of the service main process invokes systemd's control-group TERM,
    // followed by KILL after TimeoutStopSec, including detached descendants.
    producerReport("service", identity, { ...await execution(), service: serviceEvidence, boundary: launch.namespace ? "namespace" : "direct", phase: "close", commandExit, commandSignal, cancellation, cleanup: "pending" });
    process.exit(survivors.length && code === 0 ? 1 : code);
  };
  child.once("error", error => { console.error(`owned runner: command could not start: ${error.message}`); void finish(1); });
  child.once("exit", (code, signal) => { commandExit = code; commandSignal = signal; void finish(code ?? (signal === "SIGTERM" ? 143 : 137)); });
  // Reading counters needs no new task, including when fork/clone is refused.
  const taskTimer = setInterval(() => {
    try { if (tasks.sample().denied > 0) void finish(GATE_TASK_LIMIT_EXIT); }
    catch (error) { console.error(`GATE_TASK_OBSERVATION_FAILED: ${launch.unit}: ${(error as Error).message}`); void finish(1); }
  }, 50);
  setInterval(() => {
    const alive = (owner: ProcessIdentity) => processIdentityStatus(owner) === "alive" && !procBackend.processExited(owner.pid);
    const refusal = recordedSupervisorRefusal(recorded);
    if (refusal) cancellation ??= supervisorCancellation(refusal);
    if (refusal || !alive(launch.owner) || (launch.parent && !alive(launch.parent))) void finish(refusal === "deadline" ? 124 : 137);
  }, 100);
  stopExecutionTimer = cpuBudgetTimer(launch.timeoutMs, budget.elapsed, () => { console.error("owned runner: deadline expired"); void finish(124); });
  // A kernel watchdog bounds a hung supervisor while its execution timer
  // excludes queue waits. RuntimeMaxSec cannot be extended on older systemd.
  // A short-lived helper can fail under pressure while the command is healthy.
  // Retry asynchronously within half the kernel's 60-second watchdog window;
  // owner checks, cancellation and the execution deadline keep running.
  let notifying: ReturnType<typeof spawn> | undefined, notifyClosed: Promise<void> | undefined;
  let nextNotify: ReturnType<typeof setTimeout> | undefined;
  let lastFailure = "no completed notification";
  const expired = () => {
    console.error(`owned runner: watchdog notification failed: ${lastFailure} (no successful notification within 30000 ms)`);
    void finish(1);
  };
  let notifyDeadline = setTimeout(expired, 30_000);
  const notify = () => {
    if (settled) return;
    const helper = spawn("systemd-notify", ["--no-block", "WATCHDOG=1"], { env: { ...process.env, NOTIFY_SOCKET: notifySocket }, stdio: "ignore", timeout: 2_000, killSignal: "SIGKILL" });
    notifying = helper;
    let errorCode: string | undefined;
    helper.once("error", (error: NodeJS.ErrnoException) => { errorCode = error.code ?? "spawn error"; });
    notifyClosed = new Promise(resolve => helper.once("close", (code, signal) => {
      notifying = undefined;
      resolve();
      if (settled) return;
      if (code === 0) {
        clearTimeout(notifyDeadline);
        notifyDeadline = setTimeout(expired, 30_000);
        nextNotify = setTimeout(notify, 10_000);
      } else {
        lastFailure = errorCode ?? (signal ? `signal ${signal}` : `exit ${code}`);
        console.error(`owned runner: watchdog notification retry: ${lastFailure}`);
        nextNotify = setTimeout(notify, 1_000);
      }
    }));
  };
  async function stopNotify() {
    clearTimeout(nextNotify); clearTimeout(notifyDeadline);
    if (notifying) {
      notifying.kill("SIGKILL");
      // Reap our helper before the survivor check, including when the command
      // exits or is cancelled while notification is still in flight.
      await Promise.race([notifyClosed, Bun.sleep(1_000)]);
    }
  }
  notify();
  process.on("SIGTERM", () => { void finish(143); });
  process.on("SIGINT", () => { void finish(130); });
} else {
  if (!args.length) throw new Error("usage: owned-runner.ts command [args...]");
  const sandbox = signalSandboxContext();
  if (sandbox && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status !== 0) {
    console.error("owned runner: no reachable systemd user manager, so no gate service; the command runs in a bounded leaf of this agent's own scope instead");
    warnGateTaskFallback("no reachable systemd user manager for a gate unit");
    await runSandboxGate(args, timeoutMs, import.meta.path);
  }
  const unit = `delegatus-gate-${randomUUID()}.service`;
  // The service checks both identities from the host PID namespace.
  const owner = sandbox ? cpuOwnerIdentity(process.pid) : captureProcessIdentity(process.pid);
  if (!owner.startIdentity || !owner.bootEpoch) throw new Error("owned runner has no verifiable start identity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-owned-run-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "launch.json");
  let parent = process.env.LLV_OWNED_RUN_PARENT_IDENTITY ? JSON.parse(process.env.LLV_OWNED_RUN_PARENT_IDENTITY) as ProcessIdentity : undefined;
  if (parent && sandbox) {
    try { parent = hostProcessIdentity(parent); }
    catch (error) { throw new Error(`owned runner cannot verify its supervising process from the gate service: ${(error as Error).message}`); }
  }
  fs.writeFileSync(file, JSON.stringify({ command: args, cwd: process.cwd(), env: process.env, owner, parent, unit, timeoutMs, ...(sandbox ? { namespace: true as const } : {}) } satisfies Launch), { mode: 0o600 });
  const cpu = [...gateServiceProperties(), ...gateTaskProperties()];
  const recorded = process.env.LLV_RECORDED_CHECK_ID ? [`--setenv=LLV_RECORDED_CHECK_ID=${process.env.LLV_RECORDED_CHECK_ID}`] : [];
  const service = spawn("systemd-run", [...cpu, "--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, ...recorded, "--service-type=exec", "-p", "KillMode=control-group", "-p", "TimeoutStopSec=2s", "-p", "WatchdogSec=60s", "-p", "NotifyAccess=all", "-p", `MemoryMax=${process.env.LLV_GATE_MEM ?? "14G"}`, "--", process.execPath, import.meta.path, "--service", file], { stdio: "inherit" });
  const close = new Promise<number>(resolve => {
    service.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137)));
    service.once("error", error => { console.error(`owned runner: systemd admission failed: ${error.message}`); resolve(1); });
  });
  // The unit name is a fresh capability created by this invocation. No process
  // search, argv match or recycled process-group number authorizes stopping it.
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= new Promise<void>(resolve => {
      const child = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
      const bound = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(bound); resolve(); });
      child.once("error", () => { clearTimeout(bound); resolve(); });
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // The client is outside the limited unit. It can still stop that exact unit
  // if its supervisor stalls at saturation, and keeps a peak if it is killed.
  const taskFile = `${file}.tasks`;
  let tasks: GateTasks | undefined, taskError = false;
  let snapshot: GateTaskSnapshot = { max: null, peak: null, peakSource: "sampled", denied: 0 };
  const sampleTasks = () => {
    try {
      if (fs.existsSync(taskFile)) {
        const row = JSON.parse(fs.readFileSync(taskFile, "utf8")) as { cgroup: string; snapshot: GateTaskSnapshot };
        if (!row.cgroup.endsWith(`/${unit}`) || row.cgroup.split("/").includes("..")) throw new Error("invalid gate task cgroup");
        tasks ??= new GateTasks(path.join("/sys/fs/cgroup", row.cgroup));
        tasks.snapshot = { ...row.snapshot, peak: Math.max(tasks.snapshot.peak ?? 0, row.snapshot.peak ?? 0) || null,
          denied: Math.max(tasks.snapshot.denied, row.snapshot.denied) };
        snapshot = tasks.sample();
        if (snapshot.denied > 0) stop();
      }
    } catch (error) {
      if (!taskError) console.error(`GATE_TASK_OBSERVATION_FAILED: ${unit}: ${(error as Error).message}`);
      taskError = true; stop();
    }
  };
  const taskTimer = setInterval(sampleTasks, 50);
  const code = await close;
  clearInterval(taskTimer);
  sampleTasks();
  await stopping;
  console.error(gateTaskResult(unit, snapshot));
  if (snapshot.denied > 0) console.error(gateTaskFailure(unit, snapshot));
  else if (code !== 0 && !fs.existsSync(taskFile)) console.error(`GATE_UNIT_START_FAILED: ${unit}: systemd-run exited ${code}; gate supervisor did not report admission`);
  if (process.env.LLV_RECORDED_CHECK_DIRECTORY) {
    const filename = path.join(process.env.LLV_RECORDED_CHECK_DIRECTORY, "supervisor.json");
    const report = reportSchema.parse(readEnvelope(filename));
    // --wait returned after systemd's stop job; also inspect the exact cgroup.
    const group = report.service?.cgroup;
    const empty = group && (!fs.existsSync(path.join("/sys/fs/cgroup", group))
      || /^populated 0$/m.test(fs.readFileSync(path.join("/sys/fs/cgroup", group, "cgroup.events"), "utf8")));
    const finalReport = { ...report, cleanup: report.phase === "close" && empty ? "confirmed" : "unknown" };
    writeEnvelope(path.join(path.dirname(filename), `${report.kind}.json`), finalReport);
    writeEnvelope(filename, finalReport);
  }
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(snapshot.denied > 0 ? GATE_TASK_LIMIT_EXIT : taskError ? 1 : code);
}
