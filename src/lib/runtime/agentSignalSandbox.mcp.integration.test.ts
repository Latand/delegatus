import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NextRequest } from "next/server";
import { handleMcpHttpRequest, setMcpHttpDependenciesForTests } from "@/lib/mcp/http";
import { createMcpToolService, MCP_TOOL_NAMES, SqliteMcpReceiptStore,
  type McpRecoverableTool, type McpToolBindings, type McpToolResult } from "@/lib/mcp/server";
import { processIdentityStatus } from "@/lib/processIdentity";
import { signalAgentDomain, signalDomain, spawnSignalSandbox } from "./agentSignalSandbox";

const kernelTest = process.env.LLV_SIGNAL_SANDBOX_KERNEL_TEST === "1" ? test : test.skip;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Hold either side of dispatch so recovery observes the exact historical
// failure window. The adapter, HTTP route, service and SQLite store are real.
for (const stage of ["claimed", "dispatching"] as const) {
  kernelTest(`stdio MCP in a private PID namespace retains the Viewer receipt owner during ${stage} recovery`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-mcp-"));
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    const filename = path.join(state, "mcp-receipts.sqlite");
    const store = new SqliteMcpReceiptStore(filename);
    const observerStore = new SqliteMcpReceiptStore(filename);
    const reached = barrier(), release = barrier();
    const heldStore = new Proxy(store, { get(target, property) {
      if (property === "claim") return async (...args: Parameters<SqliteMcpReceiptStore["claim"]>) => {
        const result = target.claim(...args);
        if (stage === "claimed" && result.kind === "fresh") { reached.resolve(); await release.promise; }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    let effects = 0;
    const bindings = Object.fromEntries(MCP_TOOL_NAMES.map(name => [name, async () => ({})])) as unknown as McpToolBindings;
    bindings.send_message = async () => {
      if (stage === "dispatching") { reached.resolve(); await release.promise; }
      effects++;
      return { operationId: "op_signal_fixture" };
    };
    const caller = { kind: "worker" as const, conversationId: "signal-caller", project: "signal-project" };
    const tool: McpRecoverableTool = {
      currentCaller: () => caller,
      bind: args => ({ caller, target: { project: "signal-project", identity: "signal-target" }, downstreamKey: `signal:${args.clientRequestId}` }),
      recover: async () => ({ outcome: "in-flight", evidence: "fixture-effect", reason: null, ids: { operationId: "op_signal_fixture" } }),
    };
    const service = createMcpToolService(bindings, heldStore, undefined, { recovery: { send_message: tool } });
    const observer = createMcpToolService(bindings, observerStore, undefined, { recovery: { send_message: tool } });
    const capability = randomBytes(32).toString("base64url");
    setMcpHttpDependenciesForTests({ service: async () => service, conversationForCapability: value => value === capability ? caller.conversationId : null });
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: request => handleMcpHttpRequest(new NextRequest(request)) });
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", ...Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/^(LLV_|DELEGATUS_|NEXT_PUBLIC_)/.test(name))) };
    Object.assign(env, { HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state,
      LLV_VIEWER_CONTROL_URL: http.url.origin, LLV_SPAWN_CAPABILITY: capability });
    const marker = path.join(root, "local-pid.json");
    const client = new Client({ name: "signal-mcp-fixture", version: "1" });
    let child: Awaited<ReturnType<typeof spawnSignalSandbox>> | undefined;
    let pending: Promise<unknown> | undefined;
    let stderr = "";
    try {
      const adapter = `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid })); await import(${JSON.stringify(path.resolve("src/lib/mcp/entry.ts"))});`;
      // A native engine owns the adapter in production. Keep that parent
      // here too: the MCP lifetime guard correctly rejects an orphan at PID 1.
      child = await spawnSignalSandbox(process.execPath, ["-e",
        `const { spawn } = await import("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(adapter)}], { stdio: "inherit" }); child.on("exit", code => process.exit(code ?? 1));`],
      { cwd: process.cwd(), env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const processHandle = child;
      child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const buffer = new ReadBuffer();
      const transport: Transport = {
        async start() {
          processHandle.stdout!.on("data", chunk => {
            try {
              buffer.append(Buffer.from(chunk));
              for (let message; (message = buffer.readMessage()) !== null;) transport.onmessage?.(message);
            } catch (error) { transport.onerror?.(error as Error); }
          });
          processHandle.once("close", () => transport.onclose?.());
          processHandle.on("error", error => transport.onerror?.(error));
        },
        async send(message) { processHandle.stdin!.write(serializeMessage(message)); },
        async close() { processHandle.stdin!.end(); },
      };
      try { await client.connect(transport); }
      catch (error) { throw new Error(`MCP initialization failed: ${stderr}`, { cause: error }); }
      const args = { clientRequestId: `signal-${stage}`, conversationId: "signal-target", text: "fixture" };
      pending = client.callTool({ name: "send_message", arguments: args });
      await Promise.race([reached.promise, once(child, "close").then(() => { throw new Error(`MCP adapter ended: ${stderr}`); }),
        Bun.sleep(10_000).then(() => { throw new Error(`MCP claim not reached: ${stderr}`); })]);
      const domain = signalDomain(child)!;
      const local = JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number };
      expect(local.pid).toBeGreaterThan(1);
      expect(local.pid).not.toBe(domain.native.pid);
      expect(processIdentityStatus(domain.native)).toBe("alive");
      const key = `send_message:signal-${stage}`;
      const before = observerStore.lookup(key)!;
      expect(before.stage).toBe(stage);
      expect(before.binding!.owner).toMatchObject({ pid: process.pid });
      expect(before.binding!.owner.pid).not.toBe(local.pid);
      expect(before.binding!.owner.pid).not.toBe(domain.native.pid);
      const recovered = await observer.callTool("send_message", { ...args, recoveryOnly: true });
      if (stage === "claimed") expect(recovered).toMatchObject({ ok: false, code: "outcome_unknown", details: { outcome: "unknown" } });
      else expect(recovered).toMatchObject({ ok: true, outcome: "in-flight" });
      expect((recovered as { code?: string }).code).not.toBe("not_executed");
      const after = observerStore.lookup(key)!;
      expect(after.stage).toBe(stage);
      expect(after.binding!.owner).toEqual(before.binding!.owner);
      expect(after.result).toBeNull();
      expect(effects).toBe(0);
      release.resolve();
      const result = await pending as { structuredContent: McpToolResult };
      expect(result.structuredContent).toMatchObject({ ok: true, operationId: "op_signal_fixture" });
      expect(observerStore.lookup(key)!.stage).toBe("settled");
      expect(effects).toBe(1);
      expect(processIdentityStatus(domain.native)).toBe("alive");
    } finally {
      release.resolve();
      await client.close().catch(() => {});
      if (child && child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "close");
        signalAgentDomain(child, "SIGKILL");
        await ended;
      }
      await pending?.catch(() => {});
      http.stop(true);
      setMcpHttpDependenciesForTests(null);
      observerStore.close(); store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
