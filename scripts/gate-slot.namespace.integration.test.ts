import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signalAgentDomain, signalDomain, spawnSignalSandbox } from "../src/lib/runtime/agentSignalSandbox";

// A gate run from inside an agent signal domain must reach the gate service
// (its memory and CPU limits) without leaving the caller's namespaces. The
// caller is a real PID/user/mount namespace: inside an agent domain the test
// builds one with the production launcher's Bubblewrap arguments in a leaf of
// its own delegated scope; on a host the production launcher builds it, under
// the kernel tests' opt-in.
const gate = path.resolve(import.meta.dir, "gate-slot.sh");
const outer = process.env.LLV_SIGNAL_SANDBOX ? JSON.parse(process.env.LLV_SIGNAL_SANDBOX) as { scope: string; hostProc: string; hostPidNamespace: string; hostEpoch: string } : null;
const available = process.platform === "linux" && ["bwrap", "python3", "systemd-run"].every(binary => Bun.which(binary))
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
const kernelTest = available && (outer || process.env.LLV_SIGNAL_SANDBOX_KERNEL_TEST === "1") ? test : test.skip;
const SERVICE = /\/delegatus-gate-[0-9a-f-]{36}\.service$/;
const CALLER_CAP = 96 * 2 ** 20;

/** Inside a domain this is the engine: it records its namespace and runs the
 * gate as its child. It can kill that child (the gate's owner) or a separate
 * supervisor it started and recorded as the gate's supervising process, each
 * by the PID it holds. */
const CALLER = String.raw`
import json, os, signal, subprocess, sys, time
spec = json.loads(os.environ["FIXTURE_SPEC"])
host_proc = json.loads(os.environ["LLV_SIGNAL_SANDBOX"])["hostProc"]
if spec.get("unsetContext"):
    os.environ.pop("LLV_SIGNAL_SANDBOX", None)
json.dump({"pidNamespace": os.readlink("/proc/self/ns/pid")}, open(spec["root"] + "/caller.json", "w"))
supervisor = None
if spec.get("kill") == "supervisor":
    supervisor = subprocess.Popen(["sleep", "600"])
    text = open("/proc/%d/stat" % supervisor.pid).read()
    os.environ["LLV_OWNED_RUN_PARENT_IDENTITY"] = json.dumps({"pid": supervisor.pid,
        "startIdentity": "%d:%s" % (supervisor.pid, text[text.rindex(")") + 2:].split()[19]),
        "bootEpoch": "linux:%s:pidns:%s" % (open("/proc/sys/kernel/random/boot_id").read().strip(), os.readlink("/proc/self/ns/pid"))})
owner = subprocess.Popen(["bash", "-c", 'exec "$@"', "intermediate", *sys.argv[1:]] if supervisor else sys.argv[1:])
marker = spec.get("killAfter")
if marker:
    while not os.path.exists(marker):
        if owner.poll() is not None:
            sys.exit(90)
        time.sleep(0.01)
    worker = json.load(open(marker))
    target = supervisor or owner
    os.kill(target.pid, signal.SIGKILL)
    target.wait()
    def alive():
        try:
            text = open("%s/%d/stat" % (host_proc, worker["pid"])).read()
        except OSError:
            return False
        fields = text[text.rindex(")") + 2:].split()
        return fields[0] not in ("Z", "X", "x") and "%d:%s" % (worker["pid"], fields[19]) == worker["startIdentity"]
    end = time.monotonic() + 10
    while alive() and time.monotonic() < end:
        time.sleep(0.02)
    json.dump({"workerStopped": not alive()}, open(spec["root"] + "/owner-death.json", "w"))
    if supervisor:
        owner.wait()
    sys.exit(0)
code = owner.wait()
sys.exit(code if code >= 0 else 128 - code)
`;

/** Builds a domain as bin/agent-signal-sandbox.py does, nested in the agent
 * domain this test runs in: a delegated scope with an agent leaf and a memory
 * cap, Bubblewrap's user/PID/mount namespaces, the original proc read-only and
 * the scope's cgroup alias. The context it hands the engine names the true
 * host's proc, so identities translate to the PID namespace systemd sees. */
const NESTED = String.raw`
import json, os, subprocess, sys
spec = json.loads(os.environ["FIXTURE_SPEC"])
def stat(root, pid):
    text = open("%s/%s/stat" % (root, pid)).read()
    return text[text.rindex(")") + 2:].split()
if sys.argv[1] == "--inner":
    proc = spec["root"] + "/hostproc"
    me = int(os.readlink(proc + "/self"))
    init = int(stat(proc, me)[1])
    identity = lambda pid: {"pid": pid, "startIdentity": "%d:%s" % (pid, stat(proc, pid)[19]), "bootEpoch": spec["hostEpoch"]}
    os.environ["LLV_SIGNAL_SANDBOX"] = json.dumps({"policyVersion": 1, "hostProc": proc, "hostPidNamespace": spec["hostPidNamespace"],
        "hostEpoch": spec["hostEpoch"], "monitor": spec["monitor"], "init": identity(init), "native": identity(me),
        "scope": spec["scope"], "cgroupRoot": spec["root"] + "/cgroup"})
    os.execvp(sys.argv[2], sys.argv[2:])
base = "/sys/fs/cgroup" + spec["scope"]
os.mkdir(base)
os.mkdir(base + "/agent")
open(base + "/agent/cgroup.procs", "w").write(str(os.getpid()))
open(base + "/cgroup.subtree_control", "w").write("+cpu +memory +pids")
open(base + "/memory.max", "w").write(str(spec["cap"]))
open(base + "/memory.swap.max", "w").write("0")
for name in ("hostproc", "cgroup"):
    os.mkdir(spec["root"] + "/" + name)
me = int(os.readlink(spec["outerProc"] + "/self"))
spec["monitor"] = {"pid": me, "startIdentity": "%d:%s" % (me, stat(spec["outerProc"], me)[19]), "bootEpoch": spec["hostEpoch"]}
os.environ["FIXTURE_SPEC"] = json.dumps(spec)
sys.exit(subprocess.call(["bwrap", "--unshare-user", "--unshare-pid", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    "--ro-bind", "/sys", "/sys", "--bind", base, base, "--ro-bind", spec["outerProc"], spec["root"] + "/hostproc",
    "--bind", base, spec["root"] + "/cgroup", "--cap-drop", "ALL", "--new-session", "--die-with-parent", "--",
    sys.executable, "-I", os.path.abspath(__file__), "--inner", *sys.argv[1:]]))
`;

/** The gate's command. It reports where it ran and what bounds it, can hold
 * the gate open as a recorded worker, and exits with the code it is given. */
const PROBE = String.raw`
import json, os, subprocess, sys, time
open(os.environ["PROBE_STARTED"], "w").close()
context = json.loads(os.environ["LLV_SIGNAL_SANDBOX"])
group = open("/proc/self/cgroup").read().strip()[3:]
read = lambda name: open("/sys/fs/cgroup" + group + "/" + name).read().strip()
host = int(os.readlink(context["hostProc"] + "/self"))
text = open("%s/%d/stat" % (context["hostProc"], host)).read()
if os.environ.get("PROBE_MARKER"):
    record = {"pid": host, "startIdentity": "%d:%s" % (host, text[text.rindex(")") + 2:].split()[19]), "group": group}
    json.dump(record, open(os.environ["PROBE_MARKER"] + ".tmp", "w"))
    os.rename(os.environ["PROBE_MARKER"] + ".tmp", os.environ["PROBE_MARKER"])
    while True:
        time.sleep(1)
block = bytearray(int(os.environ["PROBE_BYTES"]))
for index in range(0, len(block), 4096):
    block[index] = 1
nested = None
if os.environ.get("PROBE_NESTED"):
    run = subprocess.run(["bash", os.environ["PROBE_NESTED"], "/bin/sh", "-c", "cut -d: -f3 /proc/self/cgroup; readlink /proc/self/ns/pid"], capture_output=True, text=True, timeout=60)
    nested = {"code": run.returncode, "lines": run.stdout.split(), "stderr": run.stderr[-2000:]}
print(json.dumps({"group": group, "memoryMax": read("memory.max"), "cpuMax": read("cpu.max"),
    "pidNamespace": os.readlink("/proc/self/ns/pid"), "allocated": len(block), "nested": nested}), flush=True)
sys.exit(int(os.environ.get("PROBE_EXIT", "0")))
`;

type Run = { code: number | null; stdout: string; stderr: string; caller: { pidNamespace: string }; root: string; scope?: string };
type Report = { group: string; memoryMax: string; cpuMax: string; pidNamespace: string; allocated: number; nested: { code: number; lines: string[]; stderr: string } };
const report = (run: Run): Report => JSON.parse(run.stdout.trim().split("\n").at(-1)!);

function isolatedEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["LLV_GATE_SLOT_LEASE", "LLV_OWNED_TEST_RUNNER_PID", "LLV_OWNED_TEST_RUN_CGROUP", "LLV_OWNED_RUN_PARENT_IDENTITY", "LLV_CPU_WAIT_ROOTS"]) delete env[key];
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", TMPDIR: "tmp", LLV_STATE_DIR: "state", LLV_GATE_LOCK_DIR: "slots" })) {
    env[key] = path.join(root, dir); fs.mkdirSync(env[key]!, { recursive: true });
  }
  return { ...env, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_GATE_SLOTS: "1", DELEGATUS_CPU_PRESSURE: "off",
    DELEGATUS_AGENT_CPU: "off", LLV_GATE_MEM: "512M", LLV_OWNED_RUN_TIMEOUT_MS: "60000", LLV_GATE_POLL_SECONDS: ".05",
    PROBE_STARTED: path.join(root, "probe-started"), ...extra };
}

/** Removes only the fixture scope this run created, deepest leaves first,
 * once the namespace's last processes have left it. */
async function removeScope(directory: string) {
  if (!fs.existsSync(directory)) return;
  const deadline = Date.now() + 10_000;
  while (/^populated 1$/m.test(fs.readFileSync(path.join(directory, "cgroup.events"), "utf8"))) {
    if (Date.now() >= deadline) throw new Error(`fixture scope stayed populated: ${directory}`);
    await Bun.sleep(10);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) await removeScope(path.join(directory, entry.name));
  fs.rmdirSync(directory);
}

async function runCaller(name: string, spec: Record<string, unknown>, command: string[], env: Record<string, string>): Promise<Run> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const callerFile = path.join(root, "caller.py");
  fs.writeFileSync(callerFile, CALLER);
  const fullEnv = isolatedEnv(root, env);
  let child: ChildProcess, scope: string | undefined;
  if (outer) {
    scope = `${outer.scope}/fixture-${randomBytes(8).toString("hex")}.scope`;
    const nested = path.join(root, "nested.py");
    fs.writeFileSync(nested, NESTED);
    fullEnv.FIXTURE_SPEC = JSON.stringify({ ...spec, root, scope, cap: CALLER_CAP, outerProc: outer.hostProc,
      hostPidNamespace: outer.hostPidNamespace, hostEpoch: outer.hostEpoch });
    child = spawn("python3", ["-I", nested, "python3", "-I", callerFile, ...command], { env: fullEnv, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    fullEnv.FIXTURE_SPEC = JSON.stringify({ ...spec, root });
    child = await spawnSignalSandbox("python3", ["-I", callerFile, ...command], { env: fullEnv, stdio: ["ignore", "pipe", "pipe"] });
  }
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  try {
    const timer = setTimeout(() => { if (!outer) signalAgentDomain(child, "SIGKILL"); else child.kill("SIGKILL"); }, 90_000);
    await once(child, "close");
    clearTimeout(timer);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      if (!outer) signalAgentDomain(child, "SIGKILL"); else child.kill("SIGKILL");
      await once(child, "close");
    }
  }
  const caller = fs.existsSync(path.join(root, "caller.json")) ? JSON.parse(fs.readFileSync(path.join(root, "caller.json"), "utf8"))
    : { pidNamespace: outer ? "" : signalDomain(child)?.pidNamespace ?? "" };
  return { code: child.exitCode, stdout, stderr, caller, root, scope };
}

async function cleanup(run: Run | undefined) {
  if (!run) return;
  if (run.scope) await removeScope(`/sys/fs/cgroup${run.scope}`);
  fs.rmSync(run.root, { recursive: true, force: true });
}

kernelTest("a namespaced caller's memory-hungry gate command runs in a gate service with the gate's limits, inside the caller's namespaces, and returns its output and exit code", async () => {
  const slice = `llvgatetest${randomBytes(6).toString("hex")}.slice`;
  let run: Run | undefined;
  try {
    run = await runCaller("namespace-gate-limits", {}, ["bash", gate, "python3", "-c", PROBE], {
      DELEGATUS_AGENT_CPU: "auto", LLV_GATE_SLICE: slice, DELEGATUS_WORK_CPU_QUOTA: "200", DELEGATUS_WORK_SCOPE_CPU_QUOTA: "100",
      PROBE_BYTES: String(2 * CALLER_CAP), PROBE_EXIT: "7", PROBE_NESTED: gate,
    });
    expect(run.code, run.stderr).toBe(7);
    const probe = report(run);
    expect(probe.group, run.stderr).toMatch(SERVICE);
    expect(probe.group).toContain(`/${slice}/`);
    expect(probe.memoryMax).toBe(String(512 * 2 ** 20));
    expect(probe.cpuMax).toBe("20000 20000");
    expect(probe.allocated).toBe(2 * CALLER_CAP);
    expect(probe.pidNamespace).toBe(run.caller.pidNamespace);
    // A gate inside the gate reuses its slot, gets its own service and stays
    // in the same namespace.
    expect(probe.nested.code, probe.nested.stderr).toBe(0);
    expect(probe.nested.lines[0]).toMatch(SERVICE);
    expect(probe.nested.lines[0]).not.toBe(probe.group);
    expect(probe.nested.lines[1]).toBe(run.caller.pidNamespace);
  } finally {
    await cleanup(run);
    spawnSync("systemctl", ["--user", "revert", slice], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "stop", slice], { stdio: "ignore" });
  }
}, 120_000);

kernelTest.each(["owner", "supervisor"])("the gate service stops the command when its namespaced %s dies", async kill => {
  let run: Run | undefined;
  try {
    const root = os.tmpdir();
    const marker = path.join(fs.mkdtempSync(path.join(root, "namespace-gate-worker-")), "worker.json");
    run = await runCaller("namespace-gate-owner", { kill, killAfter: marker }, ["bash", gate, "python3", "-c", PROBE], { PROBE_MARKER: marker });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).group, run.stderr).toMatch(SERVICE);
    expect(JSON.parse(fs.readFileSync(path.join(run.root, "owner-death.json"), "utf8"))).toEqual({ workerStopped: true });
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  } finally { await cleanup(run); }
}, 120_000);

kernelTest("a caller that dropped its namespace context is refused before its command runs", async () => {
  let run: Run | undefined;
  try {
    run = await runCaller("namespace-gate-unset", { unsetContext: true }, ["bash", gate, "python3", "-c", PROBE], { PROBE_BYTES: "4096" });
    expect(run.code, run.stderr).toBe(69);
    expect(run.stderr).toContain("cannot see");
    expect(fs.existsSync(path.join(run.root, "probe-started"))).toBeFalse();
  } finally { await cleanup(run); }
}, 120_000);

kernelTest("without a reachable user manager the gate says so and runs in the caller's own bounded leaf", async () => {
  let run: Run | undefined;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "no-user-manager-"));
  try {
    fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 1\n", { mode: 0o700 });
    run = await runCaller("namespace-gate-fallback", {}, ["bash", gate, "python3", "-c", PROBE], { PATH: `${bin}:${process.env.PATH}`, PROBE_BYTES: "4096", PROBE_EXIT: "5" });
    expect(run.code, run.stderr).toBe(5);
    expect(run.stderr).toContain("no reachable systemd user manager");
    const probe = report(run);
    expect(probe.group).not.toMatch(SERVICE);
    expect(probe.group).toMatch(/\/gate-[0-9a-f-]+\/work$/);
    expect(probe.pidNamespace).toBe(run.caller.pidNamespace);
    if (outer) expect(run.stderr).toContain("effective memory cap is 0.09 GiB, below the gate's 512M");
  } finally {
    await cleanup(run);
    fs.rmSync(bin, { recursive: true, force: true });
  }
}, 120_000);
