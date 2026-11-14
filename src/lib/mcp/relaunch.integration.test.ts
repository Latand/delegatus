import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentRegistry } from "@/lib/agent/registry";
import { viewerMcpHttpClaudeEntry, viewerMcpHttpCodexEntry, viewerMcpServerEntry } from "@/lib/agent/spawnPolicy";
import { ownFixtureChild, reapFixtureChildren } from "./ownedFixtureChildren";

for (const engine of ["claude", "codex"] as const) for (const attachment of ["stdio", "entry", "http"] as const) {
  test(`${engine} ${attachment} keeps a live SDK client across a Viewer process relaunch`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-relaunch-"));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
      && !name.startsWith("LLV_") && !name.startsWith("DELEGATUS_"))) as Record<string, string>;
    for (const name of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
      environment[name] = path.join(root, name); fs.mkdirSync(environment[name]!, { recursive: true });
    }
    environment.NODE_ENV = "test";
    environment.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
    environment.LLV_BUN_EXECUTABLE = process.execPath;
    const registry = new AgentRegistry(path.join(environment.LLV_STATE_DIR!, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
    const receipt = registry.beginSpawn(engine, root, { cwd: root, title: "Relaunch fixture" });
    environment.LLV_SPAWN_CAPABILITY = registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
    const start = async (port = 0) => {
      const child = ownFixtureChild(Bun.spawn([process.execPath, path.join(import.meta.dir, "relaunchServer.fixture.ts"), root, String(port)], {
        cwd: process.cwd(), env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      }));
      const reader = child.stdout.getReader();
      const ready = await reader.read(); reader.releaseLock();
      if (ready.done) throw new Error(await new Response(child.stderr).text());
      return { child, origin: new TextDecoder().decode(ready.value).trim() };
    };
    const client = new Client({ name: engine === "claude" ? "claude-code" : "codex-mcp-client", version: "1" });
    let restarted: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await start();
      environment.LLV_VIEWER_CONTROL_URL = first.origin;
      environment.LLV_VIEWER_PORT = new URL(first.origin).port;
      environment.LLV_MCP_HTTP_URL = `${first.origin}/api/mcp`;
      const entry = viewerMcpServerEntry(process.cwd(), environment);
      const transport = attachment === "http" ? (() => {
        const entry = engine === "claude" ? viewerMcpHttpClaudeEntry(environment) : viewerMcpHttpCodexEntry(environment);
        const headers = engine === "claude"
          ? Object.fromEntries(Object.entries(entry.headers as Record<string, string>).map(([name, value]) => [name,
            value.replace(/\$\{([^}]+)\}/g, (_, variable: string) => environment[variable] ?? "")] ))
          : Object.fromEntries(Object.entries(entry.env_http_headers as Record<string, string>).map(([name, variable]) => [name, environment[variable]!]));
        return new StreamableHTTPClientTransport(new URL(entry.url as string), { requestInit: {
          headers,
        } });
      })() : new StdioClientTransport({ command: process.execPath, args: attachment === "entry"
        ? [path.join(import.meta.dir, "entry.ts")] : entry.args, cwd: process.cwd(), env: { ...environment, ...entry.env }, stderr: "pipe" });
      await client.connect(transport);
      expect((await client.listTools()).tools.some(tool => tool.name === "list_tasks")).toBe(true);
      const call = (key: string) => client.callTool({ name: "list_tasks", arguments: { clientRequestId: key, ids: ["absent"] } });
      expect((await call("before-relaunch")).isError).not.toBe(true);
      const pending = call("held-relaunch").catch(error => error as Error);
      const mutation = client.callTool({ name: "dismiss_attention", arguments: {
        clientRequestId: "held-mutation-relaunch", target: { kind: "task", taskId: "absent" },
      } }).catch(error => error as Error);
      const limit = Date.now() + 5_000;
      const admitted = () => ["held-relaunch", "held-mutation-relaunch"].every(name => fs.existsSync(path.join(root, name)));
      while (!admitted() && Date.now() < limit) await Bun.sleep(10);
      expect(admitted()).toBe(true);
      first.child.kill("SIGKILL"); await first.child.exited;
      const lost = await pending;
      const lostMutation = await mutation;
      if (attachment === "http") {
        expect(lost).toBeInstanceOf(Error); expect(lostMutation).toBeInstanceOf(Error);
      }
      else {
        expect(lost).toMatchObject({ isError: true });
        expect(JSON.stringify(lost)).toContain("retryable");
        expect(lostMutation).toMatchObject({ isError: true });
        expect(JSON.stringify(lostMutation)).toContain("outcome_unknown");
        expect(JSON.stringify(lostMutation)).toContain("original-key-lookup");
      }
      // Discovery during the gap must recover too: CLIs discover tools again
      // after list_changed and treat a discovery error as a failed server.
      let replacement: Awaited<ReturnType<typeof start>> | undefined;
      const gapMs = engine === "claude" && attachment === "stdio" ? 44_000 : 400;
      const ready = new Promise<void>((resolve, reject) => {
        restarted = setTimeout(() => { void start(Number(new URL(first.origin).port)).then(value => { replacement = value; resolve(); }, reject); }, gapMs);
      });
      void ready.catch(() => {});
      if (attachment !== "http") expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await ready;
      expect(replacement!.child.pid).not.toBe(first.child.pid);
      expect((await call("after-relaunch")).isError).not.toBe(true);
      // Rotation still refuses discovery and calls through both transports.
      registry.rotateSpawnCapabilityForReceipt(receipt.launchId);
      await expect(client.listTools()).rejects.toThrow();
      if (attachment === "http") await expect(call("revoked-relaunch")).rejects.toMatchObject({ code: 403 });
      else expect((await call("revoked-relaunch")).isError).toBe(true);
    } finally {
      if (restarted) clearTimeout(restarted);
      await client.close(); await reapFixtureChildren();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
}
