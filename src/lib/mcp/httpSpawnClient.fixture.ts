import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A spawned MCP consumer reads only its generated server definition and launch
// capability. No access key, provider login or model request is involved.
const entry = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).mcpServers.viewer;
const headers = Object.fromEntries(Object.entries(entry.headers as Record<string, string>).map(([name, value]) => [
  name, value.replace(/\$\{([^}]+)\}/g, (_, variable) => process.env[variable] ?? ""),
]));
const client = new Client({ name: "spawn-access-fixture", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } }));
  const result = await client.callTool({ name: "list_tasks", arguments: { ids: ["task-fixture-absent"] } });
  const text = (result.content as Array<{ text: string }>)[0]?.text;
  if (!text || JSON.parse(text).ok !== true) throw new Error("MCP tool call failed");
  console.log("MCP tool call succeeded");
} catch {
  // Diagnostics deliberately contain neither headers nor the generated config.
  console.error("MCP fixture could not call Delegatus");
  process.exitCode = 1;
} finally { await client.close(); }
