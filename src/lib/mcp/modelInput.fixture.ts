import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createViewerMcpServer } from "./server";
import results from "./fixtures/modelResults.json";
import type { McpToolResult } from "./server";

export const modelResultSamples = results as McpToolResult[];
export const fixtureService = (index = 0) => ({ async callTool() { return modelResultSamples[index]; } });

if (import.meta.main) {
  const server = createViewerMcpServer(fixtureService(Number(process.env.MCP_RESULT_SAMPLE ?? 0)), ["list_tasks"]);
  await server.connect(new StdioServerTransport());
}
