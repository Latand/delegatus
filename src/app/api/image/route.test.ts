import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const { GET } = await import("./route");

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-image-route-"));
const saved = { home: process.env.HOME, roots: process.env.LLV_EVIDENCE_ROOTS };
let home = "";
let evidence = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(sandbox, "home-"));
  evidence = fs.mkdtempSync(path.join(sandbox, "evidence-"));
  process.env.HOME = home;
  process.env.LLV_EVIDENCE_ROOTS = evidence;
});
afterEach(() => {
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
