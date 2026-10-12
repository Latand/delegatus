import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prototypePicture, prototypeTask, storePrototypePictures } from "./prototypeRead.fixture";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-review-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
const { saveTasks } = await import("@/lib/tasks/store");
const { CompanionBoardReads, VOICE_IMAGES } = await import("./boardReads");
const { createCompanionBoardReadPaths } = await import("./readPaths");
const reads = () => new CompanionBoardReads(createCompanionBoardReadPaths());
const pictures = (result: import("./boardReads").SpeechReadResult) => Reflect.get(result, VOICE_IMAGES) as Array<{ mime: string; data: string }> | undefined;
beforeEach(() => saveTasks([]));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("one voice read keeps a 128-frame round and its complete questionnaire under 6000 bytes", async () => {
  const task = prototypeTask(); saveTasks([task]);
  const result = await reads().call("fixture", "read_prototype_review", { taskId: task.id });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(6000);
  expect(result.item).toMatchObject({ title: task.prototypeReviews![0].title, frames: 128,
    variants: task.prototypeReviews![0].variants.map(v => ({ number: v.number, name: v.name, description: v.description, frames: v.frames.length })),
    questions: task.prototypeReviews![0].questions!.map(q => ({ id: q.id, text: q.text, options: q.options.map(o => o.label), recommended: 0 })) });
  const text = JSON.stringify(result);
  expect(text).not.toContain("a".repeat(64));
  for (const view of ["390 px", "uk/en", "light/dark", "with original", "Today: rows retain their order."]) expect(text).toContain(view);
  const variants = (result.item as { variants: Array<{ views: string[] }> }).variants;
  for (const variant of variants) expect(variant.views.reduce((sum, view) => sum + Number(view.match(/(\d+) with original/)?.[1] ?? 0), 0)).toBe(16);
});

test("waiting discovery and round words stay in the selected project, with truthful empty and ambiguous answers", async () => {
  const one = prototypeTask(); const two = prototypeTask("second-task"); two.prototypeReviews![0].id = `pr_${"d".repeat(32)}`;
  two.prototypeReviews![0].title = "Інший огляд";
  const foreign = prototypeTask("foreign-task", "foreign");
  saveTasks([one, two, foreign]);
  const waiting = await reads().call("fixture", "read_prototype_review", {});
  expect(waiting).toMatchObject({ status: "several", rows: [{ taskId: one.id }, { taskId: two.id }] });
  expect(JSON.stringify(waiting)).not.toContain(foreign.id);
  const found = await reads().call("fixture", "read_prototype_review", { query: "свіжа добірка" });
  expect(found).toMatchObject({ match: "single", item: { taskId: one.id, title: one.prototypeReviews![0].title } });
  for (const query of ["панель", "щільність", "у рядку"]) expect(await reads().call("fixture", "read_prototype_review", { query })).toMatchObject({ status: "several", total: 2 });
  const none = await reads().call("fixture", "read_prototype_review", { query: "absent" });
  expect(none).toMatchObject({ status: "none", rows: [{ taskId: one.id }, { taskId: two.id }] });
  expect(none.speech).toBe("No prototype review in fixture matches «absent». Nothing about a prototype was read. Say exactly that and what was searched for. The reviews that wait are in rows.");
  saveTasks([one, foreign]);
  expect(await reads().call("fixture", "read_prototype_review", {})).toMatchObject({ match: "single", item: { taskId: one.id } });
});

test("a guessed handle with no review names its task and a foreign task is refused", async () => {
  const task = prototypeTask(); task.prototypeReviews = [];
  saveTasks([task, prototypeTask("foreign-task", "foreign")]);
  const result = await reads().call("fixture", "read_prototype_review", { taskId: task.id });
  expect(result).toMatchObject({ status: "no_review", truncated: false });
  expect(result.speech).toBe(`Task «${task.text}» has no prototype review. Nothing about a prototype was read. This handle names no review: search with taskId null and the operator's words in query.`);
  await expect(reads().call("fixture", "read_prototype_review", { taskId: "foreign-task" })).rejects.toThrow("PROJECT_REFUSED");
  expect((await reads().call("fixture", "read_prototype_review", {})).speech).toBe("No prototype review waits on the operator in fixture. Nothing about a prototype was read. Say exactly that; to read a decided review, ask again with the operator's words in query.");
});

test("a compact decided round retains the exact comment and answered labels without exposing internal delivery text", async () => {
  const task = prototypeTask(); const round = task.prototypeReviews![0];
  round.decision = { chosen: [2], answers: [{ questionId: "question-0", options: [1] }], comment: "Keep this line.\nAnd this spacing.  ", at: round.createdAt,
    delivery: { state: "sent", clientMessageId: "fixture-decision", conversationId: null, text: "Internal delivery text" } };
  saveTasks([task]);
  const result = await reads().call("fixture", "read_prototype_review", { taskId: task.id });
  expect(result.item).toMatchObject({ state: "decided", decision: { chosen: [{ number: 2, name: "Панель" }], answers: [{ options: ["У рядку"] }], comment: round.decision.comment } });
  expect(JSON.stringify(result)).not.toContain("Internal delivery text");
  expect(await reads().call("fixture", "read_prototype_review", {})).toMatchObject({ status: "none" });
});

test("a single frame call compares three variants by view and opens originals in requested order", async () => {
  const task = prototypeTask(); await storePrototypePictures(task); saveTasks([task]);
  const args = { query: "свіжа добірка", variants: [3, 1, 2], view: "board dark", width: 1440, lang: "uk" };
  const result = await reads().call("fixture", "view_prototype_frame", args);
  expect(result).toMatchObject({ status: "done", item: { attached: [3, 1, 2].map(variant => ({ variant, view: "Board · 1440 px · uk · dark", width: 1440, lang: "uk", original: false })) } });
  expect(pictures(result)).toHaveLength(3);
  expect(pictures(result)!.map(image => Buffer.from(image.data, "base64").toString().slice(-7))).toEqual(["3 image", "1 image", "2 image"]);
  const originals = await reads().call("fixture", "view_prototype_frame", { ...args, original: true });
  expect(pictures(originals)!.map(image => Buffer.from(image.data, "base64").toString().slice(-10))).toEqual(["3 original", "1 original", "2 original"]);
  expect(JSON.stringify(result)).not.toContain("base64");
});

test("missing view and removed picture refuse honestly, with available views and no image", async () => {
  const task = prototypeTask(); await storePrototypePictures(task); saveTasks([task]);
  const result = await reads().call("fixture", "view_prototype_frame", { taskId: task.id, variants: [1], view: "missing screen" });
  expect(result).toMatchObject({ status: "refused", code: "FRAME_UNAVAILABLE", item: { missing: [{ variant: 1, views: expect.arrayContaining([expect.stringContaining("Board")]) }] } });
  expect(result.speech).toBe("No frame was opened: variant 1: no frame matches the requested view. Nothing was seen. Say that you could not view it and what you asked for, and describe nothing about how it looks.");
  expect(pictures(result)).toBeUndefined();
  const { prototypeRoot } = await import("@/lib/prototypeReview/store");
  fs.rmSync(prototypeRoot(), { recursive: true, force: true });
  const removed = await reads().call("fixture", "view_prototype_frame", { taskId: task.id, variants: [1], view: "board" });
  expect(removed).toMatchObject({ status: "refused", code: "FRAME_UNAVAILABLE" });
  expect(removed.speech).toContain("stored picture is unavailable");
  expect(pictures(removed)).toBeUndefined();
});

test("partial comparisons disclose the omitted picture at the 8 MiB call limit", async () => {
  const task = prototypeTask();
  for (const variant of task.prototypeReviews![0].variants) { variant.frames = [variant.frames[0]]; delete variant.frames[0].original; }
  await storePrototypePictures(task, Buffer.concat([prototypePicture, Buffer.alloc(3 * 1024 * 1024)])); saveTasks([task]);
  const result = await reads().call("fixture", "view_prototype_frame", { taskId: task.id, variants: [1, 2, 3] });
  expect(result).toMatchObject({ status: "done", item: { attached: [{ variant: 1 }, { variant: 2 }], missing: [{ variant: 3, reason: "the 8 MiB picture budget is spent" }] } });
  expect(pictures(result)).toHaveLength(2);
  expect(result.speech).toContain("Not attached: variant 3: the 8 MiB picture budget is spent.");
});

test("a later decision supersedes old waiting rounds, while an explicit round remains readable", async () => {
  const task = prototypeTask(); const older = task.prototypeReviews![0];
  const decided = structuredClone(older); decided.id = `pr_${"f".repeat(32)}`; decided.createdAt = "2026-10-11T12:00:00.000Z";
  decided.decision = { chosen: [1], comment: "Saved choice", at: decided.createdAt, delivery: { state: "sent", clientMessageId: "fixture-choice", conversationId: null, text: "Internal" } };
  task.prototypeReviews!.push(decided); saveTasks([task]);
  expect(await reads().call("fixture", "read_prototype_review", {})).toMatchObject({ status: "none" });
  expect(await reads().call("fixture", "read_prototype_review", { taskId: task.id })).toMatchObject({ item: { reviewId: decided.id, state: "decided" } });
  expect(await reads().call("fixture", "read_prototype_review", { taskId: task.id, reviewId: older.id })).toMatchObject({ item: { reviewId: older.id, state: "superseded" } });
});
