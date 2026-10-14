import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lesson-matcher-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const { roleMemoryCollection, storedLessonTexts, withoutStoredLessons, withoutStoredLessonsIn, WITHHELD_LESSON } = await import("./roleStore");
const { lessonPattern } = await import("./roleConsolidate");
type RoleMemoryRule = import("./roleTypes").RoleMemoryRule;

let generation = 0;
beforeEach(() => {
  process.env.LLV_STATE_DIR = path.join(sandbox, String(++generation));
});

function store(texts: string[], why = "") {
  roleMemoryCollection(true)!.boundedPatch(texts.length, tx => {
    texts.forEach((rule, index) => tx.put({
      kind: "rule", id: `r_${generation}_${index}`, scope: index % 2 ? "machine" : "role:matcher:builder",
      rule, why, state: index % 2 ? "archived" : "active", ...(index % 3 === 0 ? { versionOf: "r_previous" } : {}), hints: [],
      source: { project: "matcher", pipelineId: "matcher", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_matcher" },
      createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z",
    } satisfies RoleMemoryRule));
  });
}

const longLesson = (index: number) => `Lesson${index} ${Array.from({ length: 40 }, (_, word) => `instruction${word}`).join(" ")} finish${index}`;

test("thousands of long lessons from all scopes and versions compile and are withheld", () => {
  const lessons = Array.from({ length: 2000 }, (_, index) => longLesson(index));
  const why = "Earlier attempts omitted the required verification before their handoff";
  store(lessons, why);
  expect(storedLessonTexts()).toHaveLength(2001);
  const prompt = lessons.join("\n");
  expect(withoutStoredLessons(prompt)).toBe(Array(2000).fill(WITHHELD_LESSON).join("\n"));
  expect(withoutStoredLessons(why.toUpperCase().replaceAll(" ", " --\n"))).toBe(WITHHELD_LESSON);
  const record = { prompt: lessons[0], nested: [lessons.at(-1), { reason: why }], number: 3 };
  expect(withoutStoredLessonsIn(record)).toEqual({ prompt: WITHHELD_LESSON, nested: [WITHHELD_LESSON, { reason: WITHHELD_LESSON }], number: 3 });
}, 30_000);

test("overlaps across chunks keep the longer alternative and the original leftmost match", () => {
  const longer = `Verify every durable receipt before handing the operation to another owner${" with documented context".repeat(80)}`;
  const shorter = "Verify every durable receipt";
  const later = "durable receipt before handing the operation to another owner";
  store([longer, shorter, later, ...Array.from({ length: 500 }, (_, index) => longLesson(index))]);
  expect(withoutStoredLessons(longer)).toBe(WITHHELD_LESSON);
  const prompt = `${longer} extra`;
  const reference = new RegExp([longer, later, shorter].map(text => `(?:${lessonPattern(text)!.source})`).join("|"), "giu");
  expect(withoutStoredLessons(prompt)).toBe(prompt.replace(reference, WITHHELD_LESSON));
  // A longer alternative starting later must not consume an earlier match.
  store([shorter, `${later}${" with documented context".repeat(80)} extra`, ...Array.from({ length: 500 }, (_, index) => longLesson(index))]);
  expect(withoutStoredLessons(prompt)).toBe(`${WITHHELD_LESSON}${prompt.slice(shorter.length)}`);
});

test("an oversized single lesson is skipped with one counted warning per signature", () => {
  const oversized = "oversizedword ".repeat(80_000).trim();
  const ordinary = "Preserve the receipt until its owning operation has completed";
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    store([oversized, ordinary]);
    expect(storedLessonTexts()).toContain(oversized);
    expect(withoutStoredLessons(ordinary)).toBe(WITHHELD_LESSON);
    expect(withoutStoredLessons(oversized)).toBe(oversized);
    expect(withoutStoredLessonsIn({ ordinary })).toEqual({ ordinary: WITHHELD_LESSON });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toEqual([expect.stringContaining("skipped 1")]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("oversizedword");
  } finally {
    warning.mockRestore();
  }
}, 30_000);

test("the cached matcher refreshes after a store write and preserves unchanged records", () => {
  const first = "Check the first operation before accepting its receipt";
  const second = "Check the second operation before accepting its receipt";
  store([first]);
  expect(withoutStoredLessons(first)).toBe(WITHHELD_LESSON);
  expect(withoutStoredLessons(second)).toBe(second);
  store([second]);
  expect(withoutStoredLessons(second)).toBe(WITHHELD_LESSON);
  const untouched = { nested: ["ordinary launch instructions", { count: 1 }] };
  expect(withoutStoredLessonsIn(untouched)).toBe(untouched);
});

test("prefiltering preserves Unicode case folding, punctuation and short legacy texts", () => {
  const lessons = ["Kelvin verification required", "ΣΣΣΣ verification required", "ssss verification required", "µµµµ verification required", "Use abc+def"];
  store(lessons);
  for (const quote of ["Kelvin VERIFICATION -- required", "ςςςς verification required", "ſſſſ verification required", "μμμμ verification required", "use abc+def"]) {
    expect(withoutStoredLessons(quote)).toBe(WITHHELD_LESSON);
  }
});

test("symbol-only legacy lessons are withheld without a word prefilter", () => {
  store(["....++++"]);
  expect(withoutStoredLessons("....++++")).toBe(WITHHELD_LESSON);
});

test("withholding a 50 KB launch prompt with 2000 long lessons", () => {
  const lessons = Array.from({ length: 2000 }, (_, index) => longLesson(index));
  store(lessons);
  const quoted = lessons[1999];
  const prompt = "Ordinary instructions for the next pipeline stage. ".repeat(1100).slice(0, 50 * 1024 - quoted.length - 1) + "\n" + quoted;
  const started = performance.now();
  expect(withoutStoredLessons(prompt)).toBe(prompt.slice(0, -quoted.length) + WITHHELD_LESSON);
  const coldMs = performance.now() - started;
  const samples = Array.from({ length: 20 }, () => {
    const start = performance.now();
    withoutStoredLessons(prompt);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.info(JSON.stringify({ lessonMatcherBenchmark: { lessons: lessons.length, promptBytes: Buffer.byteLength(prompt),
    coldMs: Number(coldMs.toFixed(2)), warmMedianMs: Number(samples[10].toFixed(2)), warmMaxMs: Number(samples.at(-1)!.toFixed(2)) } }));
}, 30_000);
