import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawnSignalSandbox, signalAgentDomain, signalDomain } from "./agentSignalSandbox";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const gate = path.resolve("scripts/gate-slot.sh");
const kernelTest = process.env.LLV_SIGNAL_SANDBOX_KERNEL_TEST === "1" ? test : test.skip;

kernelTest("a gate service and a nested gate service stay in the signal domain and reuse one kernel-held slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "namespace-gates-"));
  // CPU placement on a slice of this test's own, never the live work slice.
  const slice = `llvgatetest${randomBytes(6).toString("hex")}.slice`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    LLV_GATE_LOCK_DIR: path.join(root, "slots"), LLV_GATE_SLOTS: "1", LLV_GATE_MEM: "64M", DELEGATUS_AGENT_CPU: "auto", LLV_GATE_SLICE: slice,
    DELEGATUS_WORK_CPU_QUOTA: "200", DELEGATUS_WORK_SCOPE_CPU_QUOTA: "100%", DELEGATUS_CPU_PRESSURE: "off", LLV_OWNED_RUN_TIMEOUT_MS: "10000" };
  delete env.LLV_GATE_SLOT_LEASE;
  const file = path.join(root, "report.py");
  fs.writeFileSync(file, String.raw`
import json,os,subprocess
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
group=open('/proc/self/cgroup').read().strip()[3:]
assert '/delegatus-gate-' in group and group.endswith('.service'),group
base='/sys/fs/cgroup'+group
lease=json.loads(os.environ['LLV_GATE_SLOT_LEASE'])
assert lease['owner']['pid']>1 and lease['owner']['bootEpoch']==context['hostEpoch']
assert os.readlink('/proc/self/ns/pid')==context['pidNamespace']
assert open(base+'/cpu.max').read().strip()=='20000 20000'
assert open(base+'/memory.max').read().strip()=='67108864'
nested=subprocess.run(['bash',os.environ['FIXTURE_GATE'],'/bin/echo','nested'],capture_output=True,text=True,timeout=5)
assert nested.returncode==0,nested.stderr
assert nested.stdout.strip()=='nested'
marker=os.environ['TMPDIR']+'/cross-lease-executed'
cross=subprocess.run(['bwrap','--unshare-user','--unshare-pid','--bind','/','/','--proc','/proc','--dev','/dev','--cap-drop','ALL','--die-with-parent','--',
    'bash',os.environ['FIXTURE_GATE'],'/usr/bin/touch',marker],capture_output=True,text=True,timeout=5)
assert cross.returncode==69,cross.stderr
assert 'cross-boundary lease transfer is unsupported' in cross.stderr,cross.stderr
assert not os.path.exists(marker)
print(json.dumps({'bounded':True,'nested':True,'crossLeaseRefused':True,'group':group}))
`);
  const child = await spawnSignalSandbox("bash", [gate, "python3", file], { env: { ...env, FIXTURE_GATE: gate }, stdio: ["pipe", "pipe", "pipe"] });
  const output: string[] = [], errors: string[] = [];
  child.stdout!.on("data", chunk => output.push(String(chunk))); child.stderr!.on("data", chunk => errors.push(String(chunk)));
  try {
    await Promise.race([once(child, "close"), Bun.sleep(20_000).then(() => { throw new Error(`bounded gate did not finish: ${errors.join("")}`); })]);
    expect(child.exitCode, errors.join("")).toBe(0);
    expect(JSON.parse(output.join("").trim())).toMatchObject({ bounded: true, nested: true, crossLeaseRefused: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { signalAgentDomain(child, "SIGKILL"); await once(child, "close"); }
    fs.rmSync(root, { recursive: true, force: true });
    spawnSync("systemctl", ["--user", "revert", slice], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "stop", slice], { stdio: "ignore" });
  }
}, 30_000);

kernelTest.each(["deadline", "owner-death", "stopped-runner", "nested-deadline", "cgroup-rename-attempt"])("a namespaced caller's gate reaps a detached workload on %s before its engine exits", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "namespace-gate-stop-"));
  const marker = path.join(root, "worker.pid"), ready = path.join(root, "returned"), ownerFile = path.join(root, "owner.pid");
  const script = path.join(root, "worker.py");
  fs.writeFileSync(script, String.raw`
import json,os,signal,subprocess,time
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
if os.environ['WORKER_MODE']=='cgroup-rename-attempt':
    group='/sys/fs/cgroup'+open('/proc/self/cgroup').read().strip()[3:]
    try: os.rename(group,group+'-moved')
    except OSError: pass  # The gate service's cgroup is read-only inside the domain.
code='import os,time;open('+repr(os.environ['WORKER_PID_FILE'])+",'w').write(os.readlink("+repr(context['hostProc']+'/self')+'));time.sleep(60)'
subprocess.Popen(['python3','-c',code],start_new_session=True)
while not os.path.exists(os.environ['WORKER_PID_FILE']): time.sleep(.01)
# The gate's owner is the caller's runner, recorded by the caller's shell; the
# worker's own parent is the service's entry, outside this namespace.
if os.environ['WORKER_MODE'] in ('owner-death','stopped-runner'):
    while not os.path.exists(os.environ['OWNER_FILE']): time.sleep(.01)
    owner=int(open(os.environ['OWNER_FILE']).read())
    os.kill(owner,signal.SIGKILL if os.environ['WORKER_MODE']=='owner-death' else signal.SIGSTOP)
while True: time.sleep(1)
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    LLV_GATE_LOCK_DIR: path.join(root, "slots"), LLV_GATE_SLOTS: "1", LLV_GATE_MEM: "64M", DELEGATUS_CPU_PRESSURE: "off", LLV_OWNED_RUN_TIMEOUT_MS: "1000",
    WORKER_PID_FILE: marker, WORKER_MODE: mode, OWNER_FILE: ownerFile };
  delete env.LLV_GATE_SLOT_LEASE;
  const invocation = mode === "nested-deadline" ? `bash ${quote(gate)} python3 ${quote(script)}` : `python3 ${quote(script)}`;
  const child = await spawnSignalSandbox("bash", ["-c", `bash ${quote(gate)} bash -c ${quote(invocation)} & printf %s $! > ${quote(ownerFile)}; wait $!; printf returned > ${quote(ready)}; read -r done`], { env, stdio: ["pipe", "pipe", "pipe"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += String(chunk); });
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(marker), errors).toBeTrue();
    const worker = captureProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
    // A stopped runner cannot return; the service's own deadline still reaps.
    if (mode !== "stopped-runner") {
      while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      expect(fs.existsSync(ready), errors).toBeTrue();
    }
    while (processIdentityStatus(worker) === "alive" && Date.now() < deadline) await Bun.sleep(10);
    expect(processIdentityStatus(worker), errors).toBe("dead");
    expect(child.exitCode).toBeNull();
  } finally {
    signalAgentDomain(child, "SIGKILL"); await once(child, "close");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

kernelTest("host and namespace clients share FIFO tickets and one kernel slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "namespace-mixed-queue-"));
  const first = path.join(root, "first"), second = path.join(root, "second");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    LLV_GATE_LOCK_DIR: path.join(root, "slots"), LLV_GATE_SLOTS: "1", LLV_GATE_MEM: "64M", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_POLL_SECONDS: ".05" };
  delete env.LLV_GATE_SLOT_LEASE;
  const host = spawn("bash", [gate, "bash", "-c", `printf first > ${quote(first)}; read -r release`], { env, stdio: ["pipe", "pipe", "pipe"] });
  let protectedChild: ChildProcess | undefined, later: ChildProcess | undefined, errors = "";
  host.stderr.on("data", chunk => { errors += chunk; });
  const waitFor = async (condition: () => boolean) => {
    const end = Date.now() + 15_000;
    while (!condition() && Date.now() < end) await Bun.sleep(10);
    expect(condition(), errors).toBeTrue();
  };
  try {
    await waitFor(() => fs.existsSync(first));
    protectedChild = await spawnSignalSandbox("bash", [gate, "bash", "-c", `printf second > ${quote(second)}; read -r release`], { env, stdio: ["pipe", "pipe", "pipe"] });
    protectedChild.stderr!.on("data", chunk => { errors += chunk; });
    const queue = new Database(path.join(env.LLV_GATE_LOCK_DIR!, "admission.sqlite"), { readonly: true });
    try {
      const owners = () => queue.query<{ owner: string }, []>("SELECT owner FROM tickets WHERE owner IS NOT NULL ORDER BY seq").all();
      await waitFor(() => owners().length === 1);
      const firstOwner = JSON.parse(owners()[0]!.owner);
      expect(firstOwner.pid).toBe(signalDomain(protectedChild)!.native.pid);
      expect(fs.existsSync(second)).toBeFalse();
      later = spawn("bash", [gate, "bash", "-c", `test -f ${quote(second)} && printf later`], { env, stdio: ["pipe", "pipe", "pipe"] });
      later.stderr!.on("data", chunk => { errors += chunk; });
      await waitFor(() => owners().length === 2);
      expect(JSON.parse(owners()[0]!.owner)).toEqual(firstOwner);
      expect(fs.existsSync(second)).toBeFalse();
      host.stdin.end("release\n"); await once(host, "close");
      await waitFor(() => fs.existsSync(second));
      expect(later.exitCode).toBeNull();
      protectedChild.stdin!.end("release\n"); await once(protectedChild, "close");
      await once(later, "close");
      expect([host.exitCode, protectedChild.exitCode, later.exitCode], errors).toEqual([0, 0, 0]);
      expect(owners()).toEqual([]);
    } finally { queue.close(); }
  } finally {
    for (const child of [host, protectedChild, later]) if (child && child.exitCode === null && child.signalCode === null) {
      if (signalAgentDomain(child, "SIGKILL") === undefined) child.kill("SIGKILL");
      await once(child, "close");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 50_000);
