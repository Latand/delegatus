import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { POST } from "./route";

let previous: string | undefined;
let root: string;
beforeEach(async () => {
  previous = process.env.LLV_STATE_DIR;
  root = await mkdtemp(join(tmpdir(), "metadata-route-"));
  process.env.LLV_STATE_DIR = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  await rm(root, { recursive: true, force: true });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/structured-user/provenance", {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("bounded provenance POST resolves the persisted sender", async () => {
  const wire = await encodeCodexStructuredUserText("fixture", undefined, null, { kind: "agent", role: "reviewer" });
  const ref = decodeCodexStructuredUserText(wire).metadataRef!;
  const response = await POST(request({ refs: [ref] }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ [ref]: { origin: "agent", senderRole: "reviewer" } });
});

test("hostile requests are rejected before their body is consumed", async () => {
  const cases: Record<string, string>[] = [{ origin: "https://foreign.invalid" }, { origin: "null" }, { host: "foreign.invalid" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of cases) {
    const req = request("invalid", headers);
    expect((await POST(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
  }
});

test("invalid, oversized, missing and excessive reference batches are bounded", async () => {
  const ref = decodeCodexStructuredUserText(await encodeCodexStructuredUserText("fixture")).metadataRef!;
  for (const body of ["{", null, [], {}, { refs: "x" }, { refs: ["../../fixture"] }, { refs: [null] }, { refs: Array(101).fill(ref) }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect((await POST(request({ refs: Array(100).fill(ref) }))).status).toBe(200);
  expect((await POST(request("x".repeat(16_385)))).status).toBe(400);
  const declared = request("{}", { "content-length": "16385" });
  expect((await POST(declared)).status).toBe(413);
  expect(declared.bodyUsed).toBe(false);
});

test("missing and corrupted records return null without poisoning valid answers", async () => {
  const { readdir, writeFile } = await import("node:fs/promises");
  const { statePath } = await import("@/lib/configDir");
  const { structuredUserReferenceKey } = await import("@/lib/runtime/codexStructuredUserText");
  const wire = await encodeCodexStructuredUserText("corruption fixture", "b".repeat(64));
  const ref = decodeCodexStructuredUserText(wire).metadataRef!;
  const valid = decodeCodexStructuredUserText(await encodeCodexStructuredUserText("valid fixture", undefined, null, { kind: "operator" })).metadataRef!;
  const filename = (await readdir(statePath("structured-user-metadata"))).find(name => name.includes(structuredUserReferenceKey(ref)!))!;
  await writeFile(statePath("structured-user-metadata", filename), "{}");
  const missing = `h.${Buffer.alloc(32).toString("base64url")}`;
  const response = await POST(request({ refs: [ref, missing, valid] }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ [ref]: null, [missing]: null, [valid]: { origin: "operator" } });
});

test("aborting a stalled request cancels its body", async () => {
  const controller = new AbortController();
  let cancel = false;
  const req = new NextRequest("http://localhost/api/structured-user/provenance", {
    method: "POST", headers: { host: "localhost" }, signal: controller.signal,
    body: new ReadableStream({ cancel() { cancel = true; } }), duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
  const pending = POST(req);
  controller.abort();
  expect((await pending).status).toBe(400);
  expect(cancel).toBe(true);
});
