import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BoardEncoder } from "@/lib/boardEncoding";
import { readSummaryBootstrap, writeSummaryBootstrap, SUMMARY_BOOTSTRAP_FILE } from "./summaryBootstrap";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "board-bootstrap-"));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function summary(title = "Saved board") {
  const body = JSON.stringify({ readProjection: "board-summary", files: [], tasks: [{ id: "task-a", text: title }],
    systemHealth: { storage: { writes: { state: "ok", since: null, freeBytes: 1024 ** 3 } } } });
  return { body, etag: `"${createHash("sha1").update(body).digest("hex")}"` };
}

test("a completed summary round trips as exact JSON and gzip bytes", async () => {
  const root = await directory();
  const saved = summary("A board with Українська text");
  await writeSummaryBootstrap(root, saved.body, saved.etag);
  const restored = await readSummaryBootstrap(root);
  expect(restored?.etag).toBe(saved.etag);
  expect(Buffer.from(restored!.body).toString()).toBe(saved.body);
  expect(gunzipSync(restored!.gzip).toString()).toBe(saved.body);
  await writeSummaryBootstrap(root, summary("New board").body, summary("New board").etag);
  expect(Buffer.from((await readSummaryBootstrap(root))!.body).toString()).toContain("New board");
  expect(await fs.readdir(root)).toEqual([SUMMARY_BOOTSTRAP_FILE]);
});

test("a scoped v2 summary round trips with a separate body integrity hash", async () => {
  const root = await directory();
  const context = { scope: "a".repeat(40), epoch: "saved-viewer" };
  const encoded = new BoardEncoder().encode(context.scope, context.epoch, JSON.parse(summary().body));
  expect(encoded.etag).not.toBe(`"${createHash("sha1").update(encoded.body).digest("hex")}"`);
  await writeSummaryBootstrap(root, encoded.body, encoded.etag, context);
  const restored = await readSummaryBootstrap(root);
  expect(restored?.etag).toBe(encoded.etag);
  expect(Buffer.from(restored!.body).toString()).toBe(encoded.body);
  expect(gunzipSync(restored!.gzip).toString()).toBe(encoded.body);

  const file = path.join(root, SUMMARY_BOOTSTRAP_FILE);
  const bytes = await fs.readFile(file);
  const length = bytes.readUInt32BE(0);
  const metadata = JSON.parse(bytes.subarray(4, 4 + length).toString());
  expect(metadata.bodyHash).toBe(createHash("sha1").update(encoded.body).digest("hex"));
  bytes[4 + length + 5] ^= 1;
  await fs.writeFile(file, bytes);
  expect(await readSummaryBootstrap(root)).toBeNull();
});

test("the reader still accepts the old manifest without a separate body hash", async () => {
  const root = await directory();
  const saved = summary();
  const body = Buffer.from(saved.body);
  const gzip = gzipSync(body);
  const metadata = Buffer.from(JSON.stringify({ version: 1, scope: "operator-global-summary", etag: saved.etag,
    bodyBytes: body.length, gzipBytes: gzip.length, gzipHash: createHash("sha256").update(gzip).digest("hex") }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  const file = path.join(root, SUMMARY_BOOTSTRAP_FILE);
  await fs.writeFile(file, Buffer.concat([prefix, metadata, body, gzip]));
  const restored = await readSummaryBootstrap(root);
  expect(restored?.etag).toBe(saved.etag);
  expect(Buffer.from(restored!.body).toString()).toBe(saved.body);
  expect(gunzipSync(restored!.gzip).toString()).toBe(saved.body);
  const corrupted = await fs.readFile(file);
  corrupted[4 + metadata.length + 5] ^= 1;
  await fs.writeFile(file, corrupted);
  expect(await readSummaryBootstrap(root)).toBeNull();
});

test("a scoped ETag must certify the exact scope, epoch and body", async () => {
  const root = await directory();
  const context = { scope: "b".repeat(40), epoch: "saved-viewer" };
  const encoded = new BoardEncoder().encode(context.scope, context.epoch, JSON.parse(summary().body));
  for (const candidate of [undefined, { ...context, scope: "c".repeat(40) }, { ...context, epoch: "other-viewer" }]) {
    await expect(writeSummaryBootstrap(root, encoded.body, encoded.etag, candidate)).rejects.toThrow();
    expect(await readSummaryBootstrap(root)).toBeNull();
  }
  await expect(writeSummaryBootstrap(root, encoded.body.replace("Saved board", "Other board"), encoded.etag, context)).rejects.toThrow();
  expect(await readSummaryBootstrap(root)).toBeNull();
});

test("missing, truncated, incompatible and corrupted artifacts explicitly fall back", async () => {
  const root = await directory();
  expect(await readSummaryBootstrap(root)).toBeNull();
  const saved = summary();
  await writeSummaryBootstrap(root, saved.body, saved.etag);
  const file = path.join(root, SUMMARY_BOOTSTRAP_FILE);
  const original = await fs.readFile(file);
  const metaSize = original.readUInt32BE(0);
  const corruptBody = Buffer.from(original);
  corruptBody[4 + metaSize + 5] ^= 1;
  const corruptGzip = Buffer.from(original);
  corruptGzip[corruptGzip.length - 1] ^= 1;
  const incompatible = Buffer.from(original);
  const metadata = incompatible.subarray(4, 4 + metaSize).toString().replace('"version":1', '"version":9');
  incompatible.write(metadata, 4);
  for (const bytes of [original.subarray(0, 2), original.subarray(0, original.length - 1), corruptBody, corruptGzip, incompatible]) {
    await fs.writeFile(file, bytes);
    expect(await readSummaryBootstrap(root)).toBeNull();
  }
});

test("the writer refuses unhealthy or non-summary bodies and mismatched ETags", async () => {
  const root = await directory();
  const saved = summary();
  for (const body of [saved.body.replace("board-summary", "full"), saved.body.replace('"ok"', '"disk-full"'), "invalid JSON"]) {
    await expect(writeSummaryBootstrap(root, body, saved.etag)).rejects.toThrow();
    expect(await readSummaryBootstrap(root)).toBeNull();
  }
  await expect(writeSummaryBootstrap(root, saved.body, '"' + "0".repeat(40) + '"')).rejects.toThrow();
});
