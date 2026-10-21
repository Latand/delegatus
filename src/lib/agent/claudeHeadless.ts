import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountContext } from "@/lib/accounts/contracts";
import { claudeManagedEnvironment } from "@/lib/accounts/claude";
import { resolveBinary } from "./cli";
import { headlessRuns, launchDetached, reviewerEnvironment, terminateHeadlessReviewerGroupAndWait, type HeadlessReviewRuntime, type LiveRun } from "./headless";
import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export interface ClaudeHeadlessRequest {
  account: AccountContext;
  ["prompt"]: string;
  model?: string;
  schema?: object;
  maxTokens?: number;
  timeoutMs: number;
  authorized?: () => boolean;
  runtime?: HeadlessReviewRuntime;
}
export type ClaudeHeadlessResult = { status: "done" | "failed" | "timeout"; records: Record<string, unknown>[] };
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// The deadline belongs to a separate process, so a Viewer restart cannot
// remove it. The CLI has its own process group; only that owned group is stopped.
const WATCHDOG = `
const { spawn } = require("node:child_process");
const [budget, command, ...args] = process.argv.slice(1);
let expired = false;
const child = spawn(command, args, { stdio: "inherit", detached: process.platform !== "win32" });
const stop = () => {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {}
};
const timer = setTimeout(() => { expired = true; stop(); }, Number(budget));
child.on("error", () => { clearTimeout(timer); process.exit(1); });
child.on("close", (code, signal) => { clearTimeout(timer); stop(); process.exit(expired ? 124 : signal ? 1 : code ?? 1); });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { expired = true; stop(); });
`;

/** One prompt-only CLI run, using the same owned launcher as other headless
 * work. Safe mode disables customizations; auth remains Claude Code's job. */
export async function runHeadlessClaudeOnce(request: ClaudeHeadlessRequest): Promise<ClaudeHeadlessResult> {
  return withViewerOperation("claude.headless-json", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llv-claude-json-"));
    const key = `claude-json-${randomUUID()}`;
    const stdoutPath = path.join(directory, "stdout.jsonl");
    const stderrPath = path.join(directory, "stderr.txt");
    try {
      // Managed auth removes ambient provider/token overrides on legacy homes too.
      const source = claudeManagedEnvironment(request.account.home, request.account.env);
      const env = withAgentConfigSandbox(reviewerEnvironment(source), source, request.account.home);
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxTokens ?? 8192);
      env.CLAUDE_CODE_MAX_RETRIES = "0";
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
      delete env.CLAUDE_CODE_USE_FOUNDRY;
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "",
        "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "", "--safe-mode", "--no-session-persistence", "--max-turns", "3",
        ...(request.model ? ["--model", request.model, "--effort", "low"] : []),
        ...(request.schema ? ["--json-schema", JSON.stringify(request.schema)] : [])];
      if (request.authorized && !request.authorized()) return { status: "failed", records: [] };
      return await new Promise<ClaudeHeadlessResult>((resolve, reject) => {
        let timedOut = false;
        let settled = false;
        const settle = (run: LiveRun) => {
          if (settled) return;
          settled = true;
          void (async () => {
            headlessRuns.delete(key);
            const clean = run.exit?.code === 0 && run.exit.signal === null;
            const gone = !run.child.pid || await terminateHeadlessReviewerGroupAndWait(run.child.pid, run.identity, { ownedByLiveHandle: true, leaderExited: true });
            if (timedOut || run.exit?.code === 124) return resolve({ status: "timeout", records: [] });
            if (!clean || !gone) return resolve({ status: "failed", records: [] });
            const stat = await fs.stat(stdoutPath);
            if (stat.size > MAX_OUTPUT_BYTES) return resolve({ status: "failed", records: [] });
            const records = (await fs.readFile(stdoutPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
            resolve({ status: "done", records });
          })().catch(reject);
        };
        try {
          const budget = Math.max(1, Math.min(request.timeoutMs, 30_000));
          const launched = launchDetached({ key, built: { command: process.execPath,
            args: ["-e", WATCHDOG, "--", String(budget), request.runtime?.command ?? resolveBinary("claude"), ...args], env,
            stdin: request.prompt, outputPath: null, sessionId: null, reviewerPath: null },
            cwd: directory, stdoutPath, stderrPath, timeoutMs: budget + 4_000,
            runtime: request.runtime ? { processIdentity: request.runtime.processIdentity } : undefined,
            onTimeout: () => { timedOut = true; }, onExit: settle });
          if (!launched) resolve({ status: "failed", records: [] });
        } catch (error) { reject(error); }
      });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
}
