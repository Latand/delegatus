import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import fixture from "./fixtures/relay_v1/avatar_seed.json";
import { admittedSeedMedia } from "./mediaInputValidation";
import { createToolResultMedia } from "./toolResultMedia";
import { createToolLoop } from "./toolLoop";
import { toolRoundPrompt } from "./prompt";
import { x1Request } from "./toolLoop.fixture";
import { startTestRelay } from "./testRelay";
import type { PairedRelay } from "./store";

const ref = (index: number) => `media_${index.toString(16).padStart(32, "0")}`;
const photo = (index: number) => ({ ...fixture.examples.reference_only.avatar_result.media[0]!,
  ref: ref(index), kind: "photo" as const, availability: "ready" as const });
function request() {
  const input = x1Request("member");
  input.features = [...fixture.negotiated_features];
  return input;
}

test("avatar seed fixture retains the reviewed service bytes and negotiated feature pair", async () => {
  const bytes = await fs.readFile(path.join(import.meta.dir, "fixtures/relay_v1/avatar_seed.json"));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("def8750ba2ce52f604c4a3e519b01502736b2b15c6bdb4ed5cb9f58c4dd02ba7");
  expect(fixture.negotiated_features).toEqual(["requester_context", "relay_media_in"]);
});

test("seed admission accepts ten inbound, returned or mixed images and refuses eleven", () => {
  for (const inboundCount of [0, 4, 10]) {
    const input = request();
    input.input.conversation[0]!.media = Array.from({ length: inboundCount }, (_, index) => photo(index + 1));
    const returned = new Set(Array.from({ length: 10 - inboundCount }, (_, index) => ref(index + inboundCount + 1)));
    for (let count = 1; count <= 10; count++) {
      expect(admittedSeedMedia(input, { seed_media_refs: Array.from({ length: count }, (_, index) => ref(index + 1)) }, returned)).toBe(true);
    }
    expect(admittedSeedMedia(input, { seed_media_refs: Array.from({ length: 11 }, (_, index) => ref(index + 1)) }, new Set([...returned, ref(11)]))).toBe(false);
  }
});

test("seed admission preserves optional arguments, feature, type, readiness and uniqueness fences", () => {
  const input = request();
  input.input.conversation[0]!.media = [photo(1), { ...photo(2), availability: "missing" },
    { ...photo(3), kind: "document", mime_type: "text/plain" }];
  const returned = new Set([ref(4)]);
  expect(admittedSeedMedia(input, {})).toBe(true);
  for (const seed_media_refs of [[], null, ref(1), [123], ["../file"], [ref(5)], [ref(2)], [ref(3)], [ref(4), ref(4)]]) {
    expect(admittedSeedMedia(input, { seed_media_refs }, returned)).toBe(false);
  }
  for (const features of [[], ["relay_media_in"], ["requester_context"]]) {
    input.features = features;
    expect(admittedSeedMedia(input, { seed_media_refs: [ref(1)] }, returned)).toBe(false);
    expect(admittedSeedMedia(input, { seed_media_refs: [ref(4)] }, returned)).toBe(false);
    expect(admittedSeedMedia(input, {})).toBe(true);
  }
});

for (const [name, example] of Object.entries(fixture.examples)) test(`service avatar seed example reaches the real loop: ${name}`, async () => {
  const input = request();
  input.input.tools = [
    { name: "get_profile_photo", summary: "Read the requested avatar", mode: "direct", effect: "read", parameters: { type: "object" } },
    { name: example.call.tool, summary: "Generate the requested image", mode: "direct", effect: "action", parameters: example.parameters },
  ];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-avatar-seed-"));
  const png = await (await import("sharp")).default({ create: { width: 2, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  const posts: { tool: string; arguments: Record<string, unknown> }[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.includes("/media/")) return { raw: png, headers: { "content-type": "image/png", "content-length": String(png.length) } };
    const call = body as { call_id: string; tool: string; arguments: Record<string, unknown> };
    posts.push(call);
    if (call.tool === "get_profile_photo") return { body: {
      call_id: call.call_id, tool: call.tool, status: "ok", effect: "read", truncated: false,
      replayed: false, delivered: false, calls_remaining: 16 - posts.length,
      output: JSON.stringify({ ...example.avatar_result, media: [{ ...example.avatar_result.media[0],
        ref: call.arguments.ref, byte_size: png.length }] }),
    } };
    return { body: { ...example.result, call_id: call.call_id } };
  });
  const relay = { api_base: `${server.origin}/v1`, credential: "fixture-credential" } as PairedRelay;
  const signal = new AbortController().signal;
  const now = Date.parse("2026-10-19T12:00:00Z");
  const media = createToolResultMedia(relay, input, directory, { signal, now: () => now, deadlineAt: now + 600_000, authorize: () => {} });
  const loop = createToolLoop(relay, input, { signal, ack: async () => true, lose: () => {} }, { seedMediaRefs: media.seedRefs });
  try {
    // The service fixture records only the last read in its ten-avatar case.
    // Replay its earlier reads with deterministic refs; the unknown ref is never returned.
    const refs = name.includes("references") ? Array.from({ length: 10 }, (_, index) => ref(index + 1)) : [example.avatar_result.media[0]!.ref];
    for (let index = 0; index < refs.length; index += 4) {
      await loop.runCalls(refs.slice(index, index + 4).map(imageRef => ({
        tool: "get_profile_photo", arguments: JSON.stringify({ ref: imageRef }), cursor: null,
      })), index / 4 + 1);
      await media.collect(loop.results);
    }
    const target = name === "another_request"
      ? createToolLoop(relay, { ...input, request_id: "other_request" }, { signal, ack: async () => true, lose: () => {} }) : loop;
    await target.runCalls([{ tool: example.call.tool, arguments: JSON.stringify(example.call.arguments), cursor: null }], 4);
    const local = ["eleven_references_refused", "unknown_reference", "another_request"].includes(name);
    const actions = posts.filter(call => call.tool !== "get_profile_photo");
    expect(actions).toHaveLength(local ? 0 : 1);
    expect(target.results.at(-1)).toMatchObject(local
      ? { status: "denied", code: "invalid_arguments", output: "" }
      : { status: example.result.status, output: example.result.output,
        ...("code" in example.result ? { code: example.result.code } : {}) });
    if (!local) expect(actions[0]).toMatchObject({ tool: example.call.tool, arguments: example.call.arguments });
    if (!local) {
      const prompt = toolRoundPrompt(input, 5, { results: target.results, callsLeft: target.callsLeft(), final: true, actionSent: target.actionSent });
      const modelResults = JSON.parse(prompt.split("<tool_results>\n")[1]!.split("\n</tool_results>")[0]!);
      expect(modelResults.at(-1)).toMatchObject({ status: example.result.status, output: example.result.output,
        ...("code" in example.result ? { code: example.result.code } : {}) });
    }
  } finally { await media.dispose(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
