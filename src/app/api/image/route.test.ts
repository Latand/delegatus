import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const { GET: serve } = await import("./route");
const responses: Response[] = [];
async function GET(...args: Parameters<typeof serve>) {
  const response = await serve(...args); responses.push(response); return response;
}

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-image-route-"));
const savedState = process.env.LLV_STATE_DIR;
const saved = { home: process.env.HOME, roots: process.env.LLV_EVIDENCE_ROOTS };
let home = "";
let evidence = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(sandbox, "home-"));
  evidence = fs.mkdtempSync(path.join(sandbox, "evidence-"));
  process.env.HOME = path.dirname(home);
  process.env.LLV_STATE_DIR = path.join(home, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), JSON.stringify({ files: { fixture: { cwd: home, projectRoot: home } } }));
  process.env.LLV_EVIDENCE_ROOTS = evidence;
});
afterEach(async () => {
  for (const response of responses.splice(0)) if (response.body && !response.body.locked) await response.body.cancel();
  if (savedState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = savedState;
  process.env.HOME = saved.home;
  if (saved.roots === undefined) delete process.env.LLV_EVIDENCE_ROOTS;
  else process.env.LLV_EVIDENCE_ROOTS = saved.roots;
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const request = (p: string) => new NextRequest(`http://127.0.0.1:8898/api/image?path=${encodeURIComponent(p)}`, { headers: { host: "127.0.0.1" } });

test("an inline markdown picture under an evidence root is served, as one under home is", async () => {
  for (const dir of [home, evidence]) {
    const file = path.join(dir, "render.png");
    fs.writeFileSync(file, PNG_BYTES);
    const res = await GET(request(file));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  }
});

test("a picture outside the roots, or a link out of one, is refused", async () => {
  const outside = path.join(fs.mkdtempSync(path.join(sandbox, "elsewhere-")), "secret.png");
  fs.writeFileSync(outside, PNG_BYTES);
  const link = path.join(evidence, "link.png");
  fs.symlinkSync(outside, link);
  expect((await GET(request(outside))).status).toBe(403);
  expect((await GET(request(link))).status).toBe(403);
});

test("a .png link in an evidence root to a home file that is no image is refused", async () => {
  const notes = path.join(home, ".env");
  fs.writeFileSync(notes, "private home notes\n");
  const link = path.join(evidence, "leak.png");
  fs.symlinkSync(notes, link);
  const res = await GET(request(link));
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain("private home notes");
});

test("a file whose bytes are no image is refused whatever its extension says", async () => {
  const renamed = path.join(home, "notes.png");
  fs.writeFileSync(renamed, "plain text\n");
  expect((await GET(request(renamed))).status).toBe(415);
});

/** A lane checkout with one ignored report picture, backed up as retirement
    does and then removed. Returns the path the picture had in the checkout. */
async function retiredLanePicture(lane: string, relative: string, bytes: Buffer): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { backupWorktree } = await import("@/lib/pipelines/worktreeBackup");
  const state = fs.realpathSync(fs.mkdtempSync(path.join(sandbox, "state-")));
  process.env.LLV_STATE_DIR = state;
  process.env.LLV_EVIDENCE_ROOTS = path.join(state, "evidence");
  const directory = path.join(fs.realpathSync(fs.mkdtempSync(path.join(sandbox, "lanes-"))), `repo-pipeline-${lane}`);
  fs.mkdirSync(directory);
  const catalog = (roots: string[]) => fs.writeFileSync(path.join(state, "project-catalog.json"),
    JSON.stringify({ files: Object.fromEntries(roots.map((root, at) => [`fixture-${at}`, { cwd: root, projectRoot: root }])) }));
  catalog([directory]);
  const address = ["noreply", "example.invalid"].join("@");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_EMAIL: address } }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(directory, ".gitignore"), "/.artifacts/\n");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const picture = path.join(directory, relative);
  fs.mkdirSync(path.dirname(picture), { recursive: true });
  fs.writeFileSync(picture, bytes);
  expect((await GET(request(picture))).status).toBe(200);
  const backup = await backupWorktree({ directory, pipelineId: lane, head: git("rev-parse", "HEAD"), branch: "main",
    ignored: [".artifacts/"], disposable: () => false, guard: () => true });
  backup.close();
  fs.rmSync(directory, { recursive: true, force: true });
  catalog([]);
  return picture;
}

test("a report picture still loads by its checkout path after the lane checkout is retired", async () => {
  const picture = await retiredLanePicture("ab12cd34", ".artifacts/hint/390-uk.png", PNG_BYTES);
  expect(fs.existsSync(picture)).toBeFalse();
  const res = await GET(request(picture));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBeTrue();
});

test("a picture the retired lane never saved answers as missing, and so does another lane's name for a saved one", async () => {
  const picture = await retiredLanePicture("ab12cd35", ".artifacts/hint/390-uk.png", PNG_BYTES);
  for (const absent of [path.join(path.dirname(picture), "never-saved.png"), picture.replace("ab12cd35", "ab12cd36")]) {
    const res = await GET(request(absent));
    expect([403, 404]).toContain(res.status);
  }
});

test("a file in a retired lane's store that is no picture is never handed out through the checkout path", async () => {
  const picture = await retiredLanePicture("ab12cd37", ".artifacts/hint/390-uk.png", PNG_BYTES);
  const store = path.join(process.env.LLV_STATE_DIR!, "evidence", "ab12cd37");
  fs.writeFileSync(path.join(store, "worktree", ".artifacts", "notes.txt"), "lane notes\n");
  const outside = path.join(store, "outside.png");
  fs.writeFileSync(outside, PNG_BYTES);
  const checkout = picture.slice(0, picture.indexOf(`${path.sep}.artifacts`));
  expect((await GET(request(path.join(checkout, ".artifacts", "notes.txt")))).status).not.toBe(200);
  // A manifest entry that points out of the lane's saved tree is ignored.
  const manifest = path.join(store, "worktree-backup.json");
  const listed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  listed.files.push({ path: "escape.png", savedPath: "../outside.png", bytes: PNG_BYTES.length, hash: "" });
  fs.writeFileSync(manifest, JSON.stringify(listed));
  expect((await GET(request(path.join(checkout, "escape.png")))).status).not.toBe(200);
});
