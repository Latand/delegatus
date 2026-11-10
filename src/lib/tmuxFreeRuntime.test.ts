import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* The periodic and per-view work of a running installation must start no
   `tmux` process. A recording stand-in is the only `tmux` on PATH here, so any
   call from the scanner, the resources snapshot, the headless process reaper
   or the agent snapshot leaves a line in its log. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tmux-free-"));
const bin = path.join(sandbox, "bin");
const calls = path.join(sandbox, "tmux-calls.log");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\necho "$@" >> "${calls}"\necho "no server running on /nowhere" >&2\nexit 1\n`, { mode: 0o755 });

const previous = {
  PATH: process.env.PATH,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_CODEX_HOME: process.env.LLV_CODEX_HOME,
  LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME,
  DELEGATUS_CODEX_HOME: process.env.DELEGATUS_CODEX_HOME,
  DELEGATUS_CLAUDE_HOME: process.env.DELEGATUS_CLAUDE_HOME,
};
process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.DELEGATUS_CODEX_HOME = process.env.LLV_CODEX_HOME;
process.env.DELEGATUS_CLAUDE_HOME = process.env.LLV_CLAUDE_HOME;

const sessions = path.join(process.env.LLV_CODEX_HOME, "sessions");
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, "session-one.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }) + "\n");

const { listFiles } = await import("@/lib/scanner");
const { buildResourceSnapshot } = await import("@/lib/resources");
const { runHeadlessProcessReaper } = await import("@/lib/headlessProcessReaper");
const { resolveSiblings } = await import("@/lib/view/siblings");

function tmuxCalls(): string[] {
  return fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  fs.rmSync(calls, { force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("a fresh file scan starts no tmux process", async () => {
  const files = await listFiles({ fresh: true });
  expect(files.length).toBe(1);
  expect(tmuxCalls()).toEqual([]);
});

test("a resources snapshot starts no tmux process", async () => {
  const payload = await buildResourceSnapshot(true);
  expect(Array.isArray(payload.sessions)).toBe(true);
  expect(tmuxCalls()).toEqual([]);
});

test("the headless process reaper starts no tmux process", async () => {
  /* An empty process table: nothing on this machine is listed or signalled. */
  const report = await runHeadlessProcessReaper({
    flows: [],
    flowArtifactsRoot: path.join(sandbox, "flows"),
    dependencies: { listProcesses: () => [], ppidMap: () => new Map(), loadFlows: () => [] },
  });
  expect(report).toEqual({ candidates: 0, signaled: 0 });
  expect(tmuxCalls()).toEqual([]);
});

test("an agent snapshot's sibling lookup starts no tmux process", async () => {
  const siblings = await resolveSiblings({ pid: process.pid });
  expect(siblings).toEqual({ selfResolution: "unmatched", agents: [] });
  expect(tmuxCalls()).toEqual([]);
});
