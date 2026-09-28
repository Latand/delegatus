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
