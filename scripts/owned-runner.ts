import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** `namespace` marks a caller inside an agent signal domain. Its identities
 * are translated to the host, where the service checks them, and the service
 * runs the command inside the owner's namespaces. */
type Launch = { command: string[]; cwd: string; env: NodeJS.ProcessEnv; owner: ProcessIdentity; parent?: ProcessIdentity; unit: string; timeoutMs: number; namespace?: true };
const args = process.argv.slice(2);
const timeoutMs = Number(process.env.LLV_OWNED_RUN_TIMEOUT_MS ?? 900_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("owned runner needs a positive finite deadline");

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
  stopTimer(); budget.close();
  process.exit(stopped || code);
} else if (args[0] === "--portable") {
  // The fallback uses the same spawn ledger and independent guardian as direct
  // test runs. This is also the documented Linux fallback when no user
  // systemd manager is reachable (for example, in a development container).
  admitPortableTestRunner();
  const command = args.slice(1);
  if (!command.length) throw new Error("owned runner needs a command");
  const parent = process.env.LLV_OWNED_RUN_PARENT_IDENTITY
    ? JSON.parse(process.env.LLV_OWNED_RUN_PARENT_IDENTITY) as ProcessIdentity : undefined;
  const parentAlive = () => !parent || (processIdentityStatus(parent) === "alive" && !procBackend.processExited(parent.pid));
  if (!parentAlive()) process.exit(137);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-owned-run-"));
  fs.chmodSync(directory, 0o700);
  const ledger = path.join(directory, "children.jsonl");
  fs.writeFileSync(ledger, "", { mode: 0o600 });
  const guardian = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-child-guardian.ts"), ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  guardian.unref();
  const budget = cpuWaitBudget(process.env);
  const slot = inheritedCpuSlot() ?? cpuSlotForOwner(captureProcessIdentity(process.pid));
  if (slot) budget.env.LLV_GATE_SLOT_LEASE = JSON.stringify(slot);
  // A portable child cannot inherit a native parent's scope admission.
  delete budget.env.LLV_OWNED_TEST_RUNNER_PID;
  delete budget.env.LLV_OWNED_TEST_RUN_CGROUP;
  // exec binds admission to the command PID, just as the systemd service does.
  // A test preload can consequently accept this run without attempting to
  // re-enter another runner.
  const portableCommand = process.platform === "linux"
    ? ["/bin/bash", "-c", 'export LLV_PORTABLE_TEST_RUNNER_PID=$$; exec "$@"', "owned-command", ...command]
    : command;
  const child = spawn(portableCommand[0]!, portableCommand.slice(1), { stdio: "inherit", env: budget.env });
  if (child.pid) fs.appendFileSync(ledger, `${JSON.stringify(captureProcessIdentity(child.pid))}\n`);
  const close = new Promise<number>(resolve => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137)));
    child.once("error", () => resolve(1));
  });
  let interrupted = 0;
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
  const parentTimer = setInterval(() => { if (!parentAlive()) cancel(137); }, 100);
  process.on("SIGTERM", () => cancel(143)); process.on("SIGINT", () => cancel(130, "SIGINT"));
  const stopTimer = cpuBudgetTimer(timeoutMs, budget.elapsed, () => cancel(124));
  const code = await close;
  await cleanup;
  clearInterval(parentTimer); stopTimer(); budget.close();
  fs.writeFileSync(`${ledger}.done`, "done");
  await Promise.race([guardian.exited, Bun.sleep(3_000).then(() => { guardian.kill("SIGKILL"); throw new Error("owned runner guardian exceeded cleanup deadline"); })]);
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(cleanupFailed ? 1 : interrupted || code || guardian.exitCode || 0);
} else if (args[0] === "--service") {
  const file = args[1]!;
  const launch: Launch = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  fs.rmdirSync(path.dirname(file));
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
  process.env = { ...hostEnv, NOTIFY_SOCKET: notifySocket };
  const budget = cpuWaitBudget(launch.env);
  const slot = inheritedCpuSlot(hostEnv) ?? cpuSlotForOwner(launch.owner, hostEnv);
  if (slot) budget.env.LLV_GATE_SLOT_LEASE = JSON.stringify(slot);
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!cgroup?.endsWith(`/${launch.unit}`)) throw new Error("owned runner was not admitted to its declared service cgroup");
  const members = () => fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number).filter(pid => pid > 0 && pid !== process.pid && !procBackend.processExited(pid));
  // exec preserves the shell's kernel start identity and binds the admission
  // token to this command's PID. A nested test cannot reuse its parent's token.
  const shell = ["/bin/bash", "-c", 'export LLV_OWNED_TEST_RUNNER_PID=$$; exec "$@"', "owned-command", ...launch.command];
  const argv = launch.namespace ? sandboxGateEntryCommand(launch.owner, launch.cwd, shell) : shell;
  const child = spawn(argv[0]!, argv.slice(1), { cwd: launch.cwd, env: { ...budget.env, LLV_OWNED_TEST_RUN_CGROUP: cgroup }, stdio: "inherit" });
  // Capture before any await; systemd owns every fork in the cgroup from birth.
  const identity = child.pid ? captureProcessIdentity(child.pid) : null;
  let settled = false;
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    budget.close();
    const survivors = members().filter(pid => pid !== identity?.pid || processIdentityStatus(identity!) === "alive");
    // A deadline ends the main process before systemd drains the cgroup.
    // Its pending children are expected; the waiting client returns only after
    // that cleanup. A normal exit with children still refuses the check.
    if (survivors.length) console.error(`owned runner: ${code === 124 ? "processes awaiting deadline cleanup" : "surviving owned processes"}: ${survivors.map(pid => `${pid} (${procBackend.processIdentity(pid)})`).join(", ")}`);
    // Exit of the service main process invokes systemd's control-group TERM,
    // followed by KILL after TimeoutStopSec, including detached descendants.
    process.exit(survivors.length && code === 0 ? 1 : code);
  };
  child.once("error", error => { console.error(`owned runner: command could not start: ${error.message}`); finish(1); });
  child.once("exit", (code, signal) => finish(code ?? (signal === "SIGTERM" ? 143 : 137)));
  setInterval(() => {
    const alive = (owner: ProcessIdentity) => processIdentityStatus(owner) === "alive" && !procBackend.processExited(owner.pid);
    if (!alive(launch.owner) || (launch.parent && !alive(launch.parent))) finish(137);
  }, 100);
  cpuBudgetTimer(launch.timeoutMs, budget.elapsed, () => { console.error("owned runner: deadline expired"); finish(124); });
  // A kernel watchdog bounds a hung supervisor while its execution timer
  // excludes queue waits. RuntimeMaxSec cannot be extended on older systemd.
  const notify = () => {
    if (settled) return;
    const result = spawnSync("systemd-notify", ["--no-block", "WATCHDOG=1"], { env: { ...process.env, NOTIFY_SOCKET: notifySocket }, stdio: "ignore", timeout: 2_000 });
    if (result.status !== 0) { console.error("owned runner: watchdog notification failed"); finish(1); }
  };
  notify();
  setInterval(notify, 10_000);
  process.on("SIGTERM", () => finish(143));
  process.on("SIGINT", () => finish(130));
} else {
  if (!args.length) throw new Error("usage: owned-runner.ts command [args...]");
  const sandbox = signalSandboxContext();
  if (sandbox && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 5_000 }).status !== 0) {
    console.error("owned runner: no reachable systemd user manager, so no gate service; the command runs in a bounded leaf of this agent's own scope instead");
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
  const cpu = gateServiceProperties();
  const service = spawn("systemd-run", [...cpu, "--user", "--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, "--service-type=exec", "-p", "KillMode=control-group", "-p", "TimeoutStopSec=2s", "-p", "WatchdogSec=60s", "-p", "NotifyAccess=all", "-p", `MemoryMax=${process.env.LLV_GATE_MEM ?? "8G"}`, "--", process.execPath, import.meta.path, "--service", file], { stdio: "inherit" });
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
  const code = await close;
  await stopping;
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(code);
}
