import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeTasksRootFor } from "./roots";

/**
 * The Claude background-task root follows Claude Code's own rule (#2169):
 * `CLAUDE_CODE_TMPDIR || os.tmpdir()`, then `claude-<uid>`. A fresh install
 * with its own TMPDIR used to fall back to the live `/tmp/claude-<uid>` and
 * list another setup's background tasks under a live "Unresolved project".
 *
 * `ROOTS` is fixed when the scanner loads, so every scan runs in a child whose
 * environment is set before it starts (the probe `observe.singleFlight.test.ts`
 * uses too), and nothing here reads the operator's own temp tree.
 */

const UID = process.getuid?.() ?? 0;
const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

interface Fixture { home: string; state: string; config: string; own: string; foreign: string; foreignTask: string }

/** A home with nothing in it, its own temp root holding no `claude-<uid>` yet
    (a brand-new install), and a second temp root standing in for the shared
    `/tmp` another Claude setup writes its background tasks to. */
function fixture(): Fixture {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-tasks-root-"));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, "home");
  const state = path.join(home, "state");
  const config = path.join(home, "config");
  const own = path.join(sandbox, "own-tmp");
  const foreign = path.join(sandbox, "shared-tmp");
  const tasks = path.join(foreign, `claude-${UID}`, "-srv-another-setup-project", "session-a", "tasks");
  for (const directory of [state, config, own, tasks]) fs.mkdirSync(directory, { recursive: true });
  const foreignTask = path.join(tasks, "b0000001.output");
  fs.writeFileSync(foreignTask, "another setup's background task output\n");
  return { home, state, config, own, foreign, foreignTask };
}

interface ProbeResult {
  claudeTasksRoot: string;
  claudeTaskEntries: number;
  claudeTaskPaths: string[];
  projectKeys: string[];
  error?: string;
}

async function runProbe(sandbox: Fixture, temp: { TMPDIR: string; CLAUDE_CODE_TMPDIR?: string }): Promise<ProbeResult> {
  const child = Bun.spawn(["bun", "src/lib/scanner/observe.probe.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: sandbox.home,
      XDG_CONFIG_HOME: sandbox.config,
      LLV_STATE_DIR: sandbox.state,
      TMUX_TMPDIR: path.join(sandbox.own, "tmux"),
      CLAUDE_CODE_TMPDIR: "",
      ...temp,
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const line = out.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("{")) throw new Error(`probe produced no result: ${out}\n${err}`);
  return JSON.parse(line) as ProbeResult;
}

test("the root is Claude Code's: CLAUDE_CODE_TMPDIR, else the temp dir, then claude-<uid>", () => {
  expect(claudeTasksRootFor({}, "/tmp", 1000)).toBe("/tmp/claude-1000");
  expect(claudeTasksRootFor({}, "/var/tmp/sandbox", 1000)).toBe("/var/tmp/sandbox/claude-1000");
  expect(claudeTasksRootFor({ CLAUDE_CODE_TMPDIR: "/srv/claude-tmp" }, "/var/tmp/sandbox", 1000)).toBe("/srv/claude-tmp/claude-1000");
  /* Claude treats an empty override as unset. */
  expect(claudeTasksRootFor({ CLAUDE_CODE_TMPDIR: "" }, "/var/tmp/sandbox", 1000)).toBe("/var/tmp/sandbox/claude-1000");
});

test("with TMPDIR unset the root is /tmp/claude-<uid>, where the operator's own tasks are", async () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  delete env.CLAUDE_CODE_TMPDIR;
  const child = Bun.spawn(["bun", "-e", "console.log(require('node:os').tmpdir())"], { env, stdout: "pipe" });
  const tmpdir = (await new Response(child.stdout).text()).trim();
  await child.exited;
  expect(tmpdir).toBe("/tmp");
  expect(claudeTasksRootFor({}, tmpdir, UID)).toBe(`/tmp/claude-${UID}`);
});

test("a sandboxed TMPDIR lists none of another setup's background tasks and no unresolved project", async () => {
  const sandbox = fixture();
  const result = await runProbe(sandbox, { TMPDIR: sandbox.own });
  expect(result.error).toBeUndefined();
  expect(result.claudeTasksRoot).toBe(path.join(sandbox.own, `claude-${UID}`));
  /* The live shared root, named so this fails loudly if it is ever chosen. */
  expect(result.claudeTasksRoot).not.toBe(`/tmp/claude-${UID}`);
  expect(result.claudeTaskEntries).toBe(0);
  expect(result.projectKeys).not.toContain("project_unresolved");
  expect(result.projectKeys).toEqual([]);
}, 60_000);

test("a shared temp root still finds the background tasks written there", async () => {
  const sandbox = fixture();
  const result = await runProbe(sandbox, { TMPDIR: sandbox.foreign });
  expect(result.error).toBeUndefined();
  expect(result.claudeTasksRoot).toBe(path.join(sandbox.foreign, `claude-${UID}`));
  expect(result.claudeTaskPaths).toEqual([sandbox.foreignTask]);
}, 60_000);

test("CLAUDE_CODE_TMPDIR moves the root the way it moves Claude Code's", async () => {
  const sandbox = fixture();
  const result = await runProbe(sandbox, { TMPDIR: sandbox.own, CLAUDE_CODE_TMPDIR: sandbox.foreign });
  expect(result.error).toBeUndefined();
  expect(result.claudeTasksRoot).toBe(path.join(sandbox.foreign, `claude-${UID}`));
  expect(result.claudeTaskPaths).toEqual([sandbox.foreignTask]);
}, 60_000);
