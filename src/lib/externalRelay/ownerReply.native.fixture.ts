// A stdio MCP server named like the Viewer's that offers only relay_answer,
// with the production description and schema, and records every call.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { relayAnswerDescription, relayAnswerSchema } from "./protocol";

const log = process.argv[2];
if (!log) throw new Error("usage: ownerReply.native.fixture.ts <call log>");
const server = new McpServer({ name: "viewer", version: "1.0.0" });
server.registerTool("relay_answer", { description: relayAnswerDescription, inputSchema: relayAnswerSchema }, async (args) => {
  fs.appendFileSync(log, `${JSON.stringify(args)}\n`);
  const receipt = { text_chars: Array.from(args.text ?? "").length, format: args.format ?? "rich_markdown", buttons: args.buttons ?? [], attachments: [] };
  return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
});
await server.connect(new StdioServerTransport());
