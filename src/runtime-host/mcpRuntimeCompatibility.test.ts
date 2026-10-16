import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createViewerMcpHealthProbeServer, createViewerMcpServer, MCP_TOOL_NAMES } from "@/lib/mcp/server";
import { probeMcpRuntime as legacyProbe } from "./fixtures/legacyMcpRuntimeProbe";

test("ordinary stdio clients cannot discover the deprecated update bridge", async () => {
  const server = createViewerMcpServer({ async callTool() { throw new Error("no tool call expected"); } });
  const client = new Client({ name: "ordinary-agent", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain("suggest_replies");
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain("suggest_replies");
  } finally { await client.close(); await server.close(); }
});

test("deprecated update bridge: every call refuses with the decision-form route without entering the service", async () => {
  let calls = 0;
  const server = createViewerMcpHealthProbeServer({ async callTool() { calls++; throw new Error("bridge entered active service"); } });
  const client = new Client({ name: "bridge-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()?.experimental?.["delegatus/tool-catalog"]).toEqual({ version: 1, tools: [...MCP_TOOL_NAMES] });
    expect((await client.listTools()).tools.some(tool => tool.name === "suggest_replies")).toBe(true);
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain("suggest_replies");
    for (const args of [{}, { clientRequestId: "bridge-refusal", replies: ["Proceed"], decisionId: "forged-decision", confirm: true }]) {
      const answer = await client.callTool({ name: "suggest_replies", arguments: args });
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent).toMatchObject({ ok: false, code: "tool_retired", retryable: false });
      const refusal = answer.structuredContent as Record<string, unknown>;
      expect(refusal.error).toContain("publish_prototype_review");
      expect(refusal.error).toContain("decision");
    }
    expect(calls).toBe(0);
  } finally { await client.close(); await server.close(); }
});

test("deprecated update bridge: the unchanged old prober accepts the new candidate and rejects the same candidate without the bridge", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-old-new-"));
  const worker = path.join(sandbox, "candidate.ts");
  fs.writeFileSync(worker, `
    import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { ListToolsRequestSchema } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))};
    import { createViewerMcpHealthProbeServer, MCP_TOOL_NAMES } from ${JSON.stringify(path.resolve("src/lib/mcp/server.ts"))};
    const server = createViewerMcpHealthProbeServer({async callTool(name) {return {ok:true,toolName:name,clientRequestId:null,replayed:false};}});
    if (process.argv.includes("--without-bridge")) server.server.setRequestHandler(ListToolsRequestSchema,()=>({tools:MCP_TOOL_NAMES.map(name=>({name,inputSchema:{type:"object"}}))}));
    await server.connect(new StdioServerTransport());
  `);
  const options = {
    command: process.execPath, args: [worker], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME!, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!, LLV_STATE_DIR: process.env.LLV_STATE_DIR!, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    runtime: { source: "managed" as const, revision: "7".repeat(40), releaseId: "old-new-catalog", artifactDigest: "a".repeat(64), stagedAt: "2026-10-16T08:00:00.000Z" },
    timeoutMs: 5_000,
  };
  try {
    const without = await legacyProbe({ ...options, args: [worker, "--without-bridge"] });
    expect(without.ok).toBe(false);
    expect(without.detail).toBe("MCP runtime is missing tools: suggest_replies");
    const withBridge = await legacyProbe(options);
    expect(withBridge.detail).toBeUndefined();
    expect(withBridge).toMatchObject({ ok: true, processReady: true, calls: { deploymentStatus: true, boardSnapshot: true } });
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}, 20_000);
