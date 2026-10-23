import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

/* Importing a route module drags its whole dependency graph, and modules in it
   derive their state root from the environment. This suite owns a throwaway one
   so nothing here can read — or migrate — the operator's live state (AGENTS.md). */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-conversation-host-route-"));
const previous = {
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  state: process.env.LLV_STATE_DIR,
  codex: process.env.LLV_CODEX_HOME,
};
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.LLV_CODEX_HOME = path.join(root, "codex");
afterAll(() => {
  for (const [key, value] of [
    ["HOME", previous.home],
    ["XDG_CONFIG_HOME", previous.xdg],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_CODEX_HOME", previous.codex],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const alias = await import("./route");
const legacy = await import("../tmux/route");


/*
 * Issue #1301: `/api/tmux` runs no tmux. The endpoint resumes or respawns a
 * conversation's host and delivers to it — the engine is spawned into the host
 * namespace through `nsenter` — and the name sent whoever was debugging a
 * session that would not start looking for a tmux server that does not exist.
 * `/api/conversation-host` says what the endpoint does; the old path keeps
 * working so nothing in flight breaks.
 */

test("both paths put a workspace gate around the same shared handlers", () => {
  for (const file of [path.join(import.meta.dir, "route.ts"), path.join(import.meta.dir, "../tmux/route.ts")]) {
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain("const workspaceGET = conversationHostGET;");
    expect(source).toContain("const workspacePOST = conversationHostPOST;");
    expect(source).toContain("workspaceGET);");
    expect(source).toContain("workspacePOST);");
  }
  expect(typeof alias.GET).toBe("function");
  expect(typeof legacy.POST).toBe("function");
});

test("both paths declare the same segment config", () => {
  expect(alias.runtime).toBe("nodejs");
  expect(alias.dynamic).toBe("force-dynamic");
  expect(legacy.runtime).toBe(alias.runtime);
  expect(legacy.dynamic).toBe(alias.dynamic);
});

test("the batch target lookup is mounted under both names too", async () => {
  const aliasTargets = await import("./targets/route");
  const legacyTargets = await import("../tmux/targets/route");
  for (const file of [path.join(import.meta.dir, "targets/route.ts"), path.join(import.meta.dir, "../tmux/targets/route.ts")]) {
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain("const workspacePOST = conversationHostTargetsPOST;");
    expect(source).toContain("workspacePOST);");
  }
  expect(typeof aliasTargets.POST).toBe("function");
  expect(typeof legacyTargets.POST).toBe("function");
});

test("the legacy path's description says plainly that no tmux is involved", () => {
  /* Acceptance criterion 2 of #1301. A reader who lands on the old name must be
     told there, in the file, rather than inferring the transport from the path. */
  for (const [file, mount] of [
    [path.join(import.meta.dir, "..", "tmux", "route.ts"), "export const GET"],
    [path.join(import.meta.dir, "..", "tmux", "targets", "route.ts"), "export const POST"],
  ] as const) {
    const source = fs.readFileSync(file, "utf8");
    const description = source.slice(0, source.indexOf(mount));
    expect(description.toLowerCase()).toContain("no tmux is involved");
    expect(description).toContain("/api/conversation-host");
  }
});
