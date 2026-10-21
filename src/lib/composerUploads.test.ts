import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { receiveComposerUpload, resolveComposerUpload, composerUploadsDir } from "./composerUploads";
import { inboxFilesDir, stageInboxFilesAsync, InboxFileConflictError } from "./inboxFiles";

const MiB = 1024 * 1024;
let directory: string;
let previous: Record<string, string | undefined>;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "composer-upload-"));
  previous = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR"].map(key => [key, process.env[key]]));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  process.env.HOME = path.join(directory, "home");
  process.env.XDG_CONFIG_HOME = path.join(directory, "config");
});
afterEach(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(directory, { recursive: true, force: true });
});

function bytes(size: number) {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(97);
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (sent === size) { controller.close(); return; }
    const next = chunk.subarray(0, Math.min(size - sent, chunk.length));
    sent += next.length;
    controller.enqueue(next);
  } });
}

test("100 MiB is staged whole outside the inbox and resolves without reading it into memory", async () => {
  const ref = await receiveComposerUpload(bytes(100 * MiB), "operator", { expectedBytes: 100 * MiB });
  expect(ref.bytes).toBe(100 * MiB);
  const stored = await resolveComposerUpload(ref, "operator");
  expect((await fs.stat(stored.path)).size).toBe(100 * MiB);
  expect((await fs.readdir(path.dirname(stored.path))).sort()).toEqual(["body", "manifest.json"]);
  expect(await fs.stat(inboxFilesDir()).catch(() => null)).toBeNull();
});

test("a lying or absent Content-Length cannot admit 100 MiB plus one byte", async () => {
  await expect(receiveComposerUpload(bytes(100 * MiB + 1), "operator", { expectedBytes: 100 * MiB }))
    .rejects.toThrow("100 MB limit");
  expect(await fs.readdir(composerUploadsDir())).toEqual([]);
});

test("an interrupted stream removes its private partial and never publishes an inbox file", async () => {
  let fail!: (reason: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(1024));
    fail = reason => controller.error(reason);
    started();
  } });
  const upload = receiveComposerUpload(stream, "operator");
  await ready;
  fail(new Error("connection interrupted"));
  await expect(upload).rejects.toThrow("connection interrupted");
  expect(await fs.readdir(composerUploadsDir())).toEqual([]);
  expect(await fs.stat(inboxFilesDir()).catch(() => null)).toBeNull();
});

test("a revoked caller cannot finish an upload after the body read awaited", async () => {
  let release!: () => void;
  let reading!: () => void;
  const ready = new Promise<void>(resolve => { reading = resolve; });
  let allowed = true;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    reading();
    return new Promise<void>(resolve => {
      release = () => { allowed = false; controller.enqueue(new Uint8Array([1])); controller.close(); resolve(); };
    });
  } }, { highWaterMark: 0 });
  const upload = receiveComposerUpload(stream, "member:one", { authorize() { if (!allowed) throw new Error("membership revoked"); } });
  await ready;
  release();
  await expect(upload).rejects.toThrow("membership revoked");
  expect(await fs.readdir(composerUploadsDir())).toEqual([]);
});

test("references bind owner and exact size; forged paths and changed metadata refuse", async () => {
  const ref = await receiveComposerUpload(bytes(128), "member:one");
  await expect(resolveComposerUpload(ref, "member:two")).rejects.toThrow();
  await expect(resolveComposerUpload({ ...ref, id: "../body" }, "member:one")).rejects.toThrow();
  await expect(resolveComposerUpload({ ...ref, bytes: 129 }, "member:one")).rejects.toThrow();
  await expect(resolveComposerUpload({ ...ref, sha256: "0".repeat(64) }, "member:one")).rejects.toThrow();
});

test("empty and truncated bodies refuse and leave no partial file", async () => {
  await expect(receiveComposerUpload(bytes(0), "operator")).rejects.toThrow();
  await expect(receiveComposerUpload(bytes(127), "operator", { expectedBytes: 128 })).rejects.toThrow();
  expect(await fs.readdir(composerUploadsDir())).toEqual([]);
});

test("inbox edits cannot change a retained upload, and changed bytes cannot be replayed", async () => {
  const ref = await receiveComposerUpload(bytes(128), "operator");
  const stored = await resolveComposerUpload(ref, "operator");
  const files = [{ name: "recording.ogg", data: Buffer.alloc(0), stored }];
  const first = await stageInboxFilesAsync(files, "first-copy");
  await fs.writeFile(first.filePaths[0]!, new Uint8Array(128).fill(98));
  expect(await fs.readFile(stored.path)).toEqual(Buffer.alloc(128, 97));
  const second = await stageInboxFilesAsync(files, "second-copy");
  expect(await fs.readFile(second.filePaths[0]!)).toEqual(Buffer.alloc(128, 97));
  await expect(stageInboxFilesAsync(files, "first-copy")).rejects.toBeInstanceOf(InboxFileConflictError);
  await fs.writeFile(stored.path, new Uint8Array(128).fill(99));
  await expect(stageInboxFilesAsync(files, "changed-source")).rejects.toThrow("changed before staging");
  expect(await fs.readdir(path.join(inboxFilesDir(), "changed-source"))).toEqual([]);
});

test("aborting a pending body read ends the upload and removes its partial", async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const pending = receiveComposerUpload(new ReadableStream<Uint8Array>(), "operator", {
    signal: controller.signal, authorize: ready,
  });
  await reading;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(await fs.readdir(composerUploadsDir())).toEqual([]);
});

test("completed references and the staging capacity survive a real process restart", async () => {
  const ref = await receiveComposerUpload(bytes(128), "operator");
  const fixture = path.join(import.meta.dir, "composerUploads.fixture.ts");
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, fixture, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    try {
      const result = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      return JSON.parse(result);
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
  }
  expect(await run("resolve", JSON.stringify(ref))).toEqual({ bytes: 128 });
  const root = composerUploadsDir();
  for (let index = 0; (await fs.readdir(root)).length < 128; index++) {
    await fs.mkdir(path.join(root, index.toString(16).padStart(32, "0")));
  }
  expect(await run("receive")).toEqual({ status: 503 });
});
