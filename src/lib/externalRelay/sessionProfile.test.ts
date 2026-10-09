import { expect, test } from "bun:test";
import { mapAgentLine } from "./progress";
test("Codex compaction events are admitted only in a persistent session", () => {
  const line = JSON.stringify({ type: "item.completed", item: { type: "context_compaction" } });
  expect(mapAgentLine("codex", line)[0]?.type).toBe("violation");
  expect(mapAgentLine("codex", line, { webSearch: false, session: true })).toEqual([]);
});
