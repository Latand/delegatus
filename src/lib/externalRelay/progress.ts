import { redactTranscriptText } from "@/components/feed/toolRedaction";
import type { ExternalRelayProgress } from "./protocol";
export type EphemeralAgentEvent =
  | { type: "note"; text: string }
  | { type: "tool"; phase: "start" | "done"; tool: string; ok: boolean | null }
  | { type: "violation"; detail: string };
export function mapAgentLine(
  engine: "claude" | "codex",
  line: string,
): EphemeralAgentEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (engine === "codex") {
    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = event.item as Record<string, unknown> | undefined;
      if (
        !item ||
        !["agent_message", "reasoning", "error"].includes(String(item.type))
      )
        return [{ type: "violation", detail: "unexpected Codex item" }];
      if (
        event.type === "item.completed" &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        try {
          JSON.parse(item.text);
          return [];
        } catch {
          return [{ type: "note", text: item.text }];
        }
      }
    }
    return [];
  }
  if (event.type === "system" && event.subtype === "init") {
    const tools = event.tools;
    const servers = event.mcp_servers;
    if (
      !Array.isArray(tools) ||
      tools.length !== 1 ||
      tools[0] !== "StructuredOutput" ||
      !Array.isArray(servers) ||
      servers.length !== 0
    )
      return [{ type: "violation", detail: "unexpected Claude tools" }];
  }
  if (event.type !== "assistant") return [];
  const message = event.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return [];
  const events: EphemeralAgentEvent[] = [];
  for (const block of message.content as Record<string, unknown>[]) {
    if (block.type === "tool_use" && block.name !== "StructuredOutput")
      return [{ type: "violation", detail: "unexpected Claude tool" }];
    if (block.type === "text" && typeof block.text === "string")
      events.push({ type: "note", text: block.text });
  }
  return events;
}
export function progressForEvent(
  event: EphemeralAgentEvent,
): ExternalRelayProgress | null {
  if (event.type === "violation") return null;
  const raw = event.type === "note" ? event.text : event.tool;
  const label = redactTranscriptText(raw)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (!label) return null;
  return {
    kind:
      event.type === "note"
        ? "note"
        : event.phase === "start"
          ? "tool_start"
          : "tool_done",
    label,
    tool: event.type === "tool" ? event.tool.slice(0, 64) : null,
    status:
      event.type === "tool"
        ? event.phase === "start"
          ? "running"
          : event.ok === false
            ? "failed"
            : "completed"
        : null,
    at: new Date().toISOString(),
  };
}
