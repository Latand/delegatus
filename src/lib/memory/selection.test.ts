import { expect, test } from "bun:test";
import { requestBody } from "../../../scripts/memory-selection";
import { groundedRequest, selectOffers, memoryGate } from "./selection";

const candidate = { id: "m_fixture", title: "Widget parser", summary: "Widget delimiters must be escaped twice.", body: "Apply this to the legacy widget parser.", engine: "claude", kind: "project_fact", scope: "project", writtenAt: "2026-10-01" };
const input = { id: "case", prompt: "Update the widget parser for escaped delimiters", engine: "codex", project: "project-widget", context: [{ role: "user", text: "Fix widget parsing" }, { role: "assistant", text: "I will inspect the parser." }], candidates: [candidate], retrievalMs: 0, strictCount: 0 };
test("the live request is exactly the research grounded request, including body evidence and examples", () => {
  expect(JSON.stringify(groundedRequest(input))).toBe(JSON.stringify(requestBody(input, "grounded")));
});
test("every operator message, including short followups, is eligible; machine and unknown origins abstain", () => {
  expect(memoryGate({ enabled: true, origin: "operator", prompt: "Proceed" })).toBe(true);
  for (const origin of ["agent", "unknown"]) expect(memoryGate({ enabled: true, origin, prompt: input.prompt })).toBe(false);
  expect(memoryGate({ enabled: false, origin: "operator", prompt: input.prompt })).toBe(false);
});
test("confidence chooses zero to fifteen complete lines inside ten thousand characters", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({ ...candidate, id: `m_fixture_${i}`, summary: "界".repeat(800) }));
  const scores = Object.fromEntries(candidates.map((c, i) => [c.id, i === 0 ? .69 : .7]));
  const result = selectOffers(candidates, scores);
  expect(result.entries.length).toBeGreaterThan(0);
  expect(result.entries.length).toBeLessThanOrEqual(15);
  expect(result.block.length).toBeLessThanOrEqual(10000);
  expect(result.entries.some(e => e.id === candidates[0].id)).toBe(false);
  expect(result.block).toContain("possibly stale");
  expect(result.block).toContain("search_memory id");
  expect(selectOffers(candidates, {}).block).toBe("");
  expect(selectOffers(candidates, { [candidates[0].id]: NaN }).block).toBe("");
});
