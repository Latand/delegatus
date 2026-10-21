import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-tools-mcp-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const { POST } = await import("@/app/api/voice-tools/proposals/route");
const { VoiceToolHub, setVoiceToolHubForTests } = await import("@/lib/voiceTools/hub");
const { VoiceToolsStore } = await import("@/lib/voiceTools/store");
setVoiceToolHubForTests(new VoiceToolHub(new VoiceToolsStore(path.join(root, "state"))));
const { viewerMcpBindings, productionViewerControlDependencies, viewerMcpToolPolicy } = await import("./bindings");
const { createViewerMcpServer, createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { permitMaintainerTool, permitIssueReporterTool, permitCuratorTool } = await import("./toolAllowlist");
import type { ViewerMcpDomainDependencies } from "./bindings";
const calls: string[] = [];
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  calls.push(new URL(req.url).pathname);
  return POST(new NextRequest(req.url, { method: "POST", headers: req.headers, body: await req.text() }));
} });
process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${listener.port}`;
internalServiceHeaders("mcp");
afterAll(async () => { setVoiceToolHubForTests(undefined); await listener.stop(true); await fs.rm(root, { recursive: true, force: true }); });
const proposal = { name: "music", title: "Music", capability: "Search music", transport: { type: "http", url: "https://example.invalid/mcp" } };

test("a delegated caller proposes through the real registration, binding and control transport; approval and removal are refused", async () => {
  const dependencies = { attentionAuthority: () => ({ kind: "worker", conversationId: "conversation_worker", role: "builder" }),
    callerAttribution: () => ({ kind: "agent", conversationId: "conversation_worker", role: "builder" }), authorizedSeats: () => [] } as unknown as ViewerMcpDomainDependencies;
  const service = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), dependencies), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(dependencies));
  const server = createViewerMcpServer(service, ["voice_tools"]);
  const client = new Client({ name: "voice-tools-tests", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools(); expect(listed.tools.map(t => t.name)).toEqual(["voice_tools"]);
    const result = await client.callTool({ name: "voice_tools", arguments: { action: "propose", proposal, clientRequestId: "proposal-one" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("pending");
    const before = await fs.readFile(path.join(root, "state/voice-tools.json"), "utf8");
    expect(JSON.parse(before).servers.music.proposedBy.conversationId).toBe("conversation_worker");
    expect(calls).toEqual(["/api/voice-tools/proposals"]);
    // The service receipt replays without reaching the Viewer or creating a second proposal.
    await client.callTool({ name: "voice_tools", arguments: { action: "propose", proposal, clientRequestId: "proposal-one" } });
    expect(calls).toHaveLength(1);
    for (const action of ["approve", "remove", "dry-run", "secrets", "reject"]) {
      const denied = await service.callTool("voice_tools", { action, name: "music", clientRequestId: `denied-${action}` });
      expect(denied.ok).toBe(false);
      expect(JSON.stringify(denied)).toContain("voice_tools_operator_required");
    }
    expect(await fs.readFile(path.join(root, "state/voice-tools.json"), "utf8")).toBe(before);
    const status = await client.callTool({ name: "voice_tools", arguments: { action: "status", clientRequestId: "read-one" } });
    expect(status.isError).not.toBe(true);
    const secretAttempt = await client.callTool({ name: "voice_tools", arguments: { action: "propose", proposal: { ...proposal, secrets: { token: "synthetic-credential" } }, clientRequestId: "secret-refused" } });
    expect(secretAttempt.isError).toBe(true);
    expect(JSON.stringify(secretAttempt)).not.toContain("synthetic-credential");
    /* A literal launch variable would swap the binary while the settings show only its name. */
    const launchAttempt = await client.callTool({ name: "voice_tools", arguments: { action: "propose", clientRequestId: "launch-refused", proposal: { ...proposal, name: "swapped",
      transport: { type: "stdio", command: "bun", args: ["x", "harmless-mcp"], env: { PATH: { value: "/srv/agent/bin" }, LD_PRELOAD: { value: "/srv/agent/x.so" } } } } } });
    expect(launchAttempt.isError).toBe(true);
    expect(JSON.stringify(launchAttempt)).toContain("INVALID_PROPOSAL");
    for (const [index, transport] of [
      { type: "stdio", command: "bun", args: ["x", "sh", "-c", "exec bun /abs/server.mjs"] },
      { type: "stdio", command: "bun", args: ["x", "bun", "/abs/server.mjs"] },
      { type: "stdio", command: "bun", args: ["x", "python3", "/abs/server.py"] },
      { type: "stdio", command: "uv", args: ["tool", "run", "python", "/abs/server.py"] },
      { type: "stdio", command: "uv", args: ["tool", "run", "python==3.12"] },
      { type: "stdio", command: "bun", args: ["x", "name@file:/abs"] },
      { type: "stdio", command: "bun", args: ["x", "/abs"] },
      { type: "stdio", command: "uv", args: ["tool", "run", "/abs"] },
      { type: "stdio", command: "uv", args: ["tool", "run", "n @ file:///abs"] },
      { type: "stdio", command: "bun", args: ["x", "git+file:/abs"] },
      { type: "stdio", command: "uv", args: ["tool", "run", "git+file:/abs"] },
    ].entries()) {
      const invalid = { ...proposal, name: "invalid", transport };
      const viaSdk = await client.callTool({ name: "voice_tools", arguments: { action: "propose", clientRequestId: `invalid-sdk-${index}`, proposal: invalid } });
      expect(viaSdk.isError).toBe(true);
      expect(JSON.stringify(viaSdk)).toContain("INVALID_PROPOSAL");
      const direct = await service.callTool("voice_tools", { action: "propose", clientRequestId: `invalid-direct-${index}`, proposal: invalid });
      expect(direct.ok).toBe(false);
      expect(JSON.stringify(direct)).toContain("INVALID_PROPOSAL");
    }
    expect(await fs.readFile(path.join(root, "state/voice-tools.json"), "utf8")).toBe(before);
    for (const command of ["bun", "uv"]) {
      const valid = { ...proposal, name: `registry_${command}`, transport: { type: "stdio", command,
        args: command === "bun" ? ["x", "@tools/music@1.2.3"] : ["tool", "run", "music==1.2.3"] } };
      const accepted = await client.callTool({ name: "voice_tools", arguments: { action: "propose", proposal: valid, clientRequestId: `registry-${command}` } });
      expect(accepted.isError).not.toBe(true);
      const stored = JSON.parse(await fs.readFile(path.join(root, "state/voice-tools.json"), "utf8"));
      expect(stored.servers[valid.name].state).toBe("pending");
      expect(stored.servers[valid.name].lastDryRun).toBeNull();
    }
  } finally { await client.close(); await server.close(); }
});

test("specialized agent roles retain the operator's any-agent proposal permission", () => {
  for (const policy of [permitMaintainerTool, permitIssueReporterTool, permitCuratorTool]) {
    for (const action of ["list", "status", "propose"]) expect(policy("voice_tools", { action }).allowed).toBe(true);
    for (const action of ["approve", "remove", "dry-run", "secrets"]) expect(policy("voice_tools", { action }).allowed).toBe(false);
  }
});
