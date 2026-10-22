import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCodexMemoryHook } from "./hook";
import { viewerComposeSnapshotPath } from "@/runtime-host/deploymentArtifacts";

for (const storage of ["machine", "compose"] as const) test(`generated hook reads the current ${storage} key without storing it in Codex home`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-key-"));
  const home = path.join(root, "codex"), state = path.join(root, "config", "delegatus", "state");
  fs.mkdirSync(state, { recursive: true });
  const received: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json();
    if (input.delegatus_confirm) return Response.json({ block: "" });
    received.push(request.headers.get("authorization") ?? "");
    return Response.json({ block: "Synthetic authenticated context" });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const keyFile = storage === "machine" ? path.join(root, "config", "delegatus", "token") : viewerComposeSnapshotPath(state, "fixture-release");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const writeKey = (key: string) => fs.writeFileSync(keyFile, storage === "machine" ? key : JSON.stringify({ services: { viewer: { environment: { LLV_TOKEN: key } } } }));
  const first = "synthetic-first-key", second = "synthetic-rotated-key";
  writeKey(first);
  const target = path.join(state, "viewer-release.json");
  fs.writeFileSync(target, JSON.stringify({ endpoint, ...(storage === "compose" ? { container: "fixture-release" } : {}) }));
  const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state,
    LLV_VIEWER_DEPLOY_TARGET: target, LLV_VIEWER_PORT: String(server.port), LLV_VIEWER_CONTROL_URL: endpoint, LLV_SPAWN_CAPABILITY: "synthetic-capability" };
  try {
    const hook = installCodexMemoryHook(home, env)!;
    const sourceFiles = [...new Bun.Glob("**/*.mjs").scanSync({ cwd: home, absolute: true, dot: true })];
    expect(sourceFiles.length).toBe(1);
    for (const file of sourceFiles) expect(fs.readFileSync(file, "utf8")).not.toContain(first);
    for (const key of [first, second]) {
      writeKey(key);
      const child = Bun.spawn(["bash", "-c", hook.command], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toContain("Synthetic authenticated context");
      expect(await new Response(child.stderr).text()).toBe("");
    }
    expect(received).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
    fs.unlinkSync(keyFile);
    const child = Bun.spawn(["bash", "-c", hook.command], { env: { ...env, LLV_SPAWN_CAPABILITY: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(received.length).toBe(2);
  } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an explicit unrelated endpoint receives no ambient access key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-unrelated-"));
  let receivedBearer: string | null | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    receivedBearer = request.headers.get("authorization");
    return Response.json({ block: "" });
  } });
  const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, HOME: root, LLV_STATE_DIR: path.join(root, "state"),
    LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${server.port}`, LLV_TOKEN: "synthetic-unrelated-key", LLV_SPAWN_CAPABILITY: "synthetic-capability" };
  try {
    const hook = installCodexMemoryHook(path.join(root, "codex"), env)!;
    const child = Bun.spawn(["bash", "-c", hook.command], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(receivedBearer).toBeNull();
  } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an environment-only installation keeps its key in Delegatus state when the agent environment is scrubbed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-environment-"));
  const state = path.join(root, "state"), home = path.join(root, "codex"); fs.mkdirSync(state);
  let receivedBearer: string | null | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    receivedBearer = request.headers.get("authorization");
    return Response.json({ block: "" });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  fs.writeFileSync(path.join(state, "viewer-release.json"), JSON.stringify({ endpoint }));
  const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state,
    LLV_VIEWER_PORT: String(server.port), LLV_TOKEN: "synthetic-environment-key", LLV_SPAWN_CAPABILITY: "synthetic-capability" };
  try {
    const hook = installCodexMemoryHook(home, env)!;
    for (const file of new Bun.Glob("**/*").scanSync({ cwd: home, absolute: true, onlyFiles: true, dot: true })) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(env.LLV_TOKEN);
    }
    const child = Bun.spawn(["bash", "-c", hook.command], { env: { ...env, LLV_TOKEN: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(receivedBearer).toBe(`Bearer ${env.LLV_TOKEN}`);
  } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});
