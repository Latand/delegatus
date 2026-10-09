import { expect, test } from "bun:test";
import { requestBody } from "../../../scripts/memory-selection";
import { groundedRequest, selectOffers, memoryGate, nativeMatch } from "./selection";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

const candidate = { id: "m_fixture", title: "Widget parser", summary: "Widget delimiters must be escaped twice.", body: "Apply this to the legacy widget parser.", engine: "claude", kind: "project_fact", scope: "project", writtenAt: "2026-10-01" };
const input = { id: "case", prompt: "Update the widget parser for escaped delimiters", engine: "codex", project: "project-widget", context: [{ role: "user", text: "Fix widget parsing" }, { role: "assistant", text: "I will inspect the parser." }], candidates: [candidate], retrievalMs: 0, strictCount: 0 };
test("short exact bodies deduplicate across names while distinct short rules remain eligible", () => {
  const note = { ...candidate, title: "Widget", summary: "Widget uses paired escaping.", body: "Widget uses paired escaping." };
  expect(nativeMatch(note, { ...note, title: "Routing", body: "\nWidget  uses\tpaired escaping.\n" })).toBe(true);
  expect(nativeMatch(note, { ...note, body: "Widget uses single escaping." })).toBe(false);
  expect(nativeMatch(note, { ...note, body: "Widget paired escaping uses." })).toBe(false);
  expect(nativeMatch({ ...note, body: "Café." }, { ...note, body: "Cafe\u0301." })).toBe(true);
  expect(nativeMatch({ ...note, body: " " }, { ...note, body: "\n" })).toBe(false);
  expect(nativeMatch({ ...note, summary: "Widget flags enabled.", body: "Yes." }, { ...note, summary: "Widget alerts enabled.", body: "Yes." })).toBe(false);
  expect(nativeMatch({ ...note, summary: "Pinned interpreter.", body: "Widget uses Bun." }, { ...note, summary: "Widget uses Bun.", body: "Widget uses Bun." })).toBe(true);
});

test("the live request is exactly the research grounded request, including body evidence and examples", () => {
  expect(JSON.stringify(groundedRequest(input))).toBe(JSON.stringify(requestBody(input, "grounded")));
});
for (const [locale, dictionary] of [["en", en], ["uk", uk]] as const) for (const key of ["draft.readPrompt", "link.handoffContext"] as const) test(`${locale} ${key} context matches main's grounded request`, () => {
  const template = dictionary[key];
  if (typeof template !== "string") throw Error("Expected a string UI template");
  const text = template.replaceAll("{src}", "fixture").replaceAll("{title}", "Widget parser")
    .replaceAll("{path}", "workspace/widget.jsonl").replaceAll("{ask}", "Update widget parser") + (key === "draft.readPrompt" ? "Update widget parser" : "");
  const wrapped = { ...input, context: [{ role: "user", text }, { role: "assistant", text: "Ready" }] };
  expect(JSON.stringify(groundedRequest(wrapped))).toBe(JSON.stringify(requestBody(wrapped, "grounded")));
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
