/**
 * A stand-in for the `claude` binary a structured host launches, for tests
 * that drive the production launch path end to end: the host's auth and
 * version probes, the stream-json session, the transcript the Viewer reads.
 *
 * It keeps the two orderings the real CLI has and a test may depend on. The
 * `viewer` MCP server named by `--mcp-config` is connected before the first
 * turn starts (a Streamable HTTP entry gets its `initialize` POST, headers
 * expanded from this process's environment, exactly as Claude expands them),
 * and a transcript line exists before the turn's replay is echoed. What it
 * saw is written to `.claude-fixture.json` in its working directory, since the
 * host passes only an allowlisted environment and there is no other channel.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { claudeTranscriptPath } from "../../agent/transcript";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })}\n`);
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("2.1.280 (Claude Code)\n");
  process.exit(0);
}

const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "";
const evidencePath = path.join(process.cwd(), ".claude-fixture.json");
const evidence: { viewer: JsonObject | null; turns: string[] } = { viewer: null, turns: [] };
const record = () => fs.writeFileSync(evidencePath, JSON.stringify(evidence));

const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
const mcpConfigPath = flag("--mcp-config");
const viewer = mcpConfigPath
  ? object(object(object(JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")))?.mcpServers)?.viewer)
  : null;
if (viewer?.type === "http" && typeof viewer.url === "string") {
  const headers = Object.fromEntries(Object.entries(object(viewer.headers) ?? {})
    .map(([name, value]) => [name, expand(String(value))]));
  const response = await fetch(viewer.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.280" } },
    }),
  });
  evidence.viewer = { type: "http", status: response.status };
} else if (viewer) {
  evidence.viewer = { type: "stdio", command: viewer.command ?? null };
}
record();

const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? "", "projects");
const transcript = claudeTranscriptPath(process.cwd(), sessionId, projects);
const append = (line: JsonObject) => {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ ...line, sessionId, timestamp: new Date().toISOString() })}\n`);
};
const emit = (frame: JsonObject) => process.stdout.write(`${JSON.stringify({ ...frame, session_id: sessionId })}\n`);

emit({ type: "system", subtype: "init", apiKeySource: "none" });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line) continue;
  const frame = object(JSON.parse(line));
  const message = object(frame?.message);
  if (frame?.type !== "user" || message?.role !== "user") continue;
  const text = Array.isArray(message.content)
    ? message.content.map((block) => String(object(block)?.text ?? "")).join("")
    : String(message.content ?? "");
  const uuid = crypto.randomUUID();
  append({ type: "user", uuid, message: { role: "user", content: message.content } });
  evidence.turns.push(text);
  record();
  emit({ type: "user", uuid, message: { role: "user", content: message.content } });
  const reply = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  append({ type: "assistant", uuid: crypto.randomUUID(), message: reply });
  emit({ type: "assistant", message: reply });
  emit({ type: "result", subtype: "success" });
}
