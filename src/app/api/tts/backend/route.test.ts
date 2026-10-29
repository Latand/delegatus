import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { configFilePath } from "@/lib/configDir";
import { writeFishAudioModel, writeTtsBackend, writeTtsVoice } from "@/lib/ttsBackend";
import { GET, POST } from "./route";

const names = ["XDG_CONFIG_HOME", "LLV_TTS_BACKEND", "LLV_TTS_FISHAUDIO_MODEL", "LLV_TTS_ELEVENLABS_VOICE"];
const original = names.map((name) => process.env[name]);
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-selection-"));
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.LLV_TTS_BACKEND;
  delete process.env.LLV_TTS_FISHAUDIO_MODEL;
  delete process.env.LLV_TTS_ELEVENLABS_VOICE;
});
afterEach(() => {
  names.forEach((name, index) => { if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index]; });
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (body: unknown, origin?: string) => new NextRequest("http://127.0.0.1/api/tts/backend", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

test("one request persists the provider and model", async () => {
  expect((await POST(request({ backend: "fishaudio", model: "s2.1-pro" }))).status).toBe(200);
  expect(fs.readFileSync(configFilePath("tts-backend"), "utf8").trim()).toBe("fishaudio");
  expect(fs.readFileSync(configFilePath("tts-model-fishaudio"), "utf8").trim()).toBe("s2.1-pro");
  expect((await (await GET()).json()).options.find((option: { id: string }) => option.id === "fishaudio").model).toBe("s2.1-pro");
});
test("invalid bodies and models write nothing", async () => {
  for (const body of [null, [], { backend: "typo" }, { backend: "fishaudio", model: "typo" }, { backend: "soniox", model: "s2.1-pro" }]) expect((await POST(request(body))).status).toBe(400);
  expect(fs.existsSync(configFilePath("tts-backend"))).toBe(false);
  expect(fs.existsSync(configFilePath("tts-model-fishaudio"))).toBe(false);
});
test("environment locks refuse writes, allowing model changes when only Fish Audio's provider is locked", async () => {
  process.env.LLV_TTS_BACKEND = "soniox";
  expect((await POST(request({ backend: "fishaudio", model: "s2.1-pro" }))).status).toBe(409);
  process.env.LLV_TTS_BACKEND = "fishaudio";
  expect((await POST(request({ backend: "fishaudio", model: "s2.1-pro" }))).status).toBe(200);
  process.env.LLV_TTS_FISHAUDIO_MODEL = "s2.1-pro-free";
  expect((await POST(request({ backend: "fishaudio", model: "s2.1-pro" }))).status).toBe(409);
  expect(fs.readFileSync(configFilePath("tts-model-fishaudio"), "utf8").trim()).toBe("s2.1-pro");
});
test("cross-origin selection is refused", async () => {
  expect((await POST(request({ backend: "fishaudio" }, "https://other.example.test"))).status).toBe(403);
});

test("saves each voice independently and allows the locked provider voice", async () => {
  for (const backend of ["elevenlabs", "fishaudio", "soniox"] as const) {
    expect((await POST(request({ backend, voice: `${backend}-voice` }))).status).toBe(200);
    expect(fs.readFileSync(configFilePath(`tts-voice-${backend}`), "utf8")).toBe(`${backend}-voice\n`);
  }
  expect((await GET()).status).toBe(200);
  process.env.LLV_TTS_BACKEND = "elevenlabs";
  expect((await POST(request({ backend: "elevenlabs", voice: "updated" }))).status).toBe(200);
  expect((await POST(request({ backend: "soniox", voice: "other" }))).status).toBe(409);
  process.env.LLV_TTS_ELEVENLABS_VOICE = "env";
  expect((await POST(request({ backend: "elevenlabs", voice: "blocked" }))).status).toBe(409);
  expect(fs.readFileSync(configFilePath("tts-voice-elevenlabs"), "utf8")).toBe("updated\n");
});
test.each(["", "a\nb", "x".repeat(129), 7, null])("refuses invalid voice %j", async (voice) => {
  expect((await POST(request({ backend: "elevenlabs", voice }))).status).toBe(400);
  expect(fs.existsSync(configFilePath("tts-backend"))).toBe(false);
});

for (const choice of [
  { file: "tts-backend", body: { backend: "soniox" }, expected: "soniox" },
  { file: "tts-model-fishaudio", body: { backend: "fishaudio", model: "s2.1-pro" }, expected: "s2.1-pro" },
  { file: "tts-voice-soniox", body: { backend: "soniox", voice: "saved voice" }, expected: "saved voice" },
]) test(`a failed ${choice.file} write keeps its error and releases admission for retry`, async () => {
  const file = configFilePath(choice.file);
  fs.mkdirSync(file, { recursive: true });
  await expect(POST(request(choice.body))).rejects.toThrow("EISDIR");
  expect(fs.existsSync(`${file}.write-lock`)).toBe(false);
  expect(fs.readdirSync(`${file}.write-locks`)).toEqual([]);
  fs.rmdirSync(file);
  // A failed async commit must release the in-process synchronous admission too.
  if (choice.file === "tts-voice-soniox") writeTtsVoice("soniox", choice.expected);
  else if (choice.file === "tts-model-fishaudio") writeFishAudioModel("s2.1-pro");
  else writeTtsBackend("soniox");
  expect(fs.readFileSync(file, "utf8")).toBe(`${choice.expected}\n`);
  expect((await POST(request(choice.body))).status).toBe(200);
  expect(fs.readFileSync(file, "utf8")).toBe(`${choice.expected}\n`);
});
