import { expect, test } from "bun:test";
import { mapAgentLine, progressForEvent } from "./progress";
test("maps only commentary and redacts credentials", () => {
  expect(
    mapAgentLine(
      "codex",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Checking notes\nNext" },
      }),
    ),
  ).toEqual([{ type: "note", text: "Checking notes\nNext" }]);
  expect(
    mapAgentLine(
      "codex",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '{"action":"reply"}' },
      }),
    ),
  ).toEqual([]);
  expect(
    mapAgentLine(
      "codex",
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution" },
      }),
    )[0]?.type,
  ).toBe("violation");
  expect(
    mapAgentLine(
      "claude",
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["StructuredOutput", "Bash"],
        mcp_servers: [],
      }),
    )[0]?.type,
  ).toBe("violation");
  expect(
    mapAgentLine(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Checking" },
            { type: "tool_use", name: "StructuredOutput" },
          ],
        },
      }),
    ),
  ).toEqual([{ type: "note", text: "Checking" }]);
  const progress = progressForEvent({
    type: "note",
    text: "Bearer abc123\n next",
  });
  expect(progress?.kind).toBe("note");
  expect(progress?.label).not.toContain("abc123");
  expect(progress?.label).not.toContain("\n");
});
test("note progress uses the first non-empty line and preserves code points", () => {
  expect(
    progressForEvent({ type: "note", text: "  \n  First line  \nSecond line" })?.label,
  ).toBe("First line");
  const label = progressForEvent({
    type: "note",
    text: "😀".repeat(161) + "\nLater",
  })?.label;
  expect(label).toBe("😀".repeat(160));
});
test("the web search events pass only when the profile has web search, and nothing else new does", () => {
  const search = { webSearch: true };
  const codexStarted = JSON.stringify({ type: "item.started", item: { id: "s1", type: "web_search", query: "", action: { type: "other" } } });
  const codexDone = JSON.stringify({ type: "item.completed", item: { id: "s1", type: "web_search", query: "bun version", action: { type: "search", query: "bun version" } } });
  expect(mapAgentLine("codex", codexStarted)[0]?.type).toBe("violation");
  expect(mapAgentLine("codex", codexStarted, search)).toEqual([{ type: "tool", phase: "start", tool: "web_search", ok: null }]);
  expect(mapAgentLine("codex", codexDone, search)).toEqual([{ type: "tool", phase: "done", tool: "web_search", ok: null }]);
  for (const type of ["command_execution", "mcp_tool_call", "file_change", "collab_tool_call"])
    expect(mapAgentLine("codex", JSON.stringify({ type: "item.started", item: { type } }), search)[0]?.type).toBe("violation");
  const init = (tools: string[]) => JSON.stringify({ type: "system", subtype: "init", tools, mcp_servers: [] });
  expect(mapAgentLine("claude", init(["StructuredOutput", "WebSearch"]))[0]?.type).toBe("violation");
  expect(mapAgentLine("claude", init(["WebSearch", "StructuredOutput"]), search)).toEqual([]);
  expect(mapAgentLine("claude", init(["StructuredOutput"]), search)[0]?.type).toBe("violation");
  expect(mapAgentLine("claude", init(["StructuredOutput", "WebSearch", "WebFetch"]), search)[0]?.type).toBe("violation");
  const use = (name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: { query: "q" } }] } });
  expect(mapAgentLine("claude", use("WebSearch"))[0]?.type).toBe("violation");
  expect(mapAgentLine("claude", use("WebSearch"), search)).toEqual([{ type: "tool", phase: "start", tool: "web_search", ok: null }]);
  expect(mapAgentLine("claude", use("WebFetch"), search)[0]?.type).toBe("violation");
  expect(mapAgentLine("claude", use("Bash"), search)[0]?.type).toBe("violation");
  // A search reaches the service as a tool progress line.
  expect(progressForEvent({ type: "tool", phase: "start", tool: "web_search", ok: null })).toMatchObject({ kind: "tool_start", tool: "web_search", status: "running" });
});
