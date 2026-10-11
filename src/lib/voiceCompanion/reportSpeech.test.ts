import { expect, test } from "bun:test";
import { speechParts, voiceReportText } from "./reportSpeech";

const MANAGER = { kind: "manager" as const, conversationId: "conversation_fixture", role: "orchestrator" };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const INTRO = 'Orchestrator report for project "fixture", result. Read the lines below as written:';
const CONTINUED = "The same report continues; read on as written, in order:";

test("the voice reads the uncut copy when there is one, and the display body without its header otherwise", () => {
  expect(voiceReportText({ origin: MANAGER, body: "✅ Fixture · completed · 11/10, 14:00\nThe plan was reviewed.\n\n🔀 Merged\n• the first fix", }))
    .toBe("The plan was reviewed.\n🔀 Merged\n• the first fix");
  expect(voiceReportText({ origin: MANAGER, body: "short", complete: { summary: "Відповідь для голосу.",
    sections: [{ heading: "В роботі", items: ["перший пункт", "другий пункт"] }, { heading: "Далі", items: ["третій"] }] } }))
    .toBe("Відповідь для голосу.\nВ роботі:\n- перший пункт\n- другий пункт\nДалі:\n- третій");
  expect(voiceReportText({ origin: { kind: "agent", conversationId: null, role: "builder" }, body: "[builder — not the manager] one · two" })).toBe("[builder — not the manager] one · two");
});

test("a long Ukrainian report is spoken whole: ordered appends within 500 bytes, every line in order, a long item continued rather than cut", () => {
  const items = Array.from({ length: 9 }, (_, index) => `- пункт ${index + 1}: ${"оркестратор перевірив звіт і відповів на питання. ".repeat(index === 4 ? 12 : 2).trim()}`);
  const text = ["Підсумок: два факти, кожен зі своїм субʼєктом.", "Змерджено:", ...items].join("\n");
  const parts = speechParts(INTRO, text, CONTINUED, 500);
  expect(parts.length).toBeGreaterThan(3);
  for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(500);
  expect(parts[0]!.startsWith(`${INTRO}\n`)).toBe(true);
  for (const part of parts.slice(1)) expect(part.startsWith(`${CONTINUED}\n`)).toBe(true);
  // Nothing lost, nothing reordered: the spoken lines, read back, are the report.
  const spoken = parts.map((part, index) => part.slice((index === 0 ? INTRO : CONTINUED).length + 1)).join("\n");
  expect(spoken.replace(/\s+/gu, "")).toBe(text.replace(/\s+/gu, ""));
  // Short lines stay whole within one append.
  for (const line of text.split("\n").filter(line => bytes(line) < 400)) expect(parts.some(part => part.split("\n").includes(line))).toBe(true);
});

test("two facts keep their own subjects and order; one unbroken word longer than an append is split between characters", () => {
  const facts = "- The review lane passed both rounds.\n- The deploy lane is still waiting for the operator.";
  const [only] = speechParts(INTRO, facts, CONTINUED, 500);
  expect(only).toBe(`${INTRO}\n${facts}`);
  const word = "ї".repeat(600);
  const parts = speechParts(INTRO, word, CONTINUED, 500);
  for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(500);
  expect(parts.map((part, index) => part.slice((index === 0 ? INTRO : CONTINUED).length + 1)).join("").replace(/\n/g, "")).toBe(word);
});

test("with no continuation line every later append is report text alone, still whole and in order", () => {
  const intro = 'The orchestrator for project "fixture" reports result.';
  const text = Array.from({ length: 12 }, (_, index) => `- пункт ${index + 1}: ревʼю пройшло, деплой чекає на рішення оператора.`).join("\n");
  const parts = speechParts(intro, text, "", 500);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(500);
  expect(parts[0]!.startsWith(`${intro}\n`)).toBe(true);
  expect(parts.join("\n")).toBe(`${intro}\n${text}`);
});
