import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createViewerMcpServer, createViewerMcpHealthProbeServer } from "./server";
import { fixtureService, modelResultSamples } from "./modelInput.fixture";

async function withClient(clientName: string, index: number, run: (client: Client) => Promise<void>) {
  const server = createViewerMcpServer(fixtureService(index), ["list_tasks", "create_task"]);
  const client = new Client({ name: clientName, version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  try { await client.connect(b); await run(client); }
  finally { await client.close(); await server.close(); }
}

for (const engine of ["codex-mcp-client", "claude-code"] as const) {
  for (const index of [0, 3]) test(`${engine} receives successful and refused results once: sample ${index}`, async () => {
    await withClient(engine, index, async client => {
      const response = await client.callTool({ name: "list_tasks", arguments: {} });
      const payload = JSON.stringify(modelResultSamples[index]);
      expect(response).not.toHaveProperty("structuredContent");
      expect(response.content).toEqual([{ type: "text", text: payload }]);
      expect(response.isError === true).toBe(index === 3);
      // Codex code mode can serialize the whole MCP envelope. Claude forwards
      // the text blocks as tool_result.content; neither may repeat the object.
      if (engine === "codex-mcp-client") {
        expect(JSON.parse(JSON.stringify(response))).toEqual({ content: [{ type: "text", text: payload }], ...(index === 3 ? { isError: true } : {}) });
      } else {
        expect((response.content as Array<{ text: string }>).map(part => part.text).join("\n")).toBe(payload);
      }
    });
  });
}

test("task validation refusals are text-only before service dispatch", async () => {
  await withClient("codex-mcp-client", 0, async client => {
    const response = await client.callTool({ name: "create_task", arguments: withTaskDue({ clientRequestId: "fixture-invalid", project: "repo-fixture", text: "Inspect the transport", details: 42 }) });
    expect(response.isError).toBe(true);
    expect(response).not.toHaveProperty("structuredContent");
    expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: false, code: "TASK_INVALID_FIELD" });
  });
});

test("internal HTTP readers retain structured and text JSON; no outputSchema requires structured agent output", async () => {
  await withClient("internal-reader-fixture", 0, async client => {
    expect((await client.listTools()).tools.every(tool => tool.outputSchema === undefined)).toBe(true);
    const response = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(response.structuredContent).toEqual(modelResultSamples[0]);
    expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toEqual(response.structuredContent);
  });
});

test("the admitted deployment probe keeps structured compatibility results", async () => {
  const server = createViewerMcpHealthProbeServer(fixtureService());
  const client = new Client({ name: "deployment-probe-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  try {
    await client.connect(b);
    expect((await client.listTools()).tools.every(tool => tool.outputSchema === undefined)).toBe(true);
    const success = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(success.structuredContent).toEqual(modelResultSamples[0]);
    const refusal = await client.callTool({ name: "suggest_replies", arguments: {} });
    expect(refusal.isError).toBe(true);
    expect(refusal.structuredContent).toMatchObject({ ok: false, code: "tool_retired" });
  } finally { await client.close(); await server.close(); }
});
