import { afterEach, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { recordWorktreeSweep } from "@/lib/pipelines/worktreeSweep";
import { GET } from "./route";

const previous = process.env.LLV_STATE_DIR;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-route-")); process.env.LLV_STATE_DIR = root; });
afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const read = (query = "", headers = {}) => GET(new NextRequest(`http://localhost/api/resources/worktrees${query}`, {
  headers: { Host: "localhost", Origin: "http://localhost", ...headers },
}));

test("route configuration loads under Node without opening SQLite or state", async () => {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "route.ts")],
    outdir: path.join(root, "bundle"), target: "node", format: "cjs", external: ["next/*", "bun:*"],
  });
  expect(build.success).toBe(true);
  const node = process.env.LLV_TEST_NODE_BIN || Bun.which("node");
  if (!node) throw new Error("route configuration check requires Node on PATH");
  const state = path.join(root, "state");
  const probe = Bun.spawn([node, "-e", `
    const route = require(process.argv[1]);
    if (route.runtime !== "nodejs" || route.dynamic !== "force-dynamic" || typeof route.GET !== "function")
      throw new Error("missing route configuration");
  `, build.outputs[0]!.path], {
    env: { ...process.env, NODE_PATH: path.resolve("node_modules"), NODE_ENV: "production",
      HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state, TMPDIR: root },
    stdout: "pipe", stderr: "pipe",
  });
  const [exit, error] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(fs.existsSync(state)).toBe(false);
});

test("authorized first and subsequent pages are no-store and contain no raw checkout or detail paths", async () => {
  const at = "2026-10-23T10:00:00.000Z";
  recordWorktreeSweep({ at, mode: "dry-run", repositories: [root], kept: Array.from({ length: 5 }, (_, i) => ({
    path: path.join(root, "worktrees", `checkout-${i}`), repository: root, reason: "retention", bytes: 1024, observedAt: at,
    detail: path.join(root, "private-detail"),
  })), keptCounts: { retention: 5 }, keptBytes: {}, removed: [], removedBytes: 0, trimmed: [], trimmedBytes: 0, errors: [] });
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const first = await response.json();
  expect(first.rows).toHaveLength(4);
  expect(JSON.stringify(first)).not.toContain(root);
  expect(JSON.stringify(first)).not.toContain("private-detail");
  const last = await read(`?cursor=${encodeURIComponent(first.nextCursor)}`);
  expect(last.status).toBe(200);
  expect((await last.json()).rows).toHaveLength(1);
  recordWorktreeSweep({ at, mode: "on", repositories: [], kept: [], keptCounts: {}, keptBytes: {}, removed: [], removedBytes: 0, trimmed: [], trimmedBytes: 0, errors: [] });
  const changed = await read(`?cursor=${encodeURIComponent(first.nextCursor)}`);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: "snapshot_changed" });
});

test("cross-origin, cross-site, foreign Host and agent requests fail before data and cursor parsing", async () => {
  const requests = [
    { headers: { Origin: "https://attacker.invalid" }, error: "forbidden: cross-origin request" },
    { headers: { "sec-fetch-site": "cross-site" }, error: "forbidden: cross-origin request" },
  ];
  for (const { headers, error } of requests) {
    const result = await read("?cursor=invalid", headers);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error });
  }
  const host = await read("", { Host: "attacker.invalid" });
  expect(host.status).toBe(403);
  expect(await host.json()).toEqual({ error: "forbidden: cross-origin request" });
  setCallerConversationResolverForTests(() => "conversation-test");
  const agent = await read("?cursor=invalid", { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) });
  expect(agent.status).toBe(403);
  expect(await agent.json()).toEqual({ error: "this is an operator-only action; an agent may not perform it, whatever role it holds" });
  // Valid-Host control reaches this route's reader rather than a generic 403.
  expect((await read()).status).toBe(503);
});

test("bad cursors and unavailable reports have explicit bounded errors without private diagnostics", async () => {
  const invalid = await read("?cursor=../../state");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "invalid_cursor" });
  const missing = await read();
  expect(missing.status).toBe(503);
  expect(await missing.json()).toEqual({ error: "unavailable" });
});
