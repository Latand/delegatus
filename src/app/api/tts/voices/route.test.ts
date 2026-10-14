import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { writeTtsVoice } from "@/lib/ttsBackend";
import { GET } from "./route";

const names = ["XDG_CONFIG_HOME", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "FISH_AUDIO_API_KEY", "SONIOX_API_KEY", "LLV_TTS_ELEVENLABS_VOICE", "LLV_TTS_FISHAUDIO_VOICE", "LLV_TTS_SONIOX_VOICE", "LLV_TTS_SONIOX_MODEL"];
const saved = names.map((name) => process.env[name]);
const originalFetch = globalThis.fetch;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-voices-"));
  names.forEach((name) => { delete process.env[name]; });
  process.env.XDG_CONFIG_HOME = root;
  for (const name of names.filter((n) => n.endsWith("API_KEY"))) process.env[name] = "provider-fixture";
});
afterEach(() => {
  names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true });
});
const request = (backend: string) => new NextRequest(`http://127.0.0.1/api/tts/voices?backend=${backend}`);
function stub(handler: (url: string) => Response | Promise<Response>) {
  const fetcher = mock(async (url: unknown, init?: RequestInit) => { expect(init?.signal).toBeDefined(); return handler(String(url)); });
  globalThis.fetch = fetcher as unknown as typeof fetch;
  return fetcher;
}
test("ElevenLabs pages, includes generated own voices and resolves selected by id", async () => {
  writeTtsVoice("elevenlabs", "selected");
  const fetcher = stub((url) => {
    if (url.includes("/v1/voices/selected")) return Response.json({ voice_id: "selected", name: "Selected voice", category: "generated", is_owner: true });
    if (url.includes("next_page_token=next")) return Response.json({ voices: [{ voice_id: "own", name: "Zed", category: "generated", is_owner: true }], has_more: false });
    return Response.json({ voices: [{ voice_id: "shared", name: "Alpha", category: "premade", is_owner: false }], has_more: true, next_page_token: "next" });
  });
  const response = await GET(request("elevenlabs")); const body = await response.json();
  expect(response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(3);
  expect(body.voices).toEqual([{ id: "selected", name: "Selected voice", own: true }, { id: "own", name: "Zed", own: true }, { id: "shared", name: "Alpha", own: false }]);
  expect(body.selected).toEqual({ id: "selected", name: "Selected voice", known: true });
  expect(JSON.stringify(body)).not.toContain("provider-fixture");
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("xi-api-key")).toBe("provider-fixture");
});
test.each([400, 404])("ElevenLabs unknown lookup HTTP %i is visible", async (status) => {
  stub((url) => url.includes("/v2/") ? Response.json({ voices: [], has_more: false }) : Response.json({ detail: { status: "voice_not_found" } }, { status }));
  expect((await (await GET(request("elevenlabs"))).json()).selected.known).toBe(false);
});
test("Fish empty self list keeps default and resolves a public voice title", async () => {
  writeTtsVoice("fishaudio", "public-voice");
  stub((url) => url.includes("self=true") ? Response.json({ total: 0, items: [] }) : Response.json({ _id: "public-voice", title: "Public narrator", type: "tts", state: "trained", visibility: "public" }));
  const body = await (await GET(request("fishaudio"))).json();
  expect(body.voices.map((v: { id: string }) => v.id)).toEqual(["default", "public-voice"]);
  expect(body.selected).toEqual({ id: "public-voice", name: "Public narrator", known: true });
});
test("Soniox follows configured model alias and merges paginated clones", async () => {
  process.env.LLV_TTS_SONIOX_MODEL = "alias"; writeTtsVoice("soniox", "custom");
  const fetcher = stub((url) => {
    if (url.includes("tts-models")) return Response.json({ models: [{ id: "alias", aliased_model_id: "tts-rt-v2", voices: [] }, { id: "tts-rt-v2", aliased_model_id: null, voices: [{ id: "Adrian", gender: "male", description: "Warm" }] }, { id: "other", voices: [{ id: "Other" }] }] });
    if (url.includes("cursor=next")) return Response.json({ voices: [{ id: "custom", name: "Custom voice", filename: "sample.wav", created_at: "2026-10-01T00:00:00Z", models: [{ model: "tts-rt-v2", status: "ready" }] }], next_page_cursor: null });
    return Response.json({ voices: [], next_page_cursor: "next" });
  });
  const body = await (await GET(request("soniox"))).json();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(body.voices).toEqual([{ id: "custom", name: "Custom voice", own: true }, { id: "Adrian", name: "Adrian", own: false }]);
  expect(body.selected.known).toBe(true);
});
test("unconfigured provider and OpenAI never fetch", async () => {
  const fetcher = stub(() => { throw new Error("must not fetch"); });
  delete process.env.ELEVENLABS_API_KEY;
  const response = await GET(request("elevenlabs"));
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "missing-key", keyPath: expect.stringContaining("elevenlabs-api-key") });
  expect((await (await GET(request("openai"))).json()).code).toBe("no-list");
  expect(fetcher).not.toHaveBeenCalled();
});
test("permission refusal retains safe provider sentence", async () => {
  stub(() => Response.json({ detail: { status: "missing_permissions", message: "Missing voices_read permission for provider-fixture" } }, { status: 401 }));
  const response = await GET(request("elevenlabs")); const body = await response.text();
  expect(response.status).toBe(502); expect(JSON.parse(body)).toMatchObject({ code: "provider-refused", error: expect.stringContaining("voices_read") });
  expect(body).not.toContain("provider-fixture");
});
test("oversized and malformed lists are unreachable", async () => {
  for (const response of [() => new Response("x".repeat(4 * 1024 * 1024 + 1)), () => Response.json({ unrelated: [] })]) {
    stub(response); expect((await (await GET(request("elevenlabs"))).json()).code).toBe("unreachable");
  }
});
test("pagination is bounded and an incomplete list never claims a missing voice", async () => {
  // The selected lookup remains authoritative even after the list is truncated.
  const fetcher = stub((url) => url.includes("/v2/") ? Response.json({ voices: [], has_more: true, next_page_token: "next" }) : Response.json({ voice_id: "selected", name: "Selected", is_owner: false }));
  const body = await (await GET(request("elevenlabs"))).json();
  expect(fetcher).toHaveBeenCalledTimes(6); expect(body.truncated).toBe(true); expect(body.selected.known).toBe(true);
});

test("a stalled response is cancelled with its caller", async () => {
  const abort = new AbortController(); let cancelled = false; let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  stub(() => { ready(); return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  const pending = GET(new NextRequest("http://127.0.0.1/api/tts/voices?backend=elevenlabs", { signal: abort.signal }));
  await started; abort.abort();
  expect((await (await pending).json()).code).toBe("unreachable"); expect(cancelled).toBe(true);
});
