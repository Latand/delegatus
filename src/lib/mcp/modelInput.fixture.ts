import { protectNativeMediaContext, NATIVE_MEDIA_CONTEXT_WAIT_MS } from "@/lib/externalRelay/nativeMediaContext";
import { withRelayImages } from "@/lib/externalRelay/ownerToolContent";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createViewerMcpServer } from "./server";
import results from "./fixtures/modelResults.json";
import type { McpToolResult } from "./server";

export const modelResultSamples = results as McpToolResult[];
export const fixtureImage = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwnwGMERQARNAF+661WskAAAAASUVORK5CYII=" };
export const fixtureToolName = (index: number) => index === 4 ? "relay_service_tools" as const : "list_tasks" as const;
export const fixtureService = (index = 0, contextRoot = process.env.MCP_CONTEXT_ROOT) => ({ async callTool(): Promise<McpToolResult> {
  if (index === 4) {
    if (!contextRoot) throw new Error("fixture context unavailable");
    const until = Date.now() + NATIVE_MEDIA_CONTEXT_WAIT_MS;
    let files: string[];
    for (;;) {
      files = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: contextRoot, absolute: true })];
      if (files.length || Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (files.length !== 1) throw new Error("fixture context ambiguous");
    await protectNativeMediaContext(files[0]!);
  }
  return index === 4 ? withRelayImages({ ok: true as const, toolName: "relay_service_tools", clientRequestId: null, replayed: false, status: "completed" }, [fixtureImage]) : modelResultSamples[index];
} });

if (import.meta.main) {
  const index = Number(process.env.MCP_RESULT_SAMPLE ?? 0);
  const server = createViewerMcpServer(fixtureService(index), [fixtureToolName(index)]);
  await server.connect(new StdioServerTransport());
}
