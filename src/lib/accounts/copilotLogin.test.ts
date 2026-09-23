import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManagedCopilotAccount } from "./copilot";
import { COPILOT_LOGIN_TERM_GRACE_MS, COPILOT_LOGIN_TIMEOUT_MS, CopilotLoginSupervisor, type CopilotLoginChild, type CopilotLoginPorts } from "./copilotLogin";
import { signalDetachedProcessGroup } from "@/lib/processGroup";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-login-"));
const previous = { state: process.env.LLV_STATE_DIR, home: process.env.COPILOT_HOME, binary: process.env.LLV_COPILOT_BIN };
let run = 0;

class FakeChild extends EventEmitter {
  pid?: number = 73142;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean { return true; }
}

let child: FakeChild;
let signals: Array<{ pid: number; signal: NodeJS.Signals }>;
let timers: Array<{ callback: () => void; delay: number }>;
let now: number;

function ports(): CopilotLoginPorts {
  return {
    spawn: () => child as never,
    signalGroup: (child, signal) => { signals.push({ pid: -(child.pid ?? 0), signal }); },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} } as NodeJS.Timeout; },
    clearTimeout: () => undefined,
  };
}

beforeEach(() => {
  run += 1;
  process.env.LLV_STATE_DIR = path.join(sandbox, `run-${run}`, "state");
  process.env.COPILOT_HOME = path.join(sandbox, `run-${run}`, "legacy-absent");
  process.env.LLV_COPILOT_BIN = "/fixture/copilot";
  child = new FakeChild();
  signals = [];
  timers = [];
  now = Date.now();
});

afterAll(() => {
  if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  if (previous.home === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous.home;
  if (previous.binary === undefined) delete process.env.LLV_COPILOT_BIN; else process.env.LLV_COPILOT_BIN = previous.binary;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("parses the captured URL and redacted device code from stdout or stderr", () => {
  const account = createManagedCopilotAccount("Output parser");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  child.stderr.emit("data", Buffer.from("To authenticate, visit https://github.com/login/device and enter code XXXX-"));
  child.stdout.emit("data", Buffer.from("XXXX\n"));
  expect(supervisor.forAccount(account.id)).toEqual(expect.objectContaining({
    operationId: operation.operationId,
    phase: "awaiting_browser",
    loginUrl: "https://github.com/login/device",
    userCode: "XXXX-XXXX",
  }));
});

test("moves through browser and verification phases and confirms a config user", async () => {
  const account = createManagedCopilotAccount("Phase flow");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  expect(supervisor.forAccount(account.id)?.phase).toBe("starting");
  child.stdout.emit("data", "To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX");
  expect(supervisor.forAccount(account.id)?.phase).toBe("awaiting_browser");
  fs.writeFileSync(path.join(account.home, "config.json"), '// CLI comment\n{"lastLoggedInUser":{"host":"github.com","login":"fixture-user"},"loggedInUsers":[{"host":"github.com","login":"fixture-user"}]}');
  child.emit("close", 0, null);
  await Promise.resolve();
  expect(supervisor.forAccount(account.id)).toEqual(expect.objectContaining({
    operationId: operation.operationId, phase: "authenticated", result: expect.objectContaining({ code: "authenticated" }),
  }));
});

test("exit zero without a config user is failed", async () => {
  const account = createManagedCopilotAccount("No user");
  const supervisor = new CopilotLoginSupervisor(ports());
  supervisor.start(account.id);
  child.emit("close", 0, null);
  expect(supervisor.forAccount(account.id)?.phase).toBe("verifying");
  for (let attempt = 0; attempt < 20 && supervisor.forAccount(account.id)?.phase === "verifying"; attempt += 1) await Bun.sleep(1);
  expect(supervisor.forAccount(account.id)?.phase).toBe("failed");
});

test("a spawn error is handled even when the launcher has no pid", async () => {
  const account = createManagedCopilotAccount("Spawn error");
  const failedChild = new FakeChild();
  failedChild.pid = undefined;
  const supervisor = new CopilotLoginSupervisor({
    ...ports(),
    spawn: () => {
      queueMicrotask(() => failedChild.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })));
      return failedChild as never;
    },
  });

  expect(() => supervisor.start(account.id)).toThrow("Copilot sign-in could not start");
  await Promise.resolve();
  expect(supervisor.forAccount(account.id)?.phase).toBe("failed");
});

test("cancel signals the detached process group and escalates after the grace period", () => {
  const account = createManagedCopilotAccount("Cancel");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  const pid = child.pid!;
  expect(supervisor.cancel(operation.operationId).phase).toBe("canceling");
  expect(signals).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
  timers.find((timer) => timer.delay === COPILOT_LOGIN_TERM_GRACE_MS)!.callback();
  expect(signals).toEqual([{ pid: -pid, signal: "SIGTERM" }, { pid: -pid, signal: "SIGKILL" }]);
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  expect(supervisor.forAccount(account.id)?.phase).toBe("canceled");
});

test("the fifteen-minute deadline clears buffered code and the timer, then stops the process group", () => {
  const account = createManagedCopilotAccount("Deadline");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  const pid = child.pid!;
  expect(timers.find((timer) => timer.delay === COPILOT_LOGIN_TIMEOUT_MS)).toBeDefined();
  child.stdout.emit("data", "To authenticate, visit https://github.com/login/device and enter code ABCD-1234");
  const internals = supervisor as unknown as { output: Map<string, string>; timers: Map<string, NodeJS.Timeout> };
  expect(internals.output.has(operation.operationId)).toBe(true);
  expect(internals.timers.has(operation.operationId)).toBe(true);
  timers.find((timer) => timer.delay === COPILOT_LOGIN_TIMEOUT_MS)!.callback();
  expect(supervisor.forAccount(account.id)?.phase).toBe("timed_out");
  expect(internals.output.has(operation.operationId)).toBe(false);
  expect(internals.timers.has(operation.operationId)).toBe(false);
  timers.find((timer) => timer.delay === COPILOT_LOGIN_TERM_GRACE_MS)!.callback();
  expect(signals).toEqual([{ pid: -pid, signal: "SIGTERM" }, { pid: -pid, signal: "SIGKILL" }]);
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
});

test("a retry shows its own code after the previous operation is canceled", () => {
  const account = createManagedCopilotAccount("Retry");
  const supervisor = new CopilotLoginSupervisor(ports());
  const first = supervisor.start(account.id);
  supervisor.cancel(first.operationId);
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");

  child = new FakeChild();
  const second = supervisor.start(account.id);
  child.stdout.emit("data", "To authenticate, visit https://github.com/login/device and enter code ABCD-1234");
  expect(supervisor.forAccount(account.id)).toEqual(expect.objectContaining({
    operationId: second.operationId,
    phase: "awaiting_browser",
    userCode: "ABCD-1234",
  }));
});

test("cancel and timeout kill descendants started by the detached CLI launcher", async () => {
  const account = createManagedCopilotAccount("Process group");
  const deadlineCallbacks = new Map<NodeJS.Timeout, () => void>();
  let descendantPid = 0;
  let child: CopilotLoginChild | null = null;
  const code = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); process.stdout.write(\"ready\"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });",
    "grandchild.stdout.once('data', () => console.log(grandchild.pid));",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const processPorts: CopilotLoginPorts = {
    ...realPortsForProcessGroup(),
    spawn: (_command, _args, options) => {
      const processChild = spawnChild(process.execPath, ["-e", code], options) as CopilotLoginChild;
      child = processChild;
      processChild.stdout?.on("data", (part: Buffer) => { descendantPid = Number(part.toString().trim()); });
      return processChild;
    },
    setTimeout: (callback, delay) => {
      if (delay !== COPILOT_LOGIN_TIMEOUT_MS) return setTimeout(callback, delay);
      const token = { unref() {} } as NodeJS.Timeout;
      deadlineCallbacks.set(token, callback);
      return token;
    },
    clearTimeout: (timer) => {
      if (deadlineCallbacks.delete(timer)) return;
      clearTimeout(timer);
    },
  };
  const supervisor = new CopilotLoginSupervisor(processPorts);
  const assertTreeStops = async (operationId: string, timeout: boolean) => {
    const deadline = Date.now() + 5_000;
    while (!descendantPid && Date.now() < deadline) await Bun.sleep(10);
    expect(descendantPid).toBeGreaterThan(0);
    const leader = child!;
    const exited = new Promise<void>((resolve) => leader.once("exit", () => resolve()));
    if (timeout) [...deadlineCallbacks.values()].at(-1)?.();
    else supervisor.cancel(operationId);
    await Promise.race([exited, Bun.sleep(5_000)]);
    const goneBy = Date.now() + COPILOT_LOGIN_TERM_GRACE_MS + 3_000;
    let alive = true;
    while (alive && Date.now() < goneBy) {
      try {
        process.kill(descendantPid, 0);
        const state = process.platform === "linux"
          ? fs.readFileSync(`/proc/${descendantPid}/stat`, "utf8").split(") ")[1]?.[0]
          : "R";
        alive = state !== "Z";
      } catch { alive = false; }
      if (alive) await Bun.sleep(25);
    }
    expect(alive).toBe(false);
    const operation = supervisor.forAccount(account.id);
    expect(operation?.phase).toBe(timeout ? "timed_out" : "canceled");
    child?.kill("SIGKILL");
  };
  const first = supervisor.start(account.id);
  try {
    await assertTreeStops(first.operationId, false);
    descendantPid = 0;
    child = null;
    const second = supervisor.start(account.id);
    await assertTreeStops(second.operationId, true);
  } finally {
    if (child) signalDetachedProcessGroup(child, "SIGKILL");
  }
}, 30_000);

function realPortsForProcessGroup(): CopilotLoginPorts {
  return {
    spawn: () => { throw new Error("process test must supply its launcher"); },
    signalGroup: (processChild, signal) => { signalDetachedProcessGroup(processChild, signal); },
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    setTimeout,
    clearTimeout,
  };
}
