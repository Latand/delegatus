import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Every process that loads the Claude login module builds a supervisor over
 * the same state.sqlite: each agent's MCP server, the file scanner worker, the
 * files response worker. When building one recovered the store, each of those
 * starts sent SIGTERM to the Viewer's live `claude auth login` about 0.2 s
 * later, and the operator's code field vanished while they were still on
 * Claude.ai. Here the Viewer's side of a sign-in runs in this process over a
 * stand-in `claude`, and each real entry point starts beside it with the
 * environment a worker inherits from the Viewer.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-login-entry-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const STATE = path.join(ROOT, "state");
const HOME = path.join(ROOT, "home");
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.LLV_CLAUDE_HOME = path.join(ROOT, "legacy");

const { createManagedClaudeAccount } = await import("./claude");
const { ClaudeLoginSupervisor, realClaudeLoginPorts } = await import("./claudeLogin");

const SIGNALS = path.join(ROOT, "stand-in-signals");
const STAND_IN = path.join(ROOT, "bin", "claude");
fs.mkdirSync(path.dirname(STAND_IN), { recursive: true });
fs.writeFileSync(STAND_IN, [
  "#!/bin/sh",
  `trap 'echo TERM >> "${SIGNALS}"; exit 143' TERM`,
  "echo 'Open https://claude.ai/oauth/authorize?state=stand-in'",
  "while :; do sleep 0.05; done",
  "",
].join("\n"), { mode: 0o755 });

/* The Viewer's supervisor, with the real process fence; only the binary is
   the stand-in, started as `/bin/sh <claude> auth login --claudeai` the way
   the container shim runs it. */
const viewer = new ClaudeLoginSupervisor({
  ...realClaudeLoginPorts,
  spawn: (_command, args, options) => spawn("/bin/sh", [STAND_IN, ...args], options) as never,
  status: async () => ({ loggedIn: false, method: null, email: null, plan: null }),
});

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env,
    HOME,
    XDG_CONFIG_HOME: path.join(HOME, ".config"),
    TMPDIR: ROOT,
    LLV_STATE_DIR: STATE,
    /* Workers inherit the Viewer's owner claim, so an owner check alone
       cannot tell them from the Viewer. */
    LLV_STATE_OWNER: "viewer",
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:9",
  };
}

async function runEntry(entry: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, entry],
    cwd: process.cwd(),
    env: workerEnvironment(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  /* Each entry ends at stdin EOF once its module graph has loaded; the bound
     only keeps a stuck entry from holding the run. */
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
  if (!exited) child.kill("SIGKILL");
  await child.exited;
  // A signal sent while the entry loaded reaches the stand-in within its poll.
  await Bun.sleep(500);
}

for (const entry of ["src/lib/mcp/entry.ts", "src/lib/fileScanner.worker.ts", "src/lib/filesResponse.worker.ts"]) {
  test(`starting ${entry} leaves the Viewer's sign-in waiting for its code`, async () => {
    fs.rmSync(SIGNALS, { force: true });
    const account = createManagedClaudeAccount(`Entry ${path.basename(entry)}`);
    const operation = viewer.start(account.id);
    try {
      for (let i = 0; i < 100 && viewer.get(operation.operationId)?.phase !== "awaiting_code"; i += 1) await Bun.sleep(20);
      expect(viewer.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "awaiting_code", acceptsCode: true }));

      await runEntry(entry);

      expect(fs.existsSync(SIGNALS) ? fs.readFileSync(SIGNALS, "utf8") : "").toBe("");
      expect(viewer.get(operation.operationId)).toEqual(expect.objectContaining({ phase: "awaiting_code", acceptsCode: true }));
      expect(viewer.forAccount(account.id)).toEqual(expect.objectContaining({ operationId: operation.operationId, phase: "awaiting_code" }));
    } finally {
      await viewer.cancel(operation.operationId);
    }
  }, 60_000);
}
