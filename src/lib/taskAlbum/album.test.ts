import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { markTaskAlbumSeen, readTaskAlbum, readTaskAlbumImage, taskAlbumSummaries, type TaskAlbumDeps } from "./album";
import { fileAlbumSeenStore } from "./seen";
import type { TaskAlbumWorld } from "./sources";
import { indexTranscripts, resetTranscriptIndex, transcriptImages } from "./transcriptIndex";

/* A 1×1 PNG, as an agent's Read result carries it. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OTHER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-album-"));
const saved = { home: process.env.HOME, roots: process.env.LLV_EVIDENCE_ROOTS };
let home = "";
let evidence = "";
let elsewhere = "";
let transcripts = "";

beforeEach(() => {
  resetTranscriptIndex();
  const root = fs.mkdtempSync(path.join(sandbox, "case-"));
  home = path.join(root, "home");
  evidence = path.join(root, "evidence");
  elsewhere = path.join(root, "elsewhere");
  transcripts = path.join(home, ".claude", "projects", "p");
  for (const dir of [home, evidence, elsewhere, transcripts]) fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = home;
  process.env.LLV_EVIDENCE_ROOTS = evidence;
});
afterEach(() => {
  process.env.HOME = saved.home;
  if (saved.roots === undefined) delete process.env.LLV_EVIDENCE_ROOTS;
  else process.env.LLV_EVIDENCE_ROOTS = saved.roots;
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function png(dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(PNG, "base64"));
  return file;
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();

/* Claude records: a Read of an image and its result with the bytes. */
function claudeRead(id: string, file: string, minute: number): string[] {
  return [
    JSON.stringify({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] } }),
    JSON.stringify({ type: "user", timestamp: at(minute), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } }),
  ];
}

function claudeSays(text: string, minute: number): string {
  return JSON.stringify({ type: "assistant", timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text }] } });
}

function transcript(name: string, lines: string[]): string {
  const file = path.join(transcripts, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function task(id: string, paths: string[]): BoardTask {
  return {
    id,
    project: "p",
    status: "assigned",
    text: id,
    placement: "unplaced",
    assignments: paths.map((p) => ({ path: p, panePid: null, state: "linked", error: null, at: at(0) })),
    createdAt: at(0),
    updatedAt: at(0),
  } as BoardTask;
}

function deps(tasks: BoardTask[], pipelines: Pipeline[] = []): TaskAlbumDeps {
  const world: TaskAlbumWorld = {
    task: (id) => tasks.find((entry) => entry.id === id) ?? null,
    pipelines: () => pipelines,
    flow: () => null,
    conversationPaths: () => [],
    transcriptAllowed: () => true,
  };
  return { world, seen: fileAlbumSeenStore(path.join(home, "seen.json")) };
}

test("an image a task's agent Read appears in that task's album and not in another's", async () => {
  const render = png(evidence, "lane/after.png");
  const mine = transcript("mine", [claudeSays("starting", 1), ...claudeRead("toolu_1", render, 2)]);
  const theirs = transcript("theirs", [claudeSays("nothing to see", 3)]);
  const world = deps([task("task-a", [mine]), task("task-b", [theirs])]);

  const a = await readTaskAlbum("task-a", {}, world);
  expect(a.items.map((item) => item.name)).toEqual(["after.png"]);
  expect(a.items[0]!.src).toBe(`/api/artifact?${new URLSearchParams({ path: render })}`);
  expect(a.items[0]!.via).toBe("read");
  expect(a.items[0]!.source.path).toBe(mine);
  expect(a.items[0]!.ts).toBe(Date.parse(at(2)));

  const b = await readTaskAlbum("task-b", {}, world);
  expect(b.items).toEqual([]);
  expect(b.total).toBe(0);
});

test("a stage's conversation is named by its pipeline stage and attempt", async () => {
  const render = png(home, "Pictures/delegatus-review/topic/card.png");
  const stageTranscript = transcript("stage", [claudeSays(`Rendered ${render} for review.`, 4)]);
  const pipeline = { id: "pipe-1", taskIds: ["task-a"], runs: [{ stageId: "implement", attempts: [{ n: 2, conversationId: null, agentPath: stageTranscript, flowId: null }] }] } as unknown as Pipeline;
  const page = await readTaskAlbum("task-a", {}, deps([task("task-a", [stageTranscript])], [pipeline]));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.via).toBe("named");
  expect(page.items[0]!.source.stage).toEqual({ pipelineId: "pipe-1", stageId: "implement", attempt: 2 });
});

test("a named file outside the served roots, or one that does not exist, is left out", async () => {
  const outside = png(elsewhere, "secret.png");
  const inside = png(evidence, "kept.png");
  const doc = path.join(evidence, "notes.txt");
  fs.writeFileSync(doc, "text");
  const lines = [claudeSays(`See ${outside}, ${path.join(evidence, "missing.png")} and ${inside}.`, 5)];
  const page = await readTaskAlbum("task-a", {}, deps([task("task-a", [transcript("t", lines)])]));
  expect(page.items.map((item) => item.name)).toEqual(["kept.png"]);
});

test("a symlink under an evidence root that leads out of the roots is left out", async () => {
  const target = png(elsewhere, "target.png");
  const link = path.join(evidence, "link.png");
  fs.symlinkSync(target, link);
  const page = await readTaskAlbum("task-a", {}, deps([task("task-a", [transcript("t", [claudeSays(`Look at ${link}`, 1)])])]));
  expect(page.items).toEqual([]);
});

test("a .png link in an evidence root to a home file that is no image is left out", async () => {
  const notes = path.join(home, ".env");
  fs.writeFileSync(notes, "private home notes\n");
  const link = path.join(evidence, "leak.png");
  fs.symlinkSync(notes, link);
  const page = await readTaskAlbum("task-a", {}, deps([task("task-a", [transcript("t", [claudeSays(`Look at ${link}`, 1)])])]));
  expect(page.items).toEqual([]);
});

test("pasted bytes and a Read whose file is gone are served from the transcript", async () => {
  const gone = path.join(evidence, "deleted.png");
  const lines = [
    JSON.stringify({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "here" }, { type: "image", source: { type: "base64", media_type: "image/png", data: OTHER_PNG } }] } }),
    ...claudeRead("toolu_9", gone, 2),
  ];
  const world = deps([task("task-a", [transcript("t", lines)])]);
  const page = await readTaskAlbum("task-a", {}, world);
  expect(page.items.map((item) => [item.via, item.name])).toEqual([["read", "deleted.png"], ["pasted", null]]);
  for (const item of page.items) expect(item.src).toBe(`/api/tasks/task-a/album/image?id=${item.id}`);

  const pasted = await readTaskAlbumImage("task-a", page.items[1]!.id, world);
  expect(pasted?.media).toBe("image/png");
  expect(pasted?.data.equals(Buffer.from(OTHER_PNG, "base64"))).toBe(true);
  const read = await readTaskAlbumImage("task-a", page.items[0]!.id, world);
  expect(read?.data.equals(Buffer.from(PNG, "base64"))).toBe(true);
  /* Another task cannot reach a picture by an id its own album never gave. */
  expect(await readTaskAlbumImage("task-b", page.items[1]!.id, deps([task("task-b", [])]))).toBeNull();
});

test("Codex records: a viewed image, a data-URL part and a path in a tool call", async () => {
  const viewed = png(evidence, "viewed.png");
  const shot = png(evidence, "shot.png");
  const lines = [
    JSON.stringify({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "view_image", arguments: JSON.stringify({ path: viewed }), call_id: "c1" } }),
    JSON.stringify({ timestamp: at(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${OTHER_PNG}` }] } }),
    JSON.stringify({ timestamp: at(3), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `chrome --headless --screenshot=${shot} http://127.0.0.1:1/` }), call_id: "c2" } }),
  ];
  const page = await readTaskAlbum("task-a", {}, deps([task("task-a", [transcript("codex", lines)])]));
  expect(page.items.map((item) => [item.via, item.name])).toEqual([["named", "shot.png"], ["pasted", null], ["read", "viewed.png"]]);
});

test("reading again indexes only what was appended, and a byte budget finishes over several reads", async () => {
  const first = png(evidence, "one.png");
  const second = png(evidence, "two.png");
  const file = transcript("t", [claudeSays(`first ${first}`, 1), claudeSays("x".repeat(4096), 2)]);
  const world = deps([task("task-a", [file])]);

  const partial = await readTaskAlbum("task-a", { budget: 100 }, world);
  expect(partial.indexing).toBe(true);
  const done = await readTaskAlbum("task-a", {}, world);
  expect(done.indexing).toBe(false);
  expect(done.items.map((item) => item.name)).toEqual(["one.png"]);

  /* The earlier lines are not read again: rewriting them in place (same
     length, same inode) is invisible, while the appended line is indexed. */
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original.replace(`first ${first}`, `first ${first.replace(/one\.png$/, "xxx.png")}`) + claudeSays(`then ${second}`, 3) + "\n");
  const appended = await readTaskAlbum("task-a", {}, world);
  expect(appended.items.map((item) => item.name)).toEqual(["two.png", "one.png"]);
});

test("pages newest first and continues from the cursor", async () => {
  const lines = Array.from({ length: 5 }, (_, i) => claudeSays(`render ${png(evidence, `r${i}.png`)}`, i + 1));
  const world = deps([task("task-a", [transcript("t", lines)])]);
  const first = await readTaskAlbum("task-a", { limit: 2 }, world);
  expect(first.items.map((item) => item.name)).toEqual(["r4.png", "r3.png"]);
  expect(first.total).toBe(5);
  const second = await readTaskAlbum("task-a", { limit: 2, cursor: first.nextCursor }, world);
  expect(second.items.map((item) => item.name)).toEqual(["r2.png", "r1.png"]);
  const last = await readTaskAlbum("task-a", { limit: 2, cursor: second.nextCursor }, world);
  expect(last.items.map((item) => item.name)).toEqual(["r0.png"]);
  expect(last.nextCursor).toBeNull();
});

test("the new marker clears after the album is opened and returns for a newer picture", async () => {
  const file = transcript("t", [claudeSays(`render ${png(evidence, "a.png")}`, 1)]);
  const world = deps([task("task-a", [file])]);

  expect((await taskAlbumSummaries(["task-a"], world))["task-a"]).toEqual({ count: 1, newCount: 1, newestAt: Date.parse(at(1)) });
  expect((await readTaskAlbum("task-a", {}, world)).items[0]!.isNew).toBe(true);

  world.seen.markOpened("task-a", Date.parse(at(30)));
  expect((await taskAlbumSummaries(["task-a"], world))["task-a"]).toEqual({ count: 1, newCount: 0, newestAt: Date.parse(at(1)) });
  const opened = await readTaskAlbum("task-a", {}, world);
  expect(opened.newCount).toBe(0);
  expect(opened.items[0]!.isNew).toBe(false);

  fs.appendFileSync(file, claudeSays(`again ${png(evidence, "b.png")}`, 45) + "\n");
  expect((await taskAlbumSummaries(["task-a"], world))["task-a"]).toMatchObject({ count: 2, newCount: 1 });
  /* A late write from an older tab never moves the mark back. */
  expect(world.seen.markOpened("task-a", Date.parse(at(10)))).toBe(Date.parse(at(30)));
});

test("a picture indexed after the album was opened, older than the open, is still new on the next open", async () => {
  /* Two conversations; the budget of the first read covers only the first. */
  const early = transcript("early", [claudeSays(`render ${png(evidence, "early.png")}`, 20), claudeSays("x".repeat(4096), 21)]);
  const late = transcript("late", [claudeSays("y".repeat(4096), 22), claudeSays(`render ${png(evidence, "late.png")}`, 25)]);
  const world = deps([task("task-a", [early, late])]);
  world.seen.markOpened("task-a", Date.parse(at(10)));

  const opening = await readTaskAlbum("task-a", { budget: 4096 + 512 }, world);
  expect(opening.indexing).toBe(true);
  expect(opening.items.map((item) => item.name)).toEqual(["early.png"]);
  /* The album is opened at minute 40 and marks what it showed. */
  markTaskAlbumSeen("task-a", opening.items[0]!.ts, world, Date.parse(at(40)));

  const next = await readTaskAlbum("task-a", {}, world);
  expect(next.indexing).toBe(false);
  expect(next.items.map((item) => [item.name, item.isNew])).toEqual([["late.png", true], ["early.png", false]]);
  expect(next.newCount).toBe(1);

  /* An open album keeps judging against the mark it opened with. */
  const stillOpen = await readTaskAlbum("task-a", { since: Date.parse(at(10)) }, world);
  expect(stillOpen.items.map((item) => item.isNew)).toEqual([true, true]);
});

test("the seen mark is clamped to now, and a missing one falls back to it", () => {
  const world = deps([task("task-a", [])]);
  const now = Date.parse(at(30));
  expect(markTaskAlbumSeen("task-a", Date.parse(at(50)), world, now)).toBe(now);
  expect(markTaskAlbumSeen("task-b", "soon", world, now)).toBe(now);
  expect(markTaskAlbumSeen("task-c", undefined, world, now)).toBe(now);
});

test("two index passes at once over a Read split across a chunk index its picture once", async () => {
  const shot = png(evidence, "shot.png");
  const [use, result] = claudeRead("toolu_split", shot, 2);
  /* The padding puts the end of the Read's tool_use a few bytes before the
     1 MiB chunk boundary, so its tool_result is paired in the next chunk. */
  const chunk = 1024 * 1024;
  const padding = claudeSays("x".repeat(chunk - use!.length - 16 - claudeSays("", 1).length), 1);
  expect(padding.length + 1 + use!.length + 1).toBeLessThan(chunk);
  expect(padding.length + 1 + use!.length + 1).toBeGreaterThan(chunk - 32);
  const file = transcript("split", [padding, use!, result!]);

  const sequential = await indexTranscripts([file], 64 * chunk);
  expect(sequential.complete).toBe(true);
  const once = transcriptImages(file).map((image) => image.key);
  expect(once).toEqual([`f:${shot}`]);

  resetTranscriptIndex();
  const both = await Promise.all([indexTranscripts([file], 64 * chunk), indexTranscripts([file], 64 * chunk)]);
  expect(both.every((pass) => pass.complete)).toBe(true);
  expect(transcriptImages(file).map((image) => image.key)).toEqual(once);
});

test("an inline picture request reads no transcript bytes the album has not indexed", async () => {
  const lines = [JSON.stringify({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: OTHER_PNG } }] } })];
  const world = deps([task("task-a", [transcript("t", lines)])]);
  const id = (await readTaskAlbum("task-a", {}, world)).items[0]!.id;

  resetTranscriptIndex();
  expect(await readTaskAlbumImage("task-a", id, world)).toBeNull();
  const untouched = await readTaskAlbum("task-a", { budget: 0 }, world);
  expect(untouched.indexing).toBe(true);
  expect(untouched.items).toEqual([]);

  expect((await readTaskAlbum("task-a", {}, world)).items.map((item) => item.id)).toEqual([id]);
  expect((await readTaskAlbumImage("task-a", id, world))?.data.equals(Buffer.from(OTHER_PNG, "base64"))).toBe(true);
});
