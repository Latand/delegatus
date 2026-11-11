import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { keptReportPicture, reportMediaRoot, reportMediaRows } from "./lookup";
import { recordTexts } from "./paths";
import { keepReportPictures, reportMediaLimits, reportPicturePaths, type ReportMediaLimits } from "./store";

const { GET: image } = await import("@/app/api/image/route");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const DAY = 86_400_000;
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-media-")));
const saved = { home: process.env.HOME, state: process.env.LLV_STATE_DIR, roots: process.env.LLV_EVIDENCE_ROOTS };
let checkout = "";
let elsewhere = "";

/** A lane checkout the path routes serve, and a state directory beside it. */
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(sandbox, "case-"));
  checkout = path.join(root, "lanes", "repo-pipeline-ab12cd34");
  elsewhere = path.join(root, "elsewhere");
  const state = path.join(root, "state");
  for (const dir of [checkout, elsewhere, state]) fs.mkdirSync(dir, { recursive: true });
  process.env.HOME = path.join(root, "home");
  process.env.LLV_STATE_DIR = state;
  process.env.LLV_EVIDENCE_ROOTS = path.join(state, "evidence");
  known([checkout]);
});
afterEach(() => {
  for (const [name, value] of [["HOME", saved.home], ["LLV_STATE_DIR", saved.state], ["LLV_EVIDENCE_ROOTS", saved.roots]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function known(roots: string[]): void {
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-catalog.json"),
    JSON.stringify({ files: Object.fromEntries(roots.map((root, at) => [`fixture-${at}`, { cwd: root, projectRoot: root }])) }));
}

function picture(name: string, bytes: Buffer = PNG, dir: string = checkout): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

/** The lane ends: its checkout is removed and is no longer a known project. */
function retire(): void {
  fs.rmSync(checkout, { recursive: true, force: true });
  known([]);
}

async function served(file: string): Promise<{ status: number; bytes: Buffer }> {
  const response = await image(new NextRequest(`http://127.0.0.1:8898/api/image?path=${encodeURIComponent(file)}`, { headers: { host: "127.0.0.1" } }));
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

const limits = (over: Partial<ReportMediaLimits> = {}): ReportMediaLimits => ({ ...reportMediaLimits({}), ...over });
const storedFiles = () => fs.readdirSync(reportMediaRoot()).filter((name) => /^[a-f0-9]{64}\./.test(name));

test("a picture a report names still loads by its checkout path after the checkout is removed", async () => {
  const shot = picture(".artifacts/hint/390-uk.png");
  const unnamed = picture(".artifacts/hint/unnamed.png", OTHER_PNG);
  await keepReportPictures([`Verified on a phone. Screenshot: ${shot}\n\n![again](${shot})`]);
  retire();
  const kept = await served(shot);
  expect(kept.status).toBe(200);
  expect(kept.bytes.equals(PNG)).toBeTrue();
  /* A picture no report named was never copied. */
  expect((await served(unnamed)).status).not.toBe(200);
  expect(storedFiles()).toHaveLength(1);
});

test("without a report naming it, the picture is gone with the checkout", async () => {
  const shot = picture(".artifacts/hint/390-uk.png");
  retire();
  expect((await served(shot)).status).not.toBe(200);
});

test("paths are read bare, as link targets, as file URLs and from the home shorthand, and relative tails are left alone", () => {
  const home = process.env.HOME!;
  expect(reportPicturePaths([
    "see /a/one.png, (/a/two.JPG) and `file:///a/three.webp`.",
    "![x](~/shots/four.png) relative .artifacts/five.png and docs/six.png stay",
    ...recordTexts({ summary: "\"/a/one.png\"", verdict: { status: "pass", findings: [{ text: "line\n/a/seven.gif" }] }, n: 3 }),
    null, undefined, "/a/notes.txt /a/clip.mp4",
  ])).toEqual(["/a/one.png", "/a/two.JPG", "/a/three.webp", path.join(home, "shots/four.png"), "/a/seven.gif"]);
});

test("a picture in a temp directory that a report names is kept after the directory is swept, and is shown while it is still there", async () => {
  /* `elsewhere` stands for the OS temp directory: readable by the service,
     and no root the path routes serve. */
  const shot = picture("claude-run/images/3.png", PNG, elsewhere);
  expect((await served(shot)).status).toBe(403);
  expect(await keepReportPictures([`Operator screenshot: ${shot}`])).toEqual([shot]);
  expect((await served(shot)).bytes.equals(PNG)).toBeTrue();
  fs.rmSync(elsewhere, { recursive: true, force: true });
  const kept = await served(shot);
  expect(kept.status).toBe(200);
  expect(kept.bytes.equals(PNG)).toBeTrue();
});

test("a non-picture under a picture's name, an oversized picture and a file of another store are not copied", async () => {
  const renamed = picture("notes.png", Buffer.from("plain text\n"));
  const large = picture("large.png", Buffer.concat([PNG, Buffer.alloc(4096)]));
  const fenced = picture("round/frame.png", PNG, path.join(process.env.LLV_STATE_DIR!, "prototype-reviews"));
  const linked = path.join(checkout, "linked.png");
  fs.symlinkSync(fenced, linked);
  expect(await keepReportPictures([`${renamed} ${large} ${fenced} ${linked} ${path.join(checkout, "absent.png")}`], { limits: limits({ fileBytes: 1024 }) })).toEqual([]);
  expect(fs.existsSync(reportMediaRoot()) ? storedFiles() : []).toEqual([]);
  expect(keptReportPicture(fenced)).toBeNull();
});

test("the store never exceeds its total size: the longest-unnamed pictures leave first", async () => {
  const sizes = [0, 1, 2, 3].map((n) => Buffer.concat([PNG, Buffer.alloc(1000, n + 1)]));
  const shots = sizes.map((bytes, n) => picture(`shot-${n}.png`, bytes));
  const cap = limits({ totalBytes: sizes[0]!.length * 2 + 10 });
  for (const [n, shot] of shots.entries()) await keepReportPictures([shot], { now: 1000 + n, limits: cap });
  expect(storedFiles()).toHaveLength(2);
  expect(storedFiles().reduce((sum, name) => sum + fs.statSync(path.join(reportMediaRoot(), name)).size, 0)).toBeLessThanOrEqual(cap.totalBytes);
  retire();
  expect((await Promise.all(shots.map(served))).map((answer) => answer.status === 200)).toEqual([false, false, true, true]);
});

test("a copy that belongs to no lane expires after the retention, counted from when its picture was last at its own path", async () => {
  const gone = picture("gone.png");
  const staying = picture("staying.png", OTHER_PNG);
  const start = 1_000_000;
  await keepReportPictures([`${gone} ${staying}`], { now: start });
  fs.rmSync(gone);
  const later = picture("later.png", Buffer.concat([PNG, Buffer.alloc(8, 7)]));
  await keepReportPictures([later], { now: start + 6 * DAY });
  expect(keptReportPicture(gone)).not.toBeNull();
  await keepReportPictures([later], { now: start + 8 * DAY });
  expect(keptReportPicture(gone)).toBeNull();
  /* Its picture still lies in the checkout, so its clock has not started. */
  expect(keptReportPicture(staying)).not.toBeNull();
  fs.rmSync(staying);
  await keepReportPictures([later], { now: start + 14 * DAY });
  expect(keptReportPicture(staying)).not.toBeNull();
  await keepReportPictures([later], { now: start + 16 * DAY });
  expect(keptReportPicture(staying)).toBeNull();
  expect(storedFiles()).toHaveLength(1);
});

test("a lane's pictures stay while the lane runs and leave the retention after it finished", async () => {
  const shot = picture(".artifacts/lane.png");
  const start = 1_000_000;
  let finishedAt: number | null = null;
  const laneFinishedAt = (lane: string) => lane === "ab12cd34" ? finishedAt : undefined;
  await keepReportPictures([shot], { lane: "ab12cd34", now: start, laneFinishedAt });
  retire();
  /* Weeks into a running lane, a later write applies the limits. */
  await keepReportPictures([picture("x.png", OTHER_PNG, elsewhere)], { now: start + 30 * DAY, laneFinishedAt });
  expect(keptReportPicture(shot)).not.toBeNull();
  finishedAt = start + 31 * DAY;
  await keepReportPictures([picture("y.png", OTHER_PNG, elsewhere)], { now: start + 37 * DAY, laneFinishedAt });
  expect(keptReportPicture(shot)).not.toBeNull();
  await keepReportPictures([picture("z.png", OTHER_PNG, elsewhere)], { now: start + 39 * DAY, laneFinishedAt });
  expect(keptReportPicture(shot)).toBeNull();
});

test("two paths with the same bytes share one copy, and a picture written again under its path is replaced", async () => {
  const first = picture("a.png");
  const second = picture("b.png");
  await keepReportPictures([`${first} ${second}`], { now: 1 });
  expect(storedFiles()).toHaveLength(1);
  fs.writeFileSync(first, OTHER_PNG);
  await keepReportPictures([first], { now: 2 });
  expect(reportMediaRows().map((row) => row.path).sort()).toEqual([first, second]);
  retire();
  expect((await served(first)).bytes.equals(OTHER_PNG)).toBeTrue();
  expect((await served(second)).bytes.equals(PNG)).toBeTrue();
});

test("the limits read their variables and fall back on a value that is no positive number", () => {
  expect(reportMediaLimits({})).toEqual({ totalBytes: 1024 ** 3, fileBytes: 16 * 1024 ** 2, retentionMs: 7 * DAY });
  expect(reportMediaLimits({ LLV_REPORT_MEDIA_MAX_BYTES: "5000", LLV_REPORT_MEDIA_MAX_FILE_BYTES: "100", LLV_REPORT_MEDIA_RETENTION_DAYS: "0.5" }))
    .toEqual({ totalBytes: 5000, fileBytes: 100, retentionMs: DAY / 2 });
  expect(reportMediaLimits({ LLV_REPORT_MEDIA_MAX_BYTES: "none", LLV_REPORT_MEDIA_RETENTION_DAYS: "-1" }).totalBytes).toBe(1024 ** 3);
});
