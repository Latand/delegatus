import { afterAll, afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { applyClaudeSpawnPolicy } from "@/lib/agent/spawnPolicy";
import { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import type { RuntimeEvent } from "@/lib/runtime/engineHost";
import type { RuntimeEventStore } from "@/lib/runtime/eventStore";
import { claudeStructuredHostOptions } from "@/lib/runtime/structuredSpawn";

import { automaticMemoryExcluded, conversationMemoryExcluded } from "./eligibility";

/* A clean launch (a reviewer, a verifier, the issue reporter, a review gate of
   any role) gets no automatic memory from either engine: no shared-memory
   hook, Claude's auto memory off, Codex's memories feature off. Every home
   here is a temporary directory; no engine process starts. */

const restoreFeatures = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true\nmemories stable true\nplugins stable true"));
afterAll(restoreFeatures);
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-clean-launch-"));
  homes.push(directory);
  return directory;
}
/* The hook installs only for a launch that holds a capability; the port is closed. */
const LAUNCH_ENV: NodeJS.ProcessEnv = { NODE_ENV: "test", LLV_SPAWN_CAPABILITY: "synthetic-capability", LLV_VIEWER_PORT: "9", PATH: process.env.PATH };

test("one decision: clean roles and review gates of any role, from a stage or a registry record", () => {
  for (const roleId of ["reviewer", "verifier", "issue-reporter"]) expect(automaticMemoryExcluded({ roleId, stage: null })).toBe(true);
  expect(automaticMemoryExcluded({ roleId: "builder", stage: { kind: "run" } })).toBe(false);
  expect(automaticMemoryExcluded({ roleId: "builder", stage: { kind: "run", onFail: { to: "fix" } } })).toBe(true);
  expect(automaticMemoryExcluded({ roleId: null, stage: { kind: "review-loop" } })).toBe(true);
  expect(automaticMemoryExcluded({ roleId: "visual-critic", stage: { kind: "run" } })).toBe(false);
  expect(conversationMemoryExcluded({ agentRole: "builder", launchProfile: { cleanMemory: true } })).toBe(true);
  /* A reviewer launched before the mark existed. */
  expect(conversationMemoryExcluded({ agentRole: "reviewer", launchProfile: {} })).toBe(true);
  expect(conversationMemoryExcluded({ agentRole: "builder", launchProfile: {} })).toBe(false);
});

test("the launch profile's mark reaches the Claude host options", () => {
  const account = { kind: "managed", accountId: "account-a", home: home(), transcriptRoot: home(), env: {} } as never;
  const options = (cleanMemory?: boolean) => claudeStructuredHostOptions({ spec: { cwd: "/repo", launchProfile: emptyLaunchProfile({ cwd: "/repo", ...(cleanMemory ? { cleanMemory } : {}) }) } as never, account }, { env: {}, host: {} } as never);
  expect(options(true).cleanMemory).toBe(true);
  expect(options().cleanMemory).toBe(false);
});

test("a clean Claude launch turns auto memory off and installs no shared-memory hook", () => {
  const settingsOf = (cleanMemory: boolean) => {
    const accountHome = home();
    const installed = applyClaudeSpawnPolicy(accountHome, { profileId: cleanMemory ? "clean" : "builder", publicationEnv: LAUNCH_ENV, cleanMemory });
    return JSON.parse(fs.readFileSync(installed.settingsPath, "utf8")) as { autoMemoryEnabled?: boolean; env: Record<string, string>; hooks: { UserPromptSubmit?: unknown[] } };
  };
  const clean = settingsOf(true);
  expect(clean.autoMemoryEnabled).toBe(false);
  expect(clean.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  expect(clean.hooks.UserPromptSubmit).toBeUndefined();
  const builder = settingsOf(false);
  expect(builder.autoMemoryEnabled).toBeUndefined();
  expect(builder.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  expect(JSON.stringify(builder.hooks.UserPromptSubmit)).toContain("shared-memory-");
});

class MemoryEventStore implements RuntimeEventStore {
  private readonly events: RuntimeEvent[] = [];
  load(): RuntimeEvent[] { return structuredClone(this.events); }
  append(_threadId: string, event: RuntimeEvent): void { this.events.push(structuredClone(event)); }
}

/** The app-server's side of a launch: enough JSON-RPC to start one thread. */
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }
  kill(): boolean { queueMicrotask(() => this.emit("close", 0, "SIGTERM")); return true; }
  private accept(message: Record<string, unknown>): void {
    this.requests.push(message);
    if (typeof message.id !== "number") return;
    const answer = (result: unknown): void => { this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`); };
    if (message.method === "initialize") return answer({ userAgent: "codex_desktop_app/0.160.1 (Linux)" });
    if (message.method === "account/read") return answer({ account: { type: "chatgpt", planType: "pro" } });
    if (message.method === "model/list") return answer({ data: [{ id: "gpt-5.6-sol", isDefault: true }] });
    if (message.method === "config/read") return answer({ config: { mcp_servers: { viewer: { command: "agent-log-viewer-mcp" } } } });
    if (message.method === "hooks/list") return answer({ data: [] });
    if (message.method === "thread/start") return answer({ thread: { id: "thread-clean", path: "/sessions/thread-clean.jsonl" } });
    answer({ data: [] });
  }
}

test("a clean Codex launch passes memories off to the app-server and its thread, and installs no hook", async () => {
  const launch = async (cleanMemory: boolean) => {
    const codexHome = home();
    const server = new FakeAppServer();
    let args: string[] = [];
    const host = await CodexAppServerHost.start({
      /* Sub-agents allowed: a denied launch already turns every unreviewed feature off, memories among them. */
      cwd: "/repo", codexHome, cleanMemory, allowSubagents: true, env: LAUNCH_ENV, eventStore: new MemoryEventStore(),
      spawnProcess: ((_command: string, launched: string[]) => { args = launched; return server as unknown as ChildProcessWithoutNullStreams; }) as never,
    });
    const config = (server.requests.find((request) => request.method === "thread/start")?.params as { config: { features: Record<string, unknown> } }).config;
    await host.release();
    return { args, features: config.features, hooks: fs.existsSync(path.join(codexHome, "hooks.json")) ? fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8") : null };
  };
  const clean = await launch(true);
  expect(clean.args).toContain("features.memories=false");
  expect(clean.features.memories).toBe(false);
  expect(clean.hooks).toBeNull();
  const builder = await launch(false);
  expect(builder.args).not.toContain("features.memories=false");
  expect(builder.features.memories).not.toBe(false);
  expect(builder.hooks).toContain("shared-memory-");
});
