import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { procBackend } from "../src/lib/proc";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { admitPortableTestRunner } from "../src/lib/testing/portableTestAdmission";
import { cpuBudgetTimer, cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";

type Launch = { command: string[]; cwd: string; env: NodeJS.ProcessEnv; owner: ProcessIdentity; parent?: ProcessIdentity; unit: string; timeoutMs: number };
const args = process.argv.slice(2);
const timeoutMs = Number(process.env.LLV_OWNED_RUN_TIMEOUT_MS ?? 900_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("owned runner needs a positive finite deadline");

if (args[0] === "--budget") {
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
  // test runs. On Linux the gate refuses to lose kernel cgroup containment.
  admitPortableTestRunner();
  const command = args.slice(1);
  if (!command.length) throw new Error("owned runner needs a command");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-owned-run-"));
  fs.chmodSync(directory, 0o700);
  const ledger = path.join(directory, "children.jsonl");
  fs.writeFileSync(ledger, "", { mode: 0o600 });
  const guardian = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-child-guardian.ts"), ledger, JSON.stringify(captureProcessIdentity(process.pid))], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  guardian.unref();
  const budget = cpuWaitBudget(process.env);
  const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: budget.env });
  if (child.pid) fs.appendFileSync(ledger, `${JSON.stringify(captureProcessIdentity(child.pid))}\n`);
  const close = new Promise<number>(resolve => {
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137)));
    child.once("error", () => resolve(1));
  });
  let interrupted = 0;
  const cancel = (code: number) => { interrupted ||= code; void stopFixtureProcess(child); };
  process.on("SIGTERM", () => cancel(143)); process.on("SIGINT", () => cancel(130));
  const stopTimer = cpuBudgetTimer(timeoutMs, budget.elapsed, () => cancel(124));
  const code = await close;
  stopTimer(); budget.close();
  fs.writeFileSync(`${ledger}.done`, "done");
  await Promise.race([guardian.exited, Bun.sleep(3_000).then(() => { guardian.kill("SIGKILL"); throw new Error("owned runner guardian exceeded cleanup deadline"); })]);
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(interrupted || code || guardian.exitCode || 0);
} else if (args[0] === "--service") {
  const file = args[1]!;
  const launch: Launch = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  fs.rmdirSync(path.dirname(file));
  const notifySocket = process.env.NOTIFY_SOCKET;
  process.env = { ...launch.env, NOTIFY_SOCKET: notifySocket };
  const budget = cpuWaitBudget(launch.env);
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3);
  if (!cgroup?.endsWith(`/${launch.unit}`)) throw new Error("owned runner was not admitted to its declared service cgroup");
  const members = () => fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim().split(/\s+/).map(Number).filter(pid => pid > 0 && pid !== process.pid && !procBackend.processExited(pid));
  // exec preserves the shell's kernel start identity and binds the admission
  // token to this command's PID. A nested test cannot reuse its parent's token.
  const child = spawn("/bin/bash", ["-c", 'export LLV_OWNED_TEST_RUNNER_PID=$$; exec "$@"', "owned-command", ...launch.command], { cwd: launch.cwd, env: { ...budget.env, LLV_OWNED_TEST_RUN_CGROUP: cgroup }, stdio: "inherit" });
  // Capture before any await; systemd owns every fork in the cgroup from birth.
  const identity = child.pid ? captureProcessIdentity(child.pid) : null;
  let settled = false;
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    budget.close();
    const survivors = members().filter(pid => pid !== identity?.pid || processIdentityStatus(identity!) === "alive");
    if (survivors.length) console.error(`owned runner: surviving owned processes: ${survivors.map(pid => `${pid} (${procBackend.processIdentity(pid)})`).join(", ")}`);
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
  const unit = `delegatus-gate-${randomUUID()}.service`;
  const owner = captureProcessIdentity(process.pid);
  if (!owner.startIdentity || !owner.bootEpoch) throw new Error("owned runner has no verifiable start identity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-owned-run-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "launch.json");
  const parent = process.env.LLV_OWNED_RUN_PARENT_IDENTITY ? JSON.parse(process.env.LLV_OWNED_RUN_PARENT_IDENTITY) as ProcessIdentity : undefined;
  fs.writeFileSync(file, JSON.stringify({ command: args, cwd: process.cwd(), env: process.env, owner, parent, unit, timeoutMs } satisfies Launch), { mode: 0o600 });
  const cpu = process.env.LLV_OWNED_RUN_CPU_SLICE ? [`--slice=${process.env.LLV_OWNED_RUN_CPU_SLICE}`, "-p", "CPUWeight=100", "-p", `CPUQuota=${process.env.LLV_OWNED_RUN_CPU_QUOTA}%`, "-p", "CPUQuotaPeriodSec=20ms"] : [];
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
