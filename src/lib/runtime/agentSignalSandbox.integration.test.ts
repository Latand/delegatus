import { expect, spyOn, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { spawnSignalSandbox, spawnHeadlessSignalSandbox, spawnManagedEngine, signalDomain, signalAgentDomain, resolveSignalTooling, normalizeAgentSignalDomain } from "./agentSignalSandbox";
import { CopilotAcpHost } from "./copilotAcpHost";
import { FileRuntimeEventStore } from "./eventStore";
import { AgentMemoryCell, GIB } from "./agentMemory";
import { killOwnedRun, type LiveRun } from "@/lib/agent/headless";
import { AgentRegistry } from "@/lib/agent/registry";
import { stopTerminalStructuredOrphan } from "./registry";

const kernelTest = process.env.LLV_SIGNAL_SANDBOX_KERNEL_TEST === "1" ? test : test.skip;

kernelTest("the real orphan stop retains namespace custody until every supervisor and detached child is gone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-orphan-stop-"));
  const marker = path.join(root, "descendant");
  const foreign = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  const store = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
  let child: ChildProcess | undefined;
  try {
    child = await spawnSignalSandbox("python3", ["-c", String.raw`
import json,os,subprocess,sys,time
proc=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])['hostProc']
body="import os,time;open("+repr(sys.argv[1])+"+'.new','w').write(os.readlink("+repr(proc+"/self")+"));os.rename("+repr(sys.argv[1])+"+'.new',"+repr(sys.argv[1])+");time.sleep(60)"
subprocess.Popen(['python3','-c',body],start_new_session=True)
while True: time.sleep(1)
`, marker], { env: fixtureEnv(root), detached: true, stdio: "ignore" });
    const domain = signalDomain(child)!;
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(marker)).toBeTrue();
    const descendant = captureProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
    const key = { engine: "codex" as const, sessionId: "signal-orphan-fixture" };
    const columns = { kind: "codex-app-server" as const, endpoint: `stdio:${domain.native.pid}`, process: domain.native,
      eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [], signalDomain: domain };
    store.upsert({ key, artifactPath: "/sessions/fixture.jsonl", cwd: "/repo", accountId: null,
      status: "dead", host: null, claimEpoch: 0, claimOwner: "fixture-writer", pendingAction: null, structuredHost: columns });
    expect(await stopTerminalStructuredOrphan(store, key)).toBeFalse();
    expect(processIdentityStatus(domain.native)).toBe("alive");
    store.upsert({ ...store.readOnlySnapshot().entries["codex:signal-orphan-fixture"]!, claimOwner: null });
    const stopped = await stopTerminalStructuredOrphan(store, key, { graceMs: 100, deadlineMs: 3_000 });
    expect(stopped, JSON.stringify({ statuses: [domain.monitor, domain.bubblewrap, domain.init, domain.native, descendant].map(identity => processIdentityStatus(identity)), row: store.readOnlySnapshot().entries["codex:signal-orphan-fixture"] })).toBeTrue();
    for (const identity of [domain.monitor, domain.bubblewrap, domain.init, domain.native, descendant]) expect(processIdentityStatus(identity)).toBe("dead");
    expect(store.readOnlySnapshot().entries["codex:signal-orphan-fixture"]!.structuredHost?.signalDomain?.retired).toBeTrue();
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
  } finally { if (child) await close(child); await close(foreign); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

function fixtureEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state") };
  delete env.LLV_GATE_SLOT_LEASE;
  delete env.LLV_OWNED_TEST_RUN_CGROUP;
  return env;
}

async function close(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "close");
  if (signalDomain(child)) signalAgentDomain(child, "SIGKILL");
  else child.kill("SIGKILL");
  await ended;
}

const proof = String.raw`
import ctypes, errno, json, os, platform, signal, subprocess, sys, time
foreign, port, marker = int(sys.argv[1]), sys.argv[2], sys.argv[3]
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
assert os.getpid()>1 and os.readlink('/proc/self/ns/pid')==context['pidNamespace']
assert not os.path.exists('/proc/'+str(foreign))
libc=ctypes.CDLL(None,use_errno=True)
refused=[]
for name, args in [('kill',(foreign,15)),('kill',(foreign,0)),('kill',(-foreign,15)),
                   ('tkill',(foreign,15)),('tgkill',(foreign,foreign,15)),
                   ('sigqueue',(foreign,15,0))]:
    result=libc.syscall({'x86_64':200,'aarch64':130}[platform.machine()],*args) if name=='tkill' else getattr(libc,name)(*args)
    assert result==-1, name
    assert ctypes.get_errno() in [errno.ESRCH,errno.EPERM], (name,ctypes.get_errno())
    refused.append(name)
info=ctypes.create_string_buffer(128)
result=libc.syscall({'x86_64':297,'aarch64':240}[platform.machine()],foreign,foreign,15,ctypes.byref(info))
assert result==-1 and ctypes.get_errno() in [errno.ESRCH,errno.EPERM],ctypes.get_errno()
try:
    os.pidfd_open(foreign)
    raise AssertionError('foreign pidfd opened')
except ProcessLookupError: pass
try:
    fd=os.open(context['hostProc']+'/'+str(context['monitor']['pid'])+'/ns/pid',os.O_RDONLY)
    assert libc.setns(fd,0)==-1 and ctypes.get_errno()==errno.EPERM
    os.close(fd)
except PermissionError: pass
for command in [['/bin/kill','-TERM',str(foreign)], ['pkill','-TERM','-P',str(foreign)],
                ['killall','-TERM','foreign-signal'],['fuser','-k','-n','tcp',port]]:
    result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert result.returncode!=0, command
own=subprocess.Popen(['/bin/sleep','30'])
os.kill(own.pid,signal.SIGTERM)
assert own.wait(timeout=3)==-15
detached=subprocess.Popen(['/bin/sleep','30'],start_new_session=True)
os.kill(detached.pid,signal.SIGTERM)
assert detached.wait(timeout=3)==-15
bun=subprocess.run(['bun','-e',"const p=Bun.spawn(['/bin/sleep','30']);p.kill('SIGTERM');await p.exited;if(p.signalCode!=='SIGTERM')process.exit(1);"],capture_output=True)
assert bun.returncode==0,bun.stderr
nested=subprocess.run(['bwrap','--unshare-user','--unshare-pid','--bind','/','/','--proc','/proc','--dev','/dev','--cap-drop','ALL','--die-with-parent','--','python3','-c',
    "import os,subprocess; p=subprocess.Popen(['/bin/sleep','30']);os.kill(p.pid,15);assert p.wait(timeout=3)==-15"],capture_output=True)
assert nested.returncode==0,nested.stderr
# The intermediate parent exits; the grandchild is reparented to domain init.
reparented=os.fork()
if reparented==0:
    grandchild=os.fork()
    if grandchild==0:
        os.setsid()
        open(marker+'.local.new','w').write(str(os.getpid()))
        os.rename(marker+'.local.new',marker+'.local')
        while True: time.sleep(1)
    os._exit(0)
os.waitpid(reparented,0)
while not os.path.exists(marker+'.local'): time.sleep(.01)
grandchild=int(open(marker+'.local').read())
os.kill(grandchild,signal.SIGTERM)
deadline=time.monotonic()+3
while os.path.exists('/proc/'+str(grandchild)) and time.monotonic()<deadline: time.sleep(.01)
assert not os.path.exists('/proc/'+str(grandchild))
code="import os,time;open("+repr(marker+'.new')+",'w').write(os.readlink("+repr(context['hostProc']+'/self')+"));os.rename("+repr(marker+'.new')+","+repr(marker)+");time.sleep(60)"
survivor=subprocess.Popen(['python3','-c',code],start_new_session=True)
while not os.path.exists(marker): time.sleep(.01)
print(json.dumps({'refused':refused,'ownStopped':True,'detachedStopped':True,'survivor':survivor.pid}),flush=True)
while True: time.sleep(1)
`;

kernelTest("production signal domain refuses foreign syscalls and utilities, stops own children and reaps detached descendants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-domain-"));
  const env = fixtureEnv(root);
  const executable = path.join(root, "foreign-signal");
  fs.copyFileSync("/bin/sleep", executable); fs.chmodSync(executable, 0o700);
  const foreign = spawn(executable, ["60"], { detached: true, stdio: "ignore", env });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  process.kill(foreign.pid!, 0);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("foreign alive") });
  const marker = path.join(root, "detached.pid");
  let child: ChildProcess | undefined;
  try {
    child = await spawnSignalSandbox("python3", ["-c", proof, String(foreign.pid), String(server.port), marker], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let diagnostic = "";
    child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    const output = new Promise<string>(resolve => child!.stdout!.once("data", data => resolve(String(data))));
    const receipt = JSON.parse(await Promise.race([output, Bun.sleep(10_000).then(() => { throw new Error(`signal proof produced no receipt: ${diagnostic}`); }),
      once(child, "close").then(() => { throw new Error(`signal proof ended early: ${diagnostic}`); })]));
    expect(receipt).toMatchObject({ ownStopped: true, detachedStopped: true });
    expect(receipt.refused).toHaveLength(6);
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("foreign alive");
    const domain = signalDomain(child)!;
    expect(domain.native.pid).not.toBe(child.pid);
    expect(domain.init.pid).not.toBe(domain.native.pid);
    const survivor = captureProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
    expect(processIdentityStatus(survivor)).toBe("alive");
    await close(child);
    const deadline = Date.now() + 3_000;
    while (processIdentityStatus(survivor) === "alive" && Date.now() < deadline) await Bun.sleep(10);
    expect(processIdentityStatus(survivor)).toBe("dead");
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
  } finally {
    if (child) await close(child);
    await close(foreign); server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.env.LLV_SIGNAL_SANDBOX_KERNEL_TEST !== "1" || !process.env.LLV_SIGNAL_SANDBOX_IMAGE).each(["completion", "interruption"] as const)("the built image enters the host, drops UID and confines its host CLI and bundled gate: %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-container-"));
  const home = path.join(root, "home"); fs.mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(home, ".bun/bin/bun"));
  const temporary = path.join(root, "tmp"); fs.mkdirSync(temporary);
  const domainFile = path.join(root, "domain.json");
  const proofFile = path.join(root, "proof");
  const foreign = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  const source = `import {spawnSignalSandbox, signalAgentDomain, signalDomain, resolveSignalTooling} from './src/lib/runtime/agentSignalSandbox.ts';
import fs from 'node:fs';
const tooling=resolveSignalTooling();
if(tooling.gate.startsWith('/app/')) throw new Error('container path escaped into host tooling');
const code=${JSON.stringify(`try {process.kill(${foreign.pid},'SIGTERM');throw Error('foreign signal succeeded')} catch(e) {if(e.code!=='ESRCH')throw e;}
const child=Bun.spawn(['/bin/sleep','30']);child.kill('SIGTERM');await child.exited;if(child.signalCode!=='SIGTERM')throw Error('own cleanup failed');
const gate=Bun.spawn(['bash',process.env.FIXTURE_GATE,'/bin/echo','container-gate'],{stdout:'pipe',stderr:'pipe'});
const [status,out,err]=await Promise.all([gate.exited,new Response(gate.stdout).text(),new Response(gate.stderr).text()]);
if(status!==0||out.trim()!=='container-gate')throw Error(err);
if(${mode === "interruption"}) {await Bun.write(${JSON.stringify(proofFile)},'ready');await Bun.sleep(60_000);}
console.log('container signal proof complete');`)};
const child=await spawnSignalSandbox('bun',['-e',code],{env:{...process.env,FIXTURE_GATE:tooling.gate},stdio:['ignore','pipe','pipe']});
fs.writeFileSync(${JSON.stringify(domainFile + ".new")},JSON.stringify(signalDomain(child)));
fs.renameSync(${JSON.stringify(domainFile + ".new")},${JSON.stringify(domainFile)});
let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
try {await new Promise(r=>child.once('close',r));if(child.exitCode!==0||out.trim()!=='container signal proof complete')throw Error(err||out);console.log('bridge passed');}
finally {if(child.exitCode===null&&child.signalCode===null)signalAgentDomain(child,'SIGKILL');}
`;
  const create = spawnSync("docker", ["create", "--privileged", "--pid=host", "--network=host", "--user", `${process.getuid!()}:${process.getgid!()}`,
    "--mount", `type=bind,source=${root},target=${root}`, "--workdir", "/app",
    "-e", `HOME=${home}`, "-e", `TMPDIR=${temporary}`, "-e", `XDG_CONFIG_HOME=${root}/config`, "-e", `LLV_STATE_DIR=${root}/state`,
    "-e", `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`, "-e", `DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS}`,
    "-e", `PATH=/usr/local/bin:${home}/.bun/bin:/usr/bin:/bin`, "-e", "LLV_DOCKER_NSENTER_SHIMS=1",
    "-e", `LLV_GATE_LOCK_DIR=${root}/slots`, "-e", "LLV_GATE_SLOTS=1", "-e", "LLV_GATE_MEM=64M", "-e", "DELEGATUS_CPU_PRESSURE=off",
    "--entrypoint", "/usr/local/bin/bun-container", process.env.LLV_SIGNAL_SANDBOX_IMAGE!, "-e", source], { encoding: "utf8", timeout: 10_000 });
  let id: string | undefined;
  try {
    expect(create.status, create.stderr).toBe(0); id = create.stdout.trim(); expect(id).toMatch(/^[a-f0-9]{64}$/);
    const container = spawn("docker", ["start", "--attach", id], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(container, "close");
    let output = "", errors = ""; container.stdout.on("data", chunk => { output += chunk; }); container.stderr.on("data", chunk => { errors += chunk; });
    if (mode === "interruption") {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(proofFile) && container.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      expect(fs.existsSync(proofFile), errors).toBeTrue();
      const domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(domainFile, "utf8")))!;
      expect(processIdentityStatus(domain.native)).toBe("alive");
      expect(spawnSync("docker", ["rm", "--force", id], { stdio: "ignore", timeout: 10_000 }).status).toBe(0);
    }
    await closed;
    if (mode === "completion") { expect(container.exitCode, errors).toBe(0); expect(output.trim()).toBe("bridge passed"); }
    else expect(container.exitCode).not.toBe(0);
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) spawnSync("docker", ["rm", "--force", id], { stdio: "ignore", timeout: 10_000 });
    try {
      if (fs.existsSync(domainFile)) {
        const domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(domainFile, "utf8")))!;
        // The host CLI moved into its own scope. Removing the container alone
        // cannot reap that scope if the fixture was interrupted.
        for (const identity of [domain.init, domain.monitor]) {
          if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
        }
        const end = Date.now() + 3_000;
        const identities = [domain.init, domain.native, domain.bubblewrap, domain.monitor];
        while (identities.some(identity => processIdentityStatus(identity) === "alive") && Date.now() < end) await Bun.sleep(10);
        expect(identities.map(identity => processIdentityStatus(identity))).toEqual(["dead", "dead", "dead", "dead"]);
      }
    } finally { await close(foreign); fs.rmSync(root, { recursive: true, force: true }); }
  }
}, 45_000);

kernelTest("caller pidfds and ancestor namespace descriptors cannot cross the production launcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-descriptors-"));
  const body = String.raw`
import ctypes,errno,os,subprocess,sys
foreign=subprocess.Popen(['/bin/sleep','30'])
libc=ctypes.CDLL(None,use_errno=True)
pidfd=os.pidfd_open(foreign.pid)
nsfd=os.open('/proc/self/ns/pid',os.O_RDONLY)
assert libc.pidfd_send_signal(pidfd,0,None,0)==0
inside='''
import ctypes,errno,os,subprocess,sys
libc=ctypes.CDLL(None,use_errno=True)
assert libc.pidfd_send_signal(int(sys.argv[1]),15,None,0)==-1
assert ctypes.get_errno() in [errno.EBADF,errno.EINVAL,errno.EPERM]
assert libc.setns(int(sys.argv[2]),0)==-1
assert ctypes.get_errno() in [errno.EBADF,errno.EINVAL,errno.EPERM]
print('descriptors refused')
'''
try:
    result=subprocess.run(['python3',sys.argv[1],'--automatic','--','python3','-c',inside,str(pidfd),str(nsfd)],pass_fds=(pidfd,nsfd),capture_output=True,text=True,timeout=10)
    assert result.returncode==0,result.stderr
    assert result.stdout.strip()=='descriptors refused'
    assert foreign.poll() is None
finally:
    foreign.terminate();foreign.wait();os.close(pidfd);os.close(nsfd)
`;
  const child = spawn("python3", ["-c", body, resolveSignalTooling().launcher], { env: fixtureEnv(root), stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; }); child.stdout.resume();
  try { await once(child, "close"); expect(child.exitCode, errors).toBe(0); }
  finally { await close(child); fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

kernelTest("headless receipt removal and corruption cannot throw out of the cleanup callback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-headless-receipt-"));
  const child = spawnHeadlessSignalSandbox("/bin/sleep", ["60"], { env: fixtureEnv(root), detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
  const receipt = child.spawnargs[child.spawnargs.indexOf("--receipt") + 1]!;
  const timer = setTimeout(() => {}, 60_000); timer.unref();
  try {
    const end = Date.now() + 10_000;
    while (!fs.existsSync(receipt) && Date.now() < end && child.exitCode === null) await Bun.sleep(10);
    expect(fs.existsSync(receipt), errors).toBeTrue();
    const domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(receipt, "utf8")))!;
    const read = fs.readFileSync;
    const removed = spyOn(fs, "readFileSync").mockImplementation((file: unknown, options: unknown) => {
      if (file === receipt) throw Object.assign(new Error("receipt removed"), { code: "ENOENT" });
      return Reflect.apply(read, fs, [file, options]);
    });
    try { expect(signalDomain(child)).toBeUndefined(); } finally { removed.mockRestore(); }
    fs.writeFileSync(receipt, "{");
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      const run: LiveRun = { child, identity: domain.monitor.startIdentity, identityOf: pid => captureProcessIdentity(pid).startIdentity,
        startedAt: Date.now(), exit: null, terminationStarted: false, timer };
      expect(() => killOwnedRun(run)).not.toThrow();
      expect(diagnostic).toHaveBeenCalled();
    } finally { diagnostic.mockRestore(); }
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    const stopped = Date.now() + 3_000;
    while (processIdentityStatus(domain.native) === "alive" && Date.now() < stopped) await Bun.sleep(10);
    expect(processIdentityStatus(domain.native)).toBe("dead");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); } fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

kernelTest("file-backed headless work survives its Viewer process and reaps detached children on completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-headless-restart-"));
  const ready = path.join(root, "child.pid"), stop = path.join(root, "finish"), receipt = path.join(root, "domain.json");
  const viewer = path.join(root, "viewer.ts");
  const body = String.raw`
import json,os,subprocess,sys,time
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
code="import os,time;open("+repr(sys.argv[1]+'.new')+",'w').write(os.readlink("+repr(context['hostProc']+'/self')+"));os.rename("+repr(sys.argv[1]+'.new')+","+repr(sys.argv[1])+");time.sleep(60)"
subprocess.Popen(['python3','-c',code],start_new_session=True)
while not os.path.exists(sys.argv[2]):time.sleep(.02)
`;
  fs.writeFileSync(viewer, `import fs from "node:fs";
import { launchDetached, headlessRuns } from ${JSON.stringify(path.resolve("src/lib/agent/headless.ts"))};
import { signalDomain } from ${JSON.stringify(path.resolve("src/lib/runtime/agentSignalSandbox.ts"))};
const root=${JSON.stringify(root)};
launchDetached({key:'restart-proof',built:{command:'python3',args:['-c',${JSON.stringify(body)},${JSON.stringify(ready)},${JSON.stringify(stop)}],env:process.env,stdin:null,outputPath:null,sessionId:null,reviewerPath:null},cwd:root,stdoutPath:root+'/stdout',stderrPath:root+'/stderr',timeoutMs:60000,onExit:()=>{}});
const run=headlessRuns.get('restart-proof');
const deadline=Date.now()+10000;
while(!fs.existsSync(${JSON.stringify(ready)})) {if(run.exit||Date.now()>deadline)throw Error(fs.readFileSync(root+'/stderr','utf8')||'headless readiness expired');await Bun.sleep(10);}
fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(signalDomain(run.child)));
process.exit(0);
`);
  const child = spawn(process.execPath, [viewer], { cwd: process.cwd(), env: { ...fixtureEnv(root), DELEGATUS_AGENT_MEMORY: "off", DELEGATUS_AGENT_CPU: "off" }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  let domain: ReturnType<typeof normalizeAgentSignalDomain>;
  try {
    await once(child, "close"); expect(child.exitCode, errors).toBe(0);
    domain = normalizeAgentSignalDomain(JSON.parse(fs.readFileSync(receipt, "utf8")))!;
    const descendant = captureProcessIdentity(Number(fs.readFileSync(ready, "utf8")));
    expect(processIdentityStatus(domain.monitor)).toBe("alive");
    expect(processIdentityStatus(domain.native)).toBe("alive");
    fs.writeFileSync(stop, "finish");
    const end = Date.now() + 5_000;
    while ([domain.monitor, domain.init, domain.native, descendant].some(identity => processIdentityStatus(identity) === "alive") && Date.now() < end) await Bun.sleep(10);
    for (const identity of [domain.monitor, domain.init, domain.native, descendant]) expect(processIdentityStatus(identity)).toBe("dead");
  } finally {
    if (domain) for (const identity of [domain.init, domain.monitor]) if (processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
    await close(child); fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

kernelTest("a private memory OOM ends the namespace's detached children and leaves a foreign fixture alive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-oom-"));
  const marker = path.join(root, "detached.pid");
  const foreign = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  const unit = `delegatus-agent-signal-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}.scope`;
  const cell = new AgentMemoryCell({ mechanism: "scope", platform: "linux", limitBytes: 64 * 2 ** 20, budgetBytes: GIB, reserveBytes: GIB, totalBytes: 8 * GIB,
    score: 500, unit, slice: "app.slice", viewerUnit: null, systemdVersion: 255 });
  let child: ChildProcess | undefined;
  try {
    const source = `const fs=require('node:fs'); const c=JSON.parse(process.env.LLV_SIGNAL_SANDBOX); const marker=${JSON.stringify(marker)};
const code='import os,time;open('+JSON.stringify(marker)+',"w").write(os.readlink('+JSON.stringify(c.hostProc+'/self')+'));time.sleep(30)';
Bun.spawn(['python3','-c',code],{detached:true,stdout:'ignore',stderr:'ignore'});
while(!fs.existsSync(marker)) await Bun.sleep(10); console.log('ready'); await Bun.sleep(200);
const memory=new Uint8Array(256*1024*1024);for(let i=0;i<memory.length;i+=4096)memory[i]=1;console.log(memory.length);`;
    child = await spawnManagedEngine(process.execPath, ["-e", source], { env: fixtureEnv(root), detached: true }, cell);
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; }); child.stdout!.resume();
    const end = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < end) await Bun.sleep(10);
    expect(fs.existsSync(marker), errors).toBeTrue();
    const descendant = captureProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    cell.settleExit({ expected: false });
    expect(cell.snapshot().lastKill).toMatchObject({ limit: "agent", fatal: true });
    expect(processIdentityStatus(descendant)).toBe("dead");
    expect(processIdentityStatus(foreignIdentity)).toBe("alive");
  } finally { if (child) await close(child); cell.close(); await close(foreign); fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

kernelTest("setup failure and an inherited external lease prevent engine execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-refusal-"));
  const marker = path.join(root, "engine-ran");
  try {
    const env = fixtureEnv(root);
    await expect(spawnSignalSandbox("/usr/bin/touch", [marker], { env: { ...env, LLV_GATE_SLOT_LEASE: "external" } })).rejects.toThrow("cross-user-namespace");
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.symlinkSync("/usr/bin/python3", path.join(bin, "python3"));
    await expect(spawnSignalSandbox("/usr/bin/touch", [marker], { env: { ...env, PATH: bin } })).rejects.toThrow("missing: bwrap");
    expect(fs.existsSync(marker)).toBeFalse();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

kernelTest.each(["native-exit", "monitor-death", "init-death"])("owned namespace descendants end after %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-lifetime-"));
  const marker = path.join(root, "descendant.pid");
  const body = String.raw`
import json,os,subprocess,sys,time
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
code="import os,time;open("+repr(sys.argv[1]+'.new')+",'w').write(os.readlink("+repr(context['hostProc']+'/self')+"));os.rename("+repr(sys.argv[1]+'.new')+","+repr(sys.argv[1])+");time.sleep(60)"
subprocess.Popen(['python3','-c',code],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
while not os.path.exists(sys.argv[1]):time.sleep(.01)
print('ready',flush=True)
sys.stdin.readline()
`;
  const child = await spawnSignalSandbox("python3", ["-c", body, marker], { env: fixtureEnv(root), stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    const descendant = captureProcessIdentity(Number(fs.readFileSync(marker, "utf8")));
    const domain = signalDomain(child)!;
    const ended = once(child, "close");
    if (mode === "native-exit") child.stdin!.end("exit\n");
    else if (mode === "monitor-death") child.kill("SIGKILL");
    else signalAgentDomain(child, "SIGKILL");
    await Promise.race([ended, Bun.sleep(5_000).then(() => { throw new Error("namespace lifetime did not settle"); })]);
    const deadline = Date.now() + 3_000;
    while (processIdentityStatus(descendant) === "alive" && Date.now() < deadline) await Bun.sleep(10);
    expect(processIdentityStatus(descendant)).toBe("dead");
    expect(processIdentityStatus(domain.native)).toBe("dead");
    if (mode === "monitor-death") fs.rmSync(domain.directory, { recursive: true, force: true });
  } finally { await close(child); fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);

kernelTest("the synthetic Copilot protocol uses the production boundary on fresh and resumed launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-copilot-"));
  const binary = path.join(root, "copilot-fixture");
  const foreign = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  fs.writeFileSync(binary, `#!/usr/bin/python3\nimport json,os,subprocess,sys\nforeign=${foreign.pid}\n` + String.raw`
context=json.loads(os.environ['LLV_SIGNAL_SANDBOX'])
assert os.readlink('/proc/self/ns/pid')==context['pidNamespace']
try:
    os.kill(foreign,15)
    raise AssertionError('foreign signal succeeded')
except ProcessLookupError: pass
own=subprocess.Popen(['/bin/sleep','30'],start_new_session=True)
os.kill(own.pid,15)
assert own.wait(timeout=3)==-15
for line in sys.stdin:
    rpc=json.loads(line)
    if 'id' not in rpc: continue
    result={'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'}} if rpc['method']=='initialize' else {'sessionId':'signal-copilot-fixture'} if rpc['method']=='session/new' else {}
    print(json.dumps({'jsonrpc':'2.0','id':rpc['id'],'result':result}),flush=True)
    if rpc['method']=='session/close': break
`, { mode: 0o700 });
  const options = { binary, cwd: root, env: fixtureEnv(root), copilotHome: path.join(root, "config"),
    mcpServers: [], viewerMcpServer: null, eventStore: new FileRuntimeEventStore(path.join(root, "events")) };
  let host: CopilotAcpHost | undefined;
  try {
    for (const resumed of [false, true]) {
      host = resumed ? await CopilotAcpHost.adopt("signal-copilot-fixture", options) : await CopilotAcpHost.start(options);
      const state = await host.health();
      expect(state.signalDomain?.native.pid).toBe(state.pid!);
      expect(processIdentityStatus(foreignIdentity)).toBe("alive");
      await host.release(); host = undefined;
    }
  } finally { await host?.release(); await close(foreign); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
