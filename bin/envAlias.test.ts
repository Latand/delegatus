import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withAgentConfigSandbox } from "@/lib/runtime/agentConfigSandbox";

import { foldDelegatusEnvironment } from "./envAlias.mjs";

/* `DELEGATUS_X` beside `LLV_X` (rename-delegatus.md §5): the new prefix wins,
   is folded into the old name at the entry point, and never reaches a child. */

const sandboxes: string[] = [];

function sandbox(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  sandboxes.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of sandboxes) fs.rmSync(directory, { recursive: true, force: true });
});

/** The parent's environment minus every variable this mechanism reads. */
function baseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("DELEGATUS_") || key === "LLV_STATE_DIR" || key === "LLV_STATE_OWNER") continue;
    env[key] = value;
  }
  return env;
}

test("the fold: a lone DELEGATUS_ name is carried over, equal values are silent, and the new name wins a disagreement", () => {
  const warnings: string[] = [];
  const env = {
    DELEGATUS_STATE_DIR: "/state/new",
    DELEGATUS_TOKEN: "same",
    LLV_TOKEN: "same",
    DELEGATUS_VIEWER_PORT: "9001",
    LLV_VIEWER_PORT: "8898",
    DELEGATUS_: "not a variable name",
  } as Record<string, string | undefined>;
  expect(foldDelegatusEnvironment(env, (line) => warnings.push(line))).toEqual(["LLV_VIEWER_PORT"]);
  expect(env).toEqual({
    LLV_STATE_DIR: "/state/new",
    LLV_TOKEN: "same",
    LLV_VIEWER_PORT: "9001",
    DELEGATUS_: "not a variable name",
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("DELEGATUS_VIEWER_PORT");
  expect(warnings[0]).toContain("LLV_VIEWER_PORT");
  /* Names only: some values are credentials. */
  expect(warnings[0]).not.toContain("9001");
  expect(warnings[0]).not.toContain("8898");
  /* Folded once, a second pass has nothing left to do. */
  expect(foldDelegatusEnvironment(env, (line) => warnings.push(line))).toEqual([]);
  expect(warnings).toHaveLength(1);
});

function runMcpEntry(env: Record<string, string>) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/lib/mcp/entry.ts"],
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stderr: result.stderr.toString() };
}

test("an entry point started with only DELEGATUS_STATE_DIR resolves it", () => {
  const root = sandbox("llv-env-alias-only-");
  const state = path.join(root, "state");
  const result = runMcpEntry({ ...baseEnvironment(), NODE_ENV: "production", DELEGATUS_STATE_DIR: state });

  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(state, "mcp-receipts.sqlite"))).toBeTrue();
  expect(result.stderr).not.toContain("DELEGATUS_STATE_DIR");
}, 60_000);

test("with both set and different, DELEGATUS_ wins and one warning names both variables", () => {
  const root = sandbox("llv-env-alias-both-");
  const preferred = path.join(root, "delegatus-state");
  const stale = path.join(root, "llv-state");
  const result = runMcpEntry({ ...baseEnvironment(), NODE_ENV: "production", DELEGATUS_STATE_DIR: preferred, LLV_STATE_DIR: stale });

  expect(result.status).toBe(0);
  expect(fs.existsSync(path.join(preferred, "mcp-receipts.sqlite"))).toBeTrue();
  expect(fs.existsSync(stale)).toBeFalse();
  const warnings = result.stderr.split("\n").filter((line) => line.includes("DELEGATUS_STATE_DIR"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("LLV_STATE_DIR");
  expect(warnings[0]).not.toContain(preferred);
}, 60_000);

test("a child started by an entry point sees no DELEGATUS_ names", () => {
  /* The installed MCP launcher under Node starts its server as a Bun child;
     that child reports what it inherited. */
  const root = sandbox("llv-env-alias-child-");
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "dist"));
  for (const name of ["mcp-server.mjs", "server-runtime.mjs", "appDir.mjs", "envAlias.mjs"]) {
    fs.copyFileSync(path.join(import.meta.dir, name), path.join(root, "bin", name));
  }
  fs.writeFileSync(path.join(root, "dist", "mcp-server.mjs"), `
    process.stdout.write(JSON.stringify({
      delegatus: Object.keys(process.env).filter((key) => key.startsWith("DELEGATUS_")),
      stateDir: process.env.LLV_STATE_DIR,
      port: process.env.LLV_VIEWER_PORT,
    }) + "\\n");
  `);
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const state = path.join(root, "state");
  const result = Bun.spawnSync({
    cmd: [node, path.join(root, "bin", "mcp-server.mjs")],
    cwd: root,
    env: { ...baseEnvironment(), LLV_BUN_EXECUTABLE: bun, DELEGATUS_STATE_DIR: state, DELEGATUS_VIEWER_PORT: "9001" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ delegatus: [], stateDir: state, port: "9001" });
}, 60_000);

test("a sandboxed spawn keeps its sandbox LLV_STATE_DIR when the parent carried DELEGATUS_STATE_DIR", () => {
  const parentState = path.join(sandbox("llv-env-alias-parent-"), "state");
  /* The parent entry point folded its own environment... */
  const parent: NodeJS.ProcessEnv = { ...baseEnvironment(), NODE_ENV: process.env.NODE_ENV, DELEGATUS_STATE_DIR: parentState };
  foldDelegatusEnvironment(parent, () => {});
  expect(parent.LLV_STATE_DIR).toBe(parentState);
  /* ...and a child environment assembled from anywhere still reaches the agent
     with no DELEGATUS_ name that its own entry point would fold back over the
     sandbox. */
  const child: NodeJS.ProcessEnv = { ...parent, DELEGATUS_STATE_DIR: parentState, DELEGATUS_TOKEN: "t" };
  withAgentConfigSandbox(child, parent, "account-home");

  expect(child.LLV_STATE_DIR).not.toBe(parentState);
  expect(child.LLV_STATE_DIR!.startsWith(child.XDG_CONFIG_HOME!)).toBeTrue();
  expect(Object.keys(child).filter((key) => key.startsWith("DELEGATUS_"))).toEqual([]);
  foldDelegatusEnvironment(child, () => {});
  expect(child.LLV_STATE_DIR!.startsWith(child.XDG_CONFIG_HOME!)).toBeTrue();
});
