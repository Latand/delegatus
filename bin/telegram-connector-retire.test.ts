import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { procBackend } from "@/lib/proc";

import { retireTelegramConnector } from "./telegram-connector-retire.mjs";
import { viewerProcessTree } from "./viewer-helpers-retire.mjs";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-connector-retire-"));
const PYTHON = Bun.which("python3")!;
const started: number[] = [];
afterAll(() => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/* A Viewer that keeps running: the owner of a successor's runner. */
function liveViewer() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(child.pid!);
  return { child, pid: child.pid!, identity: procBackend.processIdentity(child.pid!)! };
}

/* Ends a process this test started and reaps it before the test ends. */
async function end(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await ended;
}

/* The stopped Viewer, as the launcher read it before stopping it: this test
   process stands in for it. */
const STOPPED = viewerProcessTree(process.pid);
const OWNER = { ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid)!, lease: "stdin" };

/* A runner whose lease did not end it (one that never reads its stdin), so
   the launcher has to. */
async function runner(name: string, ignoreTerm: boolean, owner: object = OWNER) {
  const state = path.join(SANDBOX, name, "state");
  const entrypoint = path.join(SANDBOX, name, "release", "bin", "telegram-mcp-server.py");
  const ready = path.join(SANDBOX, name, "ready");
  fs.mkdirSync(path.join(state, "telegram"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, [
    "import signal, time",
    ...(ignoreTerm ? ["signal.signal(signal.SIGTERM, signal.SIG_IGN)"] : []),
    `open(${JSON.stringify(ready)}, "w").close()`,
    "while True:",
    "    time.sleep(1)",
    "",
  ].join("\n"));
  const child = spawn(PYTHON, [entrypoint], { stdio: "ignore" });
  started.push(child.pid!);
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  const record = { version: 1, pid: child.pid!, identity: procBackend.processIdentity(child.pid!)!, credentialRef: "credential-generation-a",
    connectorTokenSha256: "0".repeat(64), command: PYTHON, entrypoint, ...owner };
  const write = (body: object) => fs.writeFileSync(path.join(state, "telegram", "connector.json"), JSON.stringify(body), { mode: 0o600 });
  write(record);
  return { child, state, record, write };
}

const alive = (pid: number, identity: string) => procBackend.processIdentity(pid) === identity && !procBackend.processExited(pid);
const options = { leaseMs: 100, termMs: 500, killMs: 2_000 };

test.if(process.platform === "linux")("the launcher ends a connector that outlived its Viewer before the service stops", async () => {
  const { child, state, record } = await runner("term", false);
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("terminated");
  expect(alive(child.pid!, record.identity)).toBe(false);
});

test.if(process.platform === "linux")("a connector that ignores SIGTERM is killed within the bound", async () => {
  const { child, state, record } = await runner("ignores-term", true);
  const begun = Date.now();
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("killed");
  expect(Date.now() - begun).toBeLessThan(options.leaseMs + options.termMs + options.killMs + 1_000);
  expect(alive(child.pid!, record.identity)).toBe(false);
});

test.if(process.platform === "linux")("a process that is not the recorded runner is never signalled", async () => {
  const { child, state, record, write } = await runner("other", false);
  /* A recycled pid: another start identity. */
  write({ ...record, identity: `${record.pid}:1` });
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("none");
  /* The same process under another command line. */
  write({ ...record, entrypoint: path.join(SANDBOX, "elsewhere", "telegram-mcp-server.py") });
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("none");
  /* A record another user could have written. */
  write(record);
  fs.chmodSync(path.join(state, "telegram", "connector.json"), 0o644);
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("none");
  expect(alive(child.pid!, record.identity)).toBe(true);
  expect(await retireTelegramConnector(path.join(SANDBOX, "no-state"), STOPPED, options)).toBe("none");
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await ended;
});

test.if(process.platform === "linux")("a runner a live successor owns is never signalled by the launcher of the stopped Viewer", async () => {
  const successor = liveViewer();
  const { child, state, record, write } = await runner("successor", false, { ownerPid: successor.pid, ownerIdentity: successor.identity, lease: "stdin" });
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("foreign");
  expect(alive(child.pid!, record.identity)).toBe(true);
  /* A record written before leases names no owner: nothing proves it is this
     Viewer's, so it is left to the Viewer that owns traffic. */
  const legacy: Record<string, unknown> = { ...record };
  for (const key of ["ownerPid", "ownerIdentity", "lease"]) delete legacy[key];
  write(legacy);
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("foreign");
  expect(alive(child.pid!, record.identity)).toBe(true);
  /* An owner of the same pid but another start is another process. */
  write({ ...record, ownerPid: process.pid, ownerIdentity: `${process.pid}:1` });
  expect(await retireTelegramConnector(state, STOPPED, options)).toBe("foreign");
  expect(alive(child.pid!, record.identity)).toBe(true);
  await end(child);
  await end(successor.child);
});

test.if(process.platform === "linux")("the launcher ends its own runner after a successor replaced the shared record, and leaves the successor's", async () => {
  const own = await runner("own-replaced", false);
  const successor = liveViewer();
  const theirs = await runner("theirs-replaced", false, { ownerPid: successor.pid, ownerIdentity: successor.identity, lease: "stdin" });
  /* runner() wrote the successor's record last; put this Viewer's back, and
     let the successor replace it while the launcher waits on the lease. */
  own.write(own.record);
  const retiring = retireTelegramConnector(own.state, STOPPED, { ...options, leaseMs: 400 });
  await Bun.sleep(100);
  own.write(theirs.record);
  expect(await retiring).toBe("terminated");
  expect(alive(own.child.pid!, own.record.identity)).toBe(false);
  expect(alive(theirs.child.pid!, theirs.record.identity)).toBe(true);
  for (const child of [own.child, theirs.child, successor.child]) await end(child);
});
