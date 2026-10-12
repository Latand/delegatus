import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { TOOL_INPUT_SCHEMAS } from "@/lib/mcp/server";
import { AgentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { curatorCallerOf } from "./guard";
import { applyCuration, type CurationApply } from "./apply";
import { readCuration } from "./read";
import { readPass } from "./store";

if (process.env.LLV_CURATOR_EVAL !== "1") throw Error("fixture server requires the opt-in evaluation gate");
const pass = readPass(process.env.LLV_CURATOR_EVAL_PASS ?? "");
if (!pass) throw Error("isolated evaluation pass is missing");
const snapshot = structuredClone(new AgentRegistry(statePath("eval-registry.json")).readOnlySnapshot());
const id = ["conversation", "evaluation"].join("_") as `conversation_${string}`;
snapshot.conversations[id] = { id, agentRole: "curator", generations: [], continuityPaths: [] } as never;
snapshot.receipts.fixture = { conversationId: id, agentRole: "curator", clientAttemptId: pass.id, state: "completed", launchId: "fixture", artifactPath: null } as never;
const server = new McpServer({ name: "curator-evaluation", version: "1.0.0" });
server.registerTool("curate_rules", { description: "Read or apply this isolated curator pass. Orders are best first. Every change needs a note; follow the pass checklist.", inputSchema: TOOL_INPUT_SCHEMAS.curate_rules }, async args => {
  try {
    const held = curatorCallerOf(id, snapshot);
    const result = args.action === "read" ? readCuration(held, typeof args.scope === "string" ? args.scope : undefined, typeof args.cursor === "string" ? args.cursor : undefined) : applyCuration(held, args as unknown as CurationApply);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: (error as { code?: string }).code ?? "CURATE_FAILED", error: (error as Error).message }) }] };
  }
});
await server.connect(new StdioServerTransport());
fs.writeFileSync(statePath("eval-tool-started"), "started\n");
