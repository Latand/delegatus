import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { writeKey, removeOpenAiKey } from "@/lib/keys/store";
import { chooseService } from "@/lib/openaiServices/policy";
import { writeTranscribeBackend, transcribeBackendInfo } from "@/lib/transcribeBackend";
import { POST as UPLOAD } from "@/app/api/transcribe/route";
import { POST as TOKEN } from "@/app/api/transcribe/token/route";
import { openAiTranscribe } from "./openai";
import { reduceOpenAiTranscript, openAiCommitEvent, openAiTranscriptText } from "./openaiLive";
import { TRANSCRIPTION_LANGUAGES } from "./languages";

let root: string, saved: Record<string, string | undefined>;
const variables = ["XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_TRANSCRIBE_BACKEND", "OPENAI_API_KEY"];
const credential = ["sk", "proj", "s".repeat(48)].join("-");
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openai-transcription-"));
  process.env.XDG_CONFIG_HOME = path.join(root, "config"); process.env.LLV_STATE_DIR = path.join(root, "state");
  writeTranscribeBackend("local"); await writeKey("openai", credential); await chooseService("dictation", "openai");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});
const req = (body?: FormData) => new NextRequest("http://127.0.0.1/api/transcribe", { method: "POST", headers: { host: "127.0.0.1" }, body });
test("actual upload dispatch sends normalized MIME, original file extension and languages", async () => {
  expect(transcribeBackendInfo().backend).toBe("openai");
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++; expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${credential}` });
    const form = init!.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe"); expect(form.getAll("languages[]")).toEqual([...TRANSCRIPTION_LANGUAGES]);
    const file = form.get("file") as File; expect(file.name).toBe("dictation.webm"); expect(file.type).toBe("audio/webm");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    return Response.json({ text: "Тест", languages: [{ code: "uk" }] });
  }) as typeof fetch;
  const form = new FormData(); form.append("file", new File([new Uint8Array([1, 2, 3])], "dictation.webm", { type: "video/webm" })); form.append("language", "uk");
  expect(await (await UPLOAD(req(form))).json()).toEqual({ text: "Тест", language: "uk" }); expect(calls).toBe(1);
});
test.each(["http", "network", "json", "shape"])("recorded %s failure is sanitized", async kind => {
  const file = new File(["audio-fixture"], "recording.wav", { type: "audio/wav" });
  const fetcher = (async () => {
    if (kind === "network") throw Error(credential);
    if (kind === "http") return new Response(credential, { status: 401 });
    if (kind === "json") return new Response(credential);
    return Response.json({ text: 7 });
  }) as unknown as typeof fetch;
  await expect(openAiTranscribe(credential, file, "uk", fetcher)).rejects.toThrow("OpenAI transcription unavailable");
});
test("unsupported language uses the preferred tag; absent language remains absent", async () => {
  const file = new File(["fixture"], "recording.wav");
  expect(await openAiTranscribe(credential, file, "uk", (async () => Response.json({ text: "Words", languages: [{ code: "xx" }] })) as typeof fetch)).toEqual({ text: "Words", language: "uk" });
  expect(await openAiTranscribe(credential, file, "uk", (async () => Response.json({ text: "Words", languages: [] })) as typeof fetch)).toEqual({ text: "Words" });
});
test("actual token route mints only a transcription secret with a 120 second expiry", async () => {
  const temporary = "temporary-transcription-fixture"; const expires = Math.floor(Date.now() / 1000) + 120;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const body = JSON.parse(String(init?.body));
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 120 });
    expect(body.session).toEqual({ type: "transcription", audio: { input: { transcription: { model: "gpt-live-transcribe", languages: [...TRANSCRIPTION_LANGUAGES], delay: "low" }, turn_detection: null } } });
    return Response.json({ value: temporary, expires_at: expires });
  }) as typeof fetch;
  const response = await TOKEN(req()); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ provider: "openai", token: temporary, expiresAt: expires });
});
test.each(["account", "missing", "expired", "http", "network"])("a %s secret answer never exposes the account key", async kind => {
  const log = spyOn(console, "error");
  try {
    globalThis.fetch = (async () => {
      if (kind === "network") throw Error(credential);
      if (kind === "http") return new Response(credential, { status: 429 });
      return Response.json({ value: kind === "account" ? credential : kind === "missing" ? "" : "temporary-fixture", expires_at: 1 });
    }) as unknown as typeof fetch;
    const response = await TOKEN(req()); expect(response.status).toBe(502); expect(await response.text()).not.toContain(credential); expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
  } finally { log.mockRestore(); }
});
test("key removal is reflected at the next token request and legacy keyless OpenAI returns 503", async () => {
  await removeOpenAiKey(); expect((await TOKEN(req())).status).toBe(409);
  process.env.LLV_TRANSCRIBE_BACKEND = "openai";
  expect((await TOKEN(req())).status).toBe(503);
});
test("live reducer keeps item order, replaces drafts, and ignores late deltas", () => {
  let state = { items: [] } as ReturnType<typeof reduceOpenAiTranscript>;
  const event = (id: string, type: string, text: string) => ({ type: `conversation.item.input_audio_transcription.${type}`, item_id: id, ...(type === "delta" ? { delta: text } : { transcript: text }) });
  state = reduceOpenAiTranscript(state, event("a", "delta", "one"));
  state = reduceOpenAiTranscript(state, event("b", "delta", "two"));
  state = reduceOpenAiTranscript(state, event("b", "completed", "Second"));
  state = reduceOpenAiTranscript(state, event("a", "completed", "First"));
  state = reduceOpenAiTranscript(state, event("a", "delta", "late"));
  expect(openAiTranscriptText(state)).toBe("First Second"); expect(state.items.every(item => item.complete)).toBe(true);
  expect(openAiCommitEvent()).toEqual({ type: "input_audio_buffer.commit" });
});
