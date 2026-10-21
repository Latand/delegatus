import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { resolveComposerUpload } from "@/lib/composerUploads";

let directory: string;
let previous: { state?: string; token?: string };
beforeEach(async () => {
  previous = { state: process.env.LLV_STATE_DIR, token: process.env.LLV_TOKEN };
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "composer-upload-route-"));
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_TOKEN;
});
afterEach(async () => {
  for (const [key, value] of [["LLV_STATE_DIR", previous.state], ["LLV_TOKEN", previous.token]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  await fs.rm(directory, { recursive: true, force: true });
});
function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1/api/composer-upload", {
    method: "POST", headers: { host: "127.0.0.1", ...headers }, body: "synthetic recording",
  });
}

test("the raw upload route admits a body and returns an owner-bound completed reference", async () => {
  const answer = await POST(request());
  expect(answer.status).toBe(200);
  const { upload } = await answer.json();
  const stored = await resolveComposerUpload(upload, "operator");
  expect(await fs.readFile(stored.path, "utf8")).toBe("synthetic recording");
});

const foreignUploadHeaders: Record<string, string>[] = [
  { host: "foreign.example" },
  { origin: "https://foreign.example" },
  { "sec-fetch-site": "cross-site" },
];
test.each(foreignUploadHeaders)("foreign upload requests refuse before their body is read: %j", async headers => {
  const incoming = request(headers);
  expect((await POST(incoming)).status).toBe(403);
  expect(incoming.bodyUsed).toBe(false);
});

test("excluding the automatic body clone retains the real access-key perimeter", async () => {
  process.env.LLV_TOKEN = "test";
  const incoming = request();
  expect((await POST(incoming)).status).toBe(403);
  expect(incoming.bodyUsed).toBe(false);
  expect((await POST(request({ authorization: "Bearer test" }))).status).toBe(200);
});

test("declared oversize returns 413 with the shared 100 MB limit", async () => {
  const answer = await POST(request({ "content-length": String(100 * 1024 * 1024 + 1) }));
  expect(answer.status).toBe(413);
  expect((await answer.json()).error).toContain("100 MB limit");
});
