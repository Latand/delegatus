import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { startCheckBroker } from "./check-worker-broker";
import { CheckAdmission } from "./check-admission";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";
import { onlineCpuCount } from "../src/lib/runtime/cpuPlacement";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import * as ownerContext from "../src/lib/runtime/signalSandboxContext";
import { captureProcessIdentity } from "../src/lib/processIdentity";
import { inheritedCpuSlot } from "../src/lib/runtime/cpuAdmission";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { reuseGateSlot } from "./check-worker-client.mjs";

async function until(check: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("broker fixture did not reach its barrier");
    await Bun.sleep(10);
  }
}

for (const refusal of ["nonce", "ancestor", "self", "host namespace", "kind", "malformed", "oversized"] as const) test(`broker refuses ${refusal} before recording a worker`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-refusal-"));
  const file = path.join(root, "checks.sqlite");
  const broker = await startCheckBroker();
  const address = JSON.parse(broker.address);
  const socket = net.connect(address.port, "127.0.0.1");
  let response = ""; socket.on("data", data => { response += String(data); });
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.once("connect", () => socket.write(refusal === "oversized" ? "x".repeat(64_001) + "\n" : refusal === "malformed" ? "{\n" : JSON.stringify({
    nonce: refusal === "nonce" ? "invalid" : address.nonce,
    pid: refusal === "self" ? process.pid : process.ppid,
    hostPid: refusal === "host namespace" ? process.pid : undefined,
    kind: refusal === "kind" ? "invalid" : "compiler", env: { LLV_CHECK_ADMISSION_FILE: file },
  }) + "\n"));
  try {
    await closed;
    if (refusal === "oversized") expect(response).toBe("");
    else expect(response).toContain("error");
    expect(fs.existsSync(file)).toBe(false);
    if (refusal === "oversized") await broker.close();
    else await expect(broker.close()).rejects.toThrow("check admission failed");
  } finally { socket.destroy(); await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const queued of [true, false]) test(`broker disconnect removes a ${queued ? "queued" : "held"} ticket and ends the exact worker`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-disconnect-"));
  const file = path.join(root, "checks.sqlite"), ready = path.join(root, "ready");
  const queue = new CheckAdmission(file);
  const broker = await startCheckBroker();
  const env = { LLV_CHECK_ADMISSION_FILE: file, DELEGATUS_GATE_CPU_HEADROOM: String(onlineCpuCount() - 1) };
  if (queued) expect(queue.claim(cpuOwnerIdentity(process.pid), 1)).toBe(true);
  const source = `import net from "node:net"; import fs from "node:fs";
    const address = ${broker.address};
    const socket = net.connect(address.port, "127.0.0.1");
    socket.once("connect", () => socket.write(JSON.stringify({nonce:address.nonce,pid:process.pid,hostPid:process.pid,kind:"compiler",env:${JSON.stringify(env)}}) + "\\n"));
    socket.once("data", () => { fs.writeFileSync(${JSON.stringify(ready)}, "ready"); socket.destroy(); });
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", source], { env: process.env, stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const rows = () => queue.db.query<{ held: number }, []>("SELECT held FROM checks").all();
  try {
    if (queued) {
      await until(() => rows().length === 2);
      expect(rows().map(row => row.held)).toEqual([1, 0]);
      expect(fs.existsSync(ready)).toBe(false);
      await stopFixtureProcess(child);
      await until(() => rows().length === 1);
      queue.cancel(cpuOwnerIdentity(process.pid));
    } else {
      await until(() => fs.existsSync(ready));
      await exited;
      expect(child.signalCode).toBe("SIGKILL");
    }
    await until(() => rows().length === 0);
    await broker.close();
  } finally {
    await stopFixtureProcess(child); await broker.close().catch(() => {}); queue.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate admission cannot lend or cancel the original worker's ticket", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-duplicate-"));
  const file = path.join(root, "checks.sqlite"), ready = path.join(root, "ready");
  const queue = new CheckAdmission(file), broker = await startCheckBroker();
  const address = JSON.parse(broker.address);
  const env = { LLV_CHECK_ADMISSION_FILE: file };
  const source = `import net from "node:net"; import fs from "node:fs";
    const address = ${broker.address}; const socket = net.connect(address.port,"127.0.0.1");
    socket.once("connect",()=>socket.write(JSON.stringify({nonce:address.nonce,pid:process.pid,kind:"compiler",env:${JSON.stringify(env)}})+"\\n"));
    socket.once("data",()=>fs.writeFileSync(${JSON.stringify(ready)},"ready")); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", source], { env: process.env, stdio: "ignore" });
  let duplicate: net.Socket | undefined;
  try {
    await until(() => fs.existsSync(ready));
    const receipt = queue.db.query("SELECT * FROM checks").all();
    duplicate = net.connect(address.port, "127.0.0.1");
    let response = ""; duplicate.on("data", data => { response += String(data); });
    const closed = new Promise(resolve => duplicate!.once("close", resolve));
    duplicate.once("connect", () => duplicate!.write(JSON.stringify({ nonce: address.nonce, pid: child.pid, kind: "compiler", env }) + "\n"));
    await closed;
    expect(response).toContain("already has an admission controller");
    expect(queue.db.query("SELECT * FROM checks").all()).toEqual(receipt);
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    await stopFixtureProcess(child);
    await until(() => queue.db.query("SELECT * FROM checks").all().length === 0);
    await expect(broker.close()).rejects.toThrow("check admission failed");
  } finally {
    duplicate?.destroy(); await stopFixtureProcess(child); await broker.close().catch(() => {});
    queue.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unverified host probe cannot release a still-running local worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-identity-loss-"));
  const file = path.join(root, "checks.sqlite"), ready = path.join(root, "ready");
  const queue = new CheckAdmission(file), broker = await startCheckBroker();
  const source = `import net from "node:net"; import fs from "node:fs";
    const address = ${broker.address}; const socket = net.connect(address.port,"127.0.0.1");
    socket.once("connect",()=>socket.write(JSON.stringify({nonce:address.nonce,pid:process.pid,kind:"compiler",env:{LLV_CHECK_ADMISSION_FILE:${JSON.stringify(file)}}})+"\\n"));
    socket.once("data",()=>fs.writeFileSync(${JSON.stringify(ready)},"ready")); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", source], { env: process.env, stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let restore = () => {};
  try {
    await until(() => fs.existsSync(ready));
    const owner = JSON.parse(queue.db.query<{ owner: string }, []>("SELECT owner FROM checks").get()!.owner);
    const original = ownerContext.cpuOwnerStatus;
    const probe = spyOn(ownerContext, "cpuOwnerStatus").mockImplementation((identity, env) => identity.pid === owner.pid ? "unverified" : original(identity, env));
    restore = () => { probe.mockRestore(); };
    expect(ownerContext.cpuOwnerStatus(owner)).toBe("unverified");
    await until(() => queue.db.query("SELECT * FROM checks").all().length === 0);
    const stopped = await Promise.race([exited.then(() => true), Bun.sleep(500).then(() => false)]);
    expect(stopped, "worker continues after its ticket was deleted").toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    restore();
    await broker.close();
  } finally {
    restore(); await stopFixtureProcess(child); await broker.close().catch(() => {});
    queue.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const state of ["held", "unregistered", "different lease", "different directory", "released"] as const) test.skipIf(process.platform !== "linux")(`slot broker rechecks its kernel lease: ${state}`, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"slot-broker-")), ready=path.join(root,"ready");
  const slot=path.join(root,"llv-heavy-gate.slot1.lock");
  const holder=spawn("bash",["-c",'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60',"holder",slot,ready],{stdio:"ignore"});
  const broker=await startCheckBroker();
  let requester:ReturnType<typeof spawn>|undefined;
  try {
    await until(()=>fs.existsSync(ready));
    const lease={owner:captureProcessIdentity(holder.pid!),slot};
    const env=withoutInheritedGate({...process.env});
    Object.assign(env,{LLV_GATE_LOCK_DIR:root,LLV_GATE_SLOTS:"1",LLV_GATE_SLOT_LEASE:JSON.stringify(lease),LLV_GATE_SLOT_BROKER:broker.address});
    expect(inheritedCpuSlot(env)).toEqual(lease);
    if(state!=="unregistered") broker.provideCpuSlot(lease,env);
    if(state==="different lease") env.LLV_GATE_SLOT_LEASE="null";
    if(state==="different directory") {env.LLV_GATE_LOCK_DIR=path.join(root,"other");fs.mkdirSync(env.LLV_GATE_LOCK_DIR);}
    if(state==="released") await stopFixtureProcess(holder);
    const source=`import { reuseGateSlot } from ${JSON.stringify(path.join(import.meta.dir,"check-worker-client.mjs"))}; console.log(await reuseGateSlot());`;
    requester=spawn(process.execPath,["-e",source],{env,stdio:["ignore","pipe","pipe"]});
    let output="",error=""; requester.stdout!.on("data",v=>output+=v); requester.stderr!.on("data",v=>error+=v);
    const code=await new Promise<number|null>(resolve=>requester!.once("close",resolve));
    expect(code,error).toBe(0);expect(output.trim()).toBe(String(state==="held"));
    await broker.close();
  } finally {
    if(requester) await stopFixtureProcess(requester);await stopFixtureProcess(holder);await broker.close().catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true});
  }
},30_000);

test.skipIf(process.platform !== "linux")("a private user namespace reuses its owned broker's slot without another admission", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"slot-namespace-")),ready=path.join(root,"ready");
  const slot=path.join(root,"llv-heavy-gate.slot1.lock");
  const holder=spawn("bash",["-c",'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60',"holder",slot,ready],{stdio:"ignore"});
  const broker=await startCheckBroker();let requester:ReturnType<typeof spawn>|undefined;
  try {
    await until(()=>fs.existsSync(ready));
    const lease={owner:captureProcessIdentity(holder.pid!),slot};
    const env=withoutInheritedGate({...process.env});
    Object.assign(env,{LLV_GATE_LOCK_DIR:root,LLV_GATE_SLOTS:"1",LLV_GATE_SLOT_LEASE:JSON.stringify(lease),LLV_GATE_SLOT_BROKER:broker.address});
    expect(inheritedCpuSlot(env)).toEqual(lease);broker.provideCpuSlot(lease,env);
    const source=`import { inheritedCpuSlot } from ${JSON.stringify(path.resolve(import.meta.dir,"../src/lib/runtime/cpuAdmission.ts"))};
      console.log("native="+Boolean(inheritedCpuSlot()));
      const child=Bun.spawn([process.execPath,${JSON.stringify(path.join(import.meta.dir,"cpu-admission.ts"))},"--reuse-slot"],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);`;
    requester=spawn("unshare",["--user","--map-current-user",process.execPath,"-e",source],{env,stdio:["ignore","pipe","pipe"]});
    let output="",error="";requester.stdout!.on("data",v=>output+=v);requester.stderr!.on("data",v=>error+=v);
    const code=await new Promise<number|null>(resolve=>requester!.once("close",resolve));
    expect(code,error).toBe(0);expect(output.trim()).toBe("native=false");
    expect(fs.existsSync(path.join(root,"admission.sqlite"))).toBe(false);
    await broker.close();
  } finally {if(requester)await stopFixtureProcess(requester);await stopFixtureProcess(holder);await broker.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
},30_000);

for (const refusal of ["nonce","ancestor","self","host namespace","policy"] as const) test.skipIf(process.platform !== "linux")(`slot broker refuses ${refusal} before acknowledging reuse`, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"slot-refusal-")),ready=path.join(root,"ready"),slot=path.join(root,"llv-heavy-gate.slot1.lock");
  const holder=spawn("bash",["-c",'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60',"holder",slot,ready],{stdio:"ignore"});
  const broker=await startCheckBroker(),address=JSON.parse(broker.address);
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
  let socket:net.Socket|undefined;
  try {
    await until(()=>fs.existsSync(ready));
    const lease={owner:captureProcessIdentity(holder.pid!),slot};
    const env=withoutInheritedGate({...process.env});Object.assign(env,{LLV_GATE_LOCK_DIR:root,LLV_GATE_SLOTS:"1",LLV_GATE_SLOT_LEASE:JSON.stringify(lease)});
    expect(inheritedCpuSlot(env)).toEqual(lease);broker.provideCpuSlot(lease,env);
    socket=net.connect(address.port,"127.0.0.1");let response="";socket.on("data",v=>response+=v);
    const closed=new Promise(resolve=>socket!.once("close",resolve));
    socket.once("connect",()=>socket!.write(JSON.stringify({nonce:refusal==="nonce"?"invalid":address.nonce,pid:refusal==="self"?process.pid:refusal==="policy"?child.pid:process.ppid,
      hostPid:refusal==="host namespace"?process.pid:undefined,kind:"slot",lease:JSON.stringify(lease),directory:root,slots:refusal==="policy"?"0":"1"})+"\n"));
    await closed;expect(response).toContain("error");await expect(broker.close()).rejects.toThrow("check admission failed");
  } finally {socket?.destroy();await stopFixtureProcess(child);await stopFixtureProcess(holder);await broker.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
});

for (const state of ["alive","ended","rebound"] as const) test.skipIf(process.platform !== "linux")(`slot CLI rechecks its owner after awaiting a valid broker reply: ${state}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"slot-authority-")),ready=path.join(root,"ready"),verified=path.join(root,"verified"),release=path.join(root,"release");
  const slot=path.join(root,"llv-heavy-gate.slot1.lock");
  const holder=spawn("bash",["-c",'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60',"holder",slot,ready],{stdio:"ignore"});
  const broker=await startCheckBroker();let requester:ReturnType<typeof spawn>|undefined;
  try {
    await until(()=>fs.existsSync(ready));
    const lease={owner:captureProcessIdentity(holder.pid!),slot},env=withoutInheritedGate({...process.env});
    Object.assign(env,{LLV_GATE_LOCK_DIR:root,LLV_GATE_SLOTS:"1",LLV_GATE_SLOT_LEASE:JSON.stringify(lease),LLV_GATE_SLOT_BROKER:broker.address});
    expect(inheritedCpuSlot(env)).toEqual(lease);broker.provideCpuSlot(lease,env);
    const client=path.join(import.meta.dir,"check-worker-client.mjs"),preload=path.join(root,"hold-reply.ts");
    fs.writeFileSync(preload,`import { mock } from "bun:test"; import fs from "node:fs";
      const client=await import(${JSON.stringify(client)}),reuse=client.reuseGateSlot;
      mock.module(${JSON.stringify(client)},()=>({...client,reuseGateSlot:async(env)=>{
        const value=await reuse(env);fs.writeFileSync(${JSON.stringify(verified)},String(value));
        while(!fs.existsSync(${JSON.stringify(release)}))await Bun.sleep(10);
        if(${JSON.stringify(state)}==="rebound")process.env.LLV_GATE_SLOT_BROKER="null";
        return value;
      }}));`);
    requester=spawn("unshare",["--user","--map-current-user",process.execPath,"--preload",preload,path.join(import.meta.dir,"cpu-admission.ts"),"--reuse-slot"],{env,stdio:["ignore","ignore","pipe"]});
    let error="";requester.stderr!.on("data",v=>error+=v);
    const closed=new Promise<number|null>(resolve=>requester!.once("close",resolve));
    await until(()=>fs.existsSync(verified)||requester!.exitCode!==null);
    expect(requester.exitCode,error).toBeNull();expect(fs.readFileSync(verified,"utf8")).toBe("true");
    if(state==="ended")await stopFixtureProcess(holder);
    fs.writeFileSync(release,"release");
    expect(await closed,error).toBe(state==="alive"?0:69);
    if(state!=="alive")expect(error).toContain("slot lease changed while validating");
    expect(fs.existsSync(path.join(root,"admission.sqlite"))).toBe(false);
    await broker.close();
  } finally {if(requester)await stopFixtureProcess(requester);await stopFixtureProcess(holder);await broker.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
},30_000);

for (const policy of ["directory", "slot count"] as const) test.skipIf(process.platform !== "linux")(`an unrelated ${policy} does not contact an inherited slot broker`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slot-policy-")), ready = path.join(root, "ready");
  const slot = path.join(root, "llv-heavy-gate.slot2.lock");
  const holder = spawn("bash", ["-c", 'exec 9>"$1"; flock 9; printf ready >"$2"; exec sleep 60', "holder", slot, ready], { stdio: "ignore" });
  const broker = await startCheckBroker();
  try {
    await until(() => fs.existsSync(ready));
    const lease = { owner: captureProcessIdentity(holder.pid!), slot }, env = withoutInheritedGate({ ...process.env });
    Object.assign(env, { LLV_GATE_LOCK_DIR: root, LLV_GATE_SLOTS: "2", LLV_GATE_SLOT_LEASE: JSON.stringify(lease), LLV_GATE_SLOT_BROKER: broker.address });
    expect(inheritedCpuSlot(env)).toEqual(lease);
    broker.provideCpuSlot(lease, env);
    if (policy === "directory") { env.LLV_GATE_LOCK_DIR = path.join(root, "other"); fs.mkdirSync(env.LLV_GATE_LOCK_DIR); }
    else env.LLV_GATE_SLOTS = "1";
    // This process is the issuer, so it cannot enroll as its own descendant.
    // A different pool must not send it a request or poison its lifecycle.
    expect(await reuseGateSlot(env)).toBe(false);
    await broker.close();
  } finally { await stopFixtureProcess(holder); await broker.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
