import { afterAll, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createManagedCopilotAccount } from "./copilot";
import { COPILOT_LOGIN_TIMEOUT_MS, CopilotLoginSupervisor, type CopilotLoginPorts } from "./copilotLogin";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-login-"));
const previous = { state: process.env.LLV_STATE_DIR, home: process.env.COPILOT_HOME, binary: process.env.LLV_COPILOT_BIN };
let run = 0;

class FakeChild extends EventEmitter {
  pid = 73142;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let child: FakeChild;
let signals: Array<{ pid: number; signal: NodeJS.Signals }>;
let timers: Array<{ callback: () => void; delay: number }>;
let now: number;

function ports(): CopilotLoginPorts {
  return {
    spawn: () => child as never,
    signal: (pid, signal) => { signals.push({ pid, signal }); },
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

test("cancel signals exactly the recorded child pid", () => {
  const account = createManagedCopilotAccount("Cancel");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  expect(supervisor.cancel(operation.operationId).phase).toBe("canceling");
  expect(signals).toEqual([{ pid: child.pid, signal: "SIGTERM" }]);
  child.emit("close", null, "SIGTERM");
  expect(supervisor.forAccount(account.id)?.phase).toBe("canceled");
});

test("the fifteen-minute deadline marks timeout and signals its recorded pid", () => {
  const account = createManagedCopilotAccount("Deadline");
  const supervisor = new CopilotLoginSupervisor(ports());
  const operation = supervisor.start(account.id);
  expect(timers.find((timer) => timer.delay === COPILOT_LOGIN_TIMEOUT_MS)).toBeDefined();
  timers.find((timer) => timer.delay === COPILOT_LOGIN_TIMEOUT_MS)!.callback();
  expect(supervisor.forAccount(account.id)?.phase).toBe("timed_out");
  expect(signals).toEqual([{ pid: child.pid, signal: "SIGTERM" }]);
});
