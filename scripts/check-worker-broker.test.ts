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
