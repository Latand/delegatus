import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, expect, test, spyOn } from "bun:test";
import { NextRequest } from "next/server";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-contention-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { ClaudeLoginSupervisor, claudeLoginSupervisor } = await import("@/lib/accounts/claudeLogin");
const { measureContention } = await import("@/lib/accounts/accountMutation.contention.fixture");
const { DELETE } = await import("./route");

test("Claude cancellation releases the lease during termination grace", async () => {
  await measureContention("claude-cancel", async (pause) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write: () => true, end: () => undefined },
    });
    const signals: string[] = [];
    const supervisor = new ClaudeLoginSupervisor({
      spawn: () => child as never,
      kill: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") child.emit("close", 0); },
      pidStartToken: () => "fixture-process", isExpectedClaude: () => true,
      waitForExit: async () => undefined,
      status: async () => ({ loggedIn: false, method: null, email: null, plan: null }),
      now: Date.now,
      setTimeout: (fn, ms) => { if (ms <= 2_000) void pause().then(fn); return {} as NodeJS.Timeout; },
      clearTimeout: () => undefined,
    }, { load: () => [], save: () => undefined });
    await supervisor.whenRecovered();
    const operation = supervisor.start("default");
    const cancel = spyOn(claudeLoginSupervisor, "cancel").mockImplementation((id) => supervisor.cancel(id));
    try {
      const response = await DELETE(new NextRequest("http://127.0.0.1/api/accounts/claude/login/fixture", { method: "DELETE", headers: { host: "127.0.0.1" } }), { params: Promise.resolve({ operationId: operation.operationId }) });
      expect(response.status).toBe(200);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(supervisor.get(operation.operationId)?.phase).toBe("canceled");
    } finally { cancel.mockRestore(); }
  });
});
