import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { keptPictureProject, readablePlace } from "@/lib/artifact/localFile";

import { keptReportPicture, reportMediaRoot, reportMediaRows } from "./lookup";
import { recordTexts, writtenPicturePaths } from "./paths";
import { keepReportPictures, reportMediaLimits, reportMediaTempRoots, reportPicturePaths, type ReportMediaLimits } from "./store";

const { GET: image } = await import("@/app/api/image/route");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const DAY = 86_400_000;
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-media-")));
const saved = { home: process.env.HOME, state: process.env.LLV_STATE_DIR, roots: process.env.LLV_EVIDENCE_ROOTS, temp: process.env.LLV_REPORT_MEDIA_TEMP_ROOTS };
let checkout = "";
let elsewhere = "";
let temp = "";

/** A lane checkout the path routes serve, and a state directory beside it. */
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(sandbox, "case-"));
  checkout = path.join(root, "lanes", "repo-pipeline-ab12cd34");
  elsewhere = path.join(root, "elsewhere");
  temp = path.join(root, "tmp");
  const state = path.join(root, "state");
  for (const dir of [checkout, elsewhere, temp, state]) fs.mkdirSync(dir, { recursive: true });
  /* The suite's own directories lie in the OS temp directory; the store is
     told which one stands for it. */
  process.env.LLV_REPORT_MEDIA_TEMP_ROOTS = temp;
  process.env.HOME = path.join(root, "home");
  process.env.LLV_STATE_DIR = state;
  process.env.LLV_EVIDENCE_ROOTS = path.join(state, "evidence");
  known([checkout]);
});
afterEach(() => {
  for (const [name, value] of [["HOME", saved.home], ["LLV_STATE_DIR", saved.state], ["LLV_EVIDENCE_ROOTS", saved.roots], ["LLV_REPORT_MEDIA_TEMP_ROOTS", saved.temp]] as const) {
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
    "Screenshot:/a/colon.png",
    "web https://host.example/a/eight.png and //host.example/nine.png are no local paths; /a/ten.png.bak is no picture; /a/eleven.png.",
  ])).toEqual(["/a/one.png", "/a/two.JPG", "/a/three.webp", path.join(home, "shots/four.png"), "/a/seven.gif", "/a/colon.png", "/a/eleven.png"]);
});

test("a picture in a named temp root that a report names is kept after the directory is swept", async () => {
  const shot = picture("claude-run/images/3.png", PNG, temp);
  expect((await served(shot)).status).toBe(403);
  expect(await keepReportPictures([`Operator screenshot: ${shot}`])).toEqual([shot]);
  expect((await served(shot)).bytes.equals(PNG)).toBeTrue();
  fs.rmSync(temp, { recursive: true, force: true });
  const kept = await served(shot);
  expect(kept.status).toBe(200);
  expect(kept.bytes.equals(PNG)).toBeTrue();
});

test("a picture the path routes refuse and no temp root holds is never copied or served, whatever names it", async () => {
  const personal = picture("pictures/private.png", PNG, elsewhere);
  const linked = path.join(temp, "linked.png");
  fs.symlinkSync(personal, linked);
  expect((await served(personal)).status).toBe(403);
  expect(await keepReportPictures([`${personal} ${linked} ![x](${personal})`], { lane: "ab12cd34", laneFinishedAt: () => null })).toEqual([]);
  expect(fs.existsSync(reportMediaRoot())).toBeFalse();
  expect((await served(personal)).status).toBe(403);
  expect((await served(linked)).status).toBe(403);
  /* A kept copy is not preferred to a served file, and stands in for nothing
     the store was not allowed to copy. */
  expect(readablePlace(personal)).toBe(personal);
});

test("a non-picture under a picture's name, an oversized picture and a file of another store are not copied", async () => {
  const renamed = picture("notes.png", Buffer.from("plain text\n"));
  const large = picture("large.png", Buffer.concat([PNG, Buffer.alloc(4096)]));
  const fenced = picture("round/frame.png", PNG, path.join(process.env.LLV_STATE_DIR!, "prototype-reviews"));
  process.env.LLV_REPORT_MEDIA_TEMP_ROOTS = `${temp}:${process.env.LLV_STATE_DIR!}`;
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

test("a copy that belongs to no lane stays the whole retention after its picture is found gone, however late that is", async () => {
  const early = picture("early.png");
  const late = picture("late.png", OTHER_PNG);
  const start = 1_000_000;
  const tick = (day: number) => keepReportPictures([picture(`tick-${day}.png`, Buffer.concat([PNG, Buffer.alloc(8, day)]), temp)], { now: start + day * DAY });
  await keepReportPictures([`${early} ${late}`], { now: start });
  fs.rmSync(early);
  /* Gone on the first day; the store looks once the retention has passed
     since the mention, and counts the retention from that look. */
  await tick(6);
  await tick(8);
  expect(keptReportPicture(early)).not.toBeNull();
  await tick(14);
  expect(keptReportPicture(early)).not.toBeNull();
  await tick(16);
  expect(keptReportPicture(early)).toBeNull();
  /* Removed on the thirteenth day, just before a look would have aged it out. */
  expect(keptReportPicture(late)).not.toBeNull();
  fs.rmSync(late);
  await tick(17);
  await tick(23);
  expect(keptReportPicture(late)).not.toBeNull();
  await tick(25);
  expect(keptReportPicture(late)).toBeNull();
});

test("a lane's pictures stay while the lane runs and leave the retention after it finished", async () => {
  const shot = picture(".artifacts/lane.png");
  const start = 1_000_000;
  let finishedAt: number | null = null;
  const laneFinishedAt = (lane: string) => lane === "ab12cd34" ? finishedAt : undefined;
  await keepReportPictures([shot], { lane: "ab12cd34", now: start, laneFinishedAt });
  retire();
  /* Weeks into a running lane, a later write applies the limits. */
  await keepReportPictures([picture("x.png", OTHER_PNG, temp)], { now: start + 30 * DAY, laneFinishedAt });
  expect(keptReportPicture(shot)).not.toBeNull();
  finishedAt = start + 31 * DAY;
  await keepReportPictures([picture("y.png", OTHER_PNG, temp)], { now: start + 37 * DAY, laneFinishedAt });
  expect(keptReportPicture(shot)).not.toBeNull();
  await keepReportPictures([picture("z.png", OTHER_PNG, temp)], { now: start + 39 * DAY, laneFinishedAt });
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

test("a picture already kept as it is costs no second copy, and a status-only write of its text no write at all", async () => {
  const shot = picture("same.png");
  await keepReportPictures([shot], { now: 1_000 });
  const index = path.join(reportMediaRoot(), "index.json");
  const copy = keptReportPicture(shot)!;
  const stamps = () => [fs.statSync(index).ino, fs.statSync(copy).ino];
  const before = stamps();
  expect(await keepReportPictures([shot], { now: 2_000 })).toEqual([shot]);
  expect(stamps()).toEqual(before);
  /* Named again much later: the mention is recorded, the bytes are not copied again. */
  expect(await keepReportPictures([shot], { now: 1_000 + 2 * 3_600_000 })).toEqual([shot]);
  expect(fs.statSync(copy).ino).toBe(before[1]!);
  expect(reportMediaRows().find((row) => row.path === shot)!.at).toBe(1_000 + 2 * 3_600_000);
});

test("many named paths that may not be copied do not use up the pictures one record may add", async () => {
  const refused = Array.from({ length: 80 }, (_, n) => path.join(elsewhere, `refused-${n}.png`));
  const shot = picture("after-many.png");
  expect(await keepReportPictures([`${refused.join(" ")} ${shot}`])).toEqual([shot]);
});

test("a long run of slashes and punctuation is read in bounded time", () => {
  const started = performance.now();
  expect(writtenPicturePaths(["+/".repeat(60_000)])).toEqual([]);
  expect(writtenPicturePaths([`${"/a".repeat(40_000)}.png`])).toEqual([]);
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("an index that cannot be read is set aside: the copies stay and the next write rebuilds it", async () => {
  const first = picture("first.png");
  await keepReportPictures([first], { now: 1_000 });
  const copy = keptReportPicture(first)!;
  fs.writeFileSync(path.join(reportMediaRoot(), "index.json"), "{ not an index");
  expect(keptReportPicture(first)).toBeNull();
  const second = picture("second.png", OTHER_PNG);
  expect(await keepReportPictures([second], { now: 2_000 })).toEqual([second]);
  expect(fs.existsSync(copy)).toBeTrue();
  expect(fs.existsSync(path.join(reportMediaRoot(), "index.unreadable"))).toBeTrue();
  /* Naming the first picture again finds its bytes already there. */
  expect(await keepReportPictures([first], { now: 3_000 })).toEqual([first]);
  expect(keptReportPicture(first)).toBe(copy);
});

test("a kept copy answers for the project its picture lay in", async () => {
  const shot = picture(".artifacts/member.png");
  await keepReportPictures([shot], { projectOf: (directory) => directory.startsWith(checkout) ? "project-a" : null });
  const loose = picture("loose.png", OTHER_PNG, temp);
  await keepReportPictures([loose], { projectOf: () => null });
  /* Read where it lies, its own directory says; the copy says what was recorded. */
  expect(keptPictureProject(shot, readablePlace(shot))).toBeUndefined();
  retire();
  expect(keptPictureProject(shot, readablePlace(shot))).toBe("project-a");
  expect(keptPictureProject(loose, readablePlace(loose))).toBeNull();
});

test("the temp roots are the service's temp directory and /tmp unless named, and never the filesystem root", () => {
  expect(reportMediaTempRoots({})).toContain("/tmp");
  expect(reportMediaTempRoots({ LLV_REPORT_MEDIA_TEMP_ROOTS: "/scratch/a: /scratch/b :relative:/" })).toEqual(["/scratch/a", "/scratch/b"]);
  expect(reportMediaTempRoots({ LLV_REPORT_MEDIA_TEMP_ROOTS: "" })).toEqual([]);
});

test("the store is read for rasters and is no evidence root agents are sent to", async () => {
  const { evidenceRoots, lexicalAllowedRoots } = await import("@/lib/artifact/localFile");
  process.env.LLV_EVIDENCE_ROOTS = "";
  expect(evidenceRoots()).toEqual([]);
  expect(lexicalAllowedRoots().evidence).toEqual([reportMediaRoot()]);
});
