import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { configFilePath } from "@/lib/configDir";
import { GET, POST } from "./route";

const names = ["XDG_CONFIG_HOME", "LLV_TTS_BACKEND", "LLV_TTS_FISHAUDIO_MODEL"];
const original = names.map((name) => process.env[name]);
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tts-selection-"));
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.LLV_TTS_BACKEND;
  delete process.env.LLV_TTS_FISHAUDIO_MODEL;
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

test("the language radio enables routing and a provider pick restores fixed mode", async () => {
  const enabled = await POST(request({ byLanguage: true }));
  expect(enabled.status).toBe(200);
  expect((await enabled.json()).byLanguage).toBe(true);
  expect(fs.readFileSync(configFilePath("tts-by-language"), "utf8").trim()).toBe("on");
  expect((await POST(request({ backend: "soniox" }))).status).toBe(200);
  expect((await (await GET()).json()).byLanguage).toBe(false);
  expect(fs.readFileSync(configFilePath("tts-by-language"), "utf8").trim()).toBe("off");
});
test("the environment backend lock refuses the language radio", async () => {
  process.env.LLV_TTS_BACKEND = "fishaudio";
  expect((await POST(request({ byLanguage: true }))).status).toBe(409);
  expect(fs.existsSync(configFilePath("tts-by-language"))).toBe(false);
});
