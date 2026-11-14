import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createToolResultMedia } from "./toolResultMedia";
import { toolCallResultSchema } from "./protocol";
import { startTestRelay } from "./testRelay";
import { admittedSeedMedia, MAX_INPUT_MEDIA_FILE_BYTES, MAX_INPUT_MEDIA_TOTAL_BYTES, type MediaRequest } from "./mediaInputValidation";
import type { ToolProjection } from "./toolLoop";

const now = Date.parse("2026-10-19T12:00:00Z");
const fixturePath = path.join(import.meta.dir, "fixtures/relay_v1/tool_result_images.json");
const photo = (ref = "media_00000000000000000000000000000001", size = 77) => ({ ref, kind: "photo" as const, availability: "ready" as const,
  mime_type: "image/png", byte_size: size, filename: "photo.png", expires_at: "2026-10-19T12:10:00Z" });
const projection = (media: unknown[]): ToolProjection => ({ round: 1, tool: "get_profile_photo", status: "ok", truncated: false, output: JSON.stringify({ media }) });
const request = (): MediaRequest => ({ request_id: "request_test", lease_id: "lease_test_000000000000", features: ["requester_context", "relay_media_in"],
  input: { respond_to: "trigger", conversation: [{ id: "trigger", reply_to: null }], documents: [] } });

test("service result images retain their exact wire fixture and decode both locations", async () => {
  const bytes = await fs.readFile(fixturePath);
  expect(bytes.length).toBe(2015);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("176fdbef0f50b83973a21f998692d7f6df31d1df7da63011309bb5d27a2bd3a6");
  const samples = JSON.parse(bytes.toString());
  for (const sample of Object.values(samples)) expect(toolCallResultSchema.safeParse(sample).success).toBe(true);
  expect(JSON.parse(samples.get_profile_photo.output).media[0]).toMatchObject(photo("media_00000000000000000000000000000001"));
  expect(JSON.parse(samples.get_media.output).selected_frames.map((frame: { file: unknown }) => frame.file)).toHaveLength(3);
});

async function harness(input = request(), response?: Parameters<typeof startTestRelay>[0], authorize = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-tool-images-"));
  const png = await (await import("sharp")).default({ create: { width: 2, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  const downloads: string[] = [];
  const server = await startTestRelay((req, body) => {
    downloads.push(req.url!);
    expect(req.headers["delegatus-relay-lease"]).toBe(input.lease_id);
    return response ? response(req, body) : { raw: png, headers: { "content-type": "image/png", "content-length": String(png.length) } };
  });
  const abort = new AbortController();
  const media = createToolResultMedia({ api_base: `${server.origin}/v1`, credential: "fixture-credential" }, input, directory,
    { signal: abort.signal, deadlineAt: now + 600_000, now: () => now, authorize });
  return { media, downloads, png, abort, directory,
    close: async () => { await media.dispose(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("downloads once in this request, reuses results, and removes owned files", async () => {
  const f = await harness();
  try {
    const item = photo("media_00000000000000000000000000000001", f.png.length), first = projection([item]), repeat = projection([item]);
    await f.media.collect([first, repeat]);
    await f.media.collect([first, repeat]);
    expect(f.downloads).toEqual(["/v1/requests/request_test/media/media_00000000000000000000000000000001"]);
    expect(f.media.files).toHaveLength(1);
    expect(admittedSeedMedia(request(), { seed_media_refs: [item.ref] }, f.media.seedRefs)).toBe(true);
    expect(admittedSeedMedia(request(), { seed_media_refs: [item.ref] })).toBe(false);
    expect(await fs.readFile(f.media.files[0]!.path)).toEqual(f.png);
    expect(repeat.media_notes).toEqual(first.media_notes);
    await f.media.dispose();
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

for (const [change, reason] of [
  [{ ref: undefined }, "missing media ref"], [{ availability: "protected", ref: undefined }, "protected"],
  [{ availability: "missing", ref: undefined }, "missing"], [{ availability: "too_large", ref: undefined }, "too_large"],
  [{ availability: "unsupported_type", ref: undefined }, "unsupported_type"],
  [{ byte_size: MAX_INPUT_MEDIA_FILE_BYTES + 1 }, "too_large"], [{ mime_type: "image/svg+xml" }, "unsupported_media_type"],
  [{ expires_at: "2026-10-19T11:59:59Z" }, "media_unavailable"], [{ ref: "https://example.invalid/photo" }, "malformed"],
  [{ filename: "../photo.png" }, "malformed"], [{ byte_size: 0 }, "malformed"],
] as const) test(`tool image refusal preserves text and explains ${JSON.stringify(change)}`, async () => {
  const f = await harness();
  try {
    const result = projection([{ ...photo(), ...change }]), original = result.output;
    await f.media.collect([result]);
    expect(result.output).toBe(original);
    expect(result.media_notes!.join(" ")).toContain(reason);
    expect(f.media.files).toEqual([]); expect(f.downloads).toEqual([]);
    expect(admittedSeedMedia(request(), { seed_media_refs: ["media_00000000000000000000000000000001"] }, f.media.seedRefs)).toBe(false);
  } finally { await f.close(); }
});

test.each(["not_found", "protected", "too_large", "unsupported_media_type"])("download refusal %s stays visible and is not retried", async reason => {
  const f = await harness(request(), () => ({ status: reason === "not_found" ? 404 : 422, body: { error: { code: reason } } }));
  try {
    const first = projection([photo()]), second = projection([photo()]);
    await f.media.collect([first, second]);
    expect(first.media_notes!.join(" ")).toContain(reason);
    expect(second.media_notes).toEqual(first.media_notes);
    expect(f.downloads).toHaveLength(1); expect(f.media.files).toEqual([]);
    expect(admittedSeedMedia(request(), { seed_media_refs: ["media_00000000000000000000000000000001"] }, f.media.seedRefs)).toBe(false);
  } finally { await f.close(); }
});

test("count and total byte limits include inbound media and cannot reset between rounds", async () => {
  for (const sizes of [Array(10).fill(1), Array(5).fill(MAX_INPUT_MEDIA_TOTAL_BYTES / 5)]) {
    const input = request(); input.input.conversation[0]!.media = sizes.map((size, i) => photo(`inbound_${i}`, size));
    const f = await harness(input);
    try {
      const result = projection([photo()]);
      await f.media.collect([result]);
      expect(result.media_notes!.join(" ")).toContain("too_large"); expect(f.downloads).toEqual([]);
    } finally { await f.close(); }
  }
  const f = await harness();
  try {
    const first = projection(Array.from({ length: 10 }, (_, i) => photo(`returned_${i}`, f.png.length)));
    await f.media.collect([first]);
    const next = projection([photo("eleventh", f.png.length)]);
    await f.media.collect([next]);
    expect(f.downloads).toHaveLength(10); expect(f.media.files).toHaveLength(10);
    expect(next.media_notes!.join(" ")).toContain("too_large");
  } finally { await f.close(); }
});

test("feature, status and effect fences prevent media fetches", async () => {
  const input = request(); input.features = [];
  const f = await harness(input);
  try {
    const result = projection([photo()]);
    await f.media.collect([result, { ...projection([photo()]), status: "denied" }, { ...projection([photo()]), effect: "action" }]);
    expect(result.media_notes!.join(" ")).toContain("not negotiated"); expect(f.downloads).toEqual([]);
  } finally { await f.close(); }
});

test.each(["denied", "action"])("a negotiated %s result cannot supply image seeds", async kind => {
  const f = await harness();
  try {
    const result = { ...projection([photo()]), ...(kind === "denied" ? { status: "denied" } : { effect: "action" as const }) };
    await f.media.collect([result]);
    expect(f.downloads).toEqual([]);
    expect(admittedSeedMedia(request(), { seed_media_refs: ["media_00000000000000000000000000000001"] }, f.media.seedRefs)).toBe(false);
  } finally { await f.close(); }
});

test("an image ref becomes a seed only after its download succeeds", async () => {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f: Awaited<ReturnType<typeof harness>> = await harness(request(), async () => {
    started(); await held;
    return { raw: f.png, headers: { "content-type": "image/png", "content-length": String(f.png.length) } };
  });
  const pending = f.media.collect([projection([photo("media_00000000000000000000000000000001", f.png.length)])]);
  try {
    await entered;
    expect(admittedSeedMedia(request(), { seed_media_refs: ["media_00000000000000000000000000000001"] }, f.media.seedRefs)).toBe(false);
    release(); await pending;
    expect(admittedSeedMedia(request(), { seed_media_refs: ["media_00000000000000000000000000000001"] }, f.media.seedRefs)).toBe(true);
  } finally { release(); await pending; await f.close(); }
});

test("a legacy avatar result with no descriptor keeps its text and explains the absent ref", async () => {
  const f = await harness();
  try {
    const result = projection([]); result.output = JSON.stringify({ summary: "Avatar metadata only.", mime_type: "image/png" });
    const original = result.output;
    await f.media.collect([result]);
    expect(result.output).toBe(original);
    expect(result.media_notes!.join(" ")).toContain("no request-local media ref");
    expect(f.downloads).toEqual([]);
  } finally { await f.close(); }
});

test("an inbound ref is reused and extra descriptors receive a bounded refusal", async () => {
  const input = request(); input.input.conversation[0]!.media = [photo()];
  const f = await harness(input);
  try {
    const result = projection(Array.from({ length: 11 }, () => photo()));
    await f.media.collect([result]);
    expect(result.media_notes).toHaveLength(11);
    expect(result.media_notes![0]).toContain("supplied as inbound media");
    expect(result.media_notes!.at(-1)).toContain("too_large");
    expect(f.downloads).toEqual([]);
  } finally { await f.close(); }
});

test("failed downloads consume count admission across later rounds", async () => {
  const f = await harness(request(), () => ({ status: 404, body: { error: { code: "not_found" } } }));
  try {
    await f.media.collect([projection(Array.from({ length: 10 }, (_, i) => photo(`failed_${i}`)))]);
    const next = projection([photo("eleventh")]); await f.media.collect([next]);
    expect(f.downloads).toHaveLength(10);
    expect(next.media_notes!.join(" ")).toContain("too_large");
  } finally { await f.close(); }
});

test("redirects and mismatched lengths are refused through the existing download path", async () => {
  const responses: Awaited<ReturnType<Parameters<typeof startTestRelay>[0]>>[] = [
    { status: 302, headers: { location: "https://example.invalid/photo" } },
    { raw: Buffer.alloc(78), headers: { "content-type": "image/png", "content-length": "78" } },
    { raw: Buffer.alloc(77), headers: { "content-type": "image/jpeg", "content-length": "77" } },
    { raw: Buffer.alloc(77), headers: { "content-type": "image/png", "content-length": "77", "content-encoding": "gzip" } },
  ];
  for (const response of responses) {
    const f = await harness(request(), () => response);
    try {
      const result = projection([photo()]); await f.media.collect([result]);
      expect(result.media_notes!.join(" ")).toContain("unavailable");
      expect(f.downloads).toHaveLength(1); expect(f.media.files).toEqual([]);
      expect(await fs.readdir(f.directory)).toEqual([]);
    } finally { await f.close(); }
  }
});

test("lease loss remains terminal and stops sibling downloads", async () => {
  const f = await harness(request(), () => ({ status: 409, body: { error: { code: "lease_lost" } } }));
  try {
    await expect(f.media.collect([projection([photo(), photo("sibling")])])).rejects.toMatchObject({ code: "lease_lost" });
    expect(f.downloads).toHaveLength(1); expect(f.media.files).toEqual([]);
  } finally { await f.close(); }
});

test("authorization is checked again after the download response", async () => {
  let revoked = false;
  const f = await harness(request(), () => {
    revoked = true;
    return { raw: Buffer.alloc(77), headers: { "content-type": "image/png", "content-length": "77" } };
  }, () => { if (revoked) throw new Error("authorization revoked"); });
  try {
    await expect(f.media.collect([projection([photo()])])).rejects.toThrow("authorization revoked");
    expect(f.media.files).toEqual([]); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("changed descriptors fail closed and binary validation refuses a disguised image", async () => {
  const f = await harness(request(), () => ({ raw: Buffer.alloc(77), headers: { "content-type": "image/png", "content-length": "77" } }));
  try {
    const first = projection([photo()]); await f.media.collect([first]);
    expect(first.media_notes!.join(" ")).toContain("unsupported_media_type");
    const changed = projection([{ ...photo(), byte_size: 78 }]); await f.media.collect([changed]);
    expect(changed.media_notes!.join(" ")).toContain("malformed");
    expect(f.downloads).toHaveLength(1); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("cancellation prevents downloads and image attachment", async () => {
  const f = await harness();
  f.abort.abort(new Error("cancelled"));
  try {
    await expect(f.media.collect([projection([photo()])])).rejects.toThrow("cancelled");
    expect(f.media.files).toEqual([]);
  } finally { await f.close(); }
});

test("cancellation during a download clears its directory and stops siblings", async () => {
  const f: Awaited<ReturnType<typeof harness>> = await harness(request(), () => {
    f.abort.abort(new Error("download cancelled"));
    return { raw: Buffer.alloc(77), headers: { "content-type": "image/png", "content-length": "77" } };
  });
  try {
    await expect(f.media.collect([projection([photo(), photo("sibling")])])).rejects.toThrow("download cancelled");
    expect(f.downloads).toHaveLength(1); expect(f.media.files).toEqual([]);
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});


test("collector disposal owns borrowed inbound originals as well as returned files", async () => {
  const f = await harness();
  try {
    const item = photo("media_00000000000000000000000000000001", f.png.length);
    await f.media.collect([projection([item])]);
    const original = f.media.files[0]!.path;
    const input = request(); input.input.conversation[0]!.media = [item];
    const collector = createToolResultMedia({ api_base: "http://127.0.0.1:1/v1", credential: "fixture" }, input, f.directory,
      { signal: new AbortController().signal, deadlineAt: now + 600_000, now: () => now, authorize: () => {} },
      { files: [...f.media.files], dispose: () => f.media.dispose() });
    try {
      const result = projection([item]); await collector.collect([result]);
      expect((await collector.images([result])).content).toEqual([{ type: "image", mimeType: "image/png", data: f.png.toString("base64") }]);
      expect(f.downloads).toHaveLength(1);
      await collector.dispose(); expect(await fs.stat(original).then(() => true, () => false)).toBe(false);
      expect(collector.seedRefs.has(item.ref)).toBe(false);
    } finally { await collector.dispose(); }
  } finally { await f.close(); }
});
