import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-matcher-memory-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { hasStoredLesson, roleMemoryCollection, withoutStoredLessonsIn } = await import("./roleStore");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/* Lessons and text in a non-Latin script, as a store written in Ukrainian
   holds them. They share a vocabulary, as real lessons do with the task
   texts and reports they are matched against. */
const WORDS = "перевір читай збережи журнал ревізію перед після спільний запис настанову область читач доказ поточний власник задача квитанція операція збирач рецензія стадія проєкт пам’ять правило історія воркер маршрут стан резерв токен конвеєр гілка злиття деплой тест рендер ширина тема мова елемент кадр реліз порівняй список кожну зміну додає переносить налаштування ділянка".split(" ");
let seed = 7;
/** A small deterministic generator (mulberry32). */
const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sentence = (count: number) => Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
const RULES = 1000;
const source = { project: "matcher-memory-fixture", pipelineId: "p", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "c" };
const lessons = Array.from({ length: RULES }, () => ({ rule: sentence(38), why: sentence(18) }));
roleMemoryCollection(true)!.patchSync(() => ({ records: lessons.map((lesson, index) => ({ kind: "rule" as const, id: `r_${String(index).padStart(16, "0")}`, scope: "machine", ...lesson, state: "active" as const, hints: [], source,
  createdAt: "2026-10-11T00:00:00.000Z", changedAt: "2026-10-11T00:00:00.000Z" })) }));

test("matching text against a thousand non-Latin lessons adds little resident memory and is quick", () => {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const text = `${sentence(1500)}\n${lessons[17]!.rule.toUpperCase()}\n${sentence(1500)}`;
  const filtered = withoutStoredLessonsIn({ title: sentence(12), body: text }, { requireComplete: true });
  expect(filtered.body).toContain("[learned rule]");
  expect(filtered.body).not.toContain(lessons[17]!.rule.toUpperCase());
  expect(hasStoredLesson(sentence(3000))).toBe(false);
  expect(hasStoredLesson(`x ${lessons[400]!.why} y`)).toBe(true);
  const addedMb = (process.memoryUsage().rss - before) / 1024 / 1024;
  const seconds = (performance.now() - started) / 1000;
  // The patterns of every lesson, compiled and run, held about 0.6 GB here and took over ten seconds.
  expect(addedMb).toBeLessThan(150);
  expect(seconds).toBeLessThan(5);
}, 120_000);
