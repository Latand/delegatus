import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { configFilePath } from "./configDir";
import { isTtsBackend, readFishAudioApiKey, writeFishAudioModel, readOpenAiApiKey, resolveTtsBackend, TTS_BACKENDS, ttsBackendInfo, writeTtsBackend, writeTtsVoice, isTtsVoiceId } from "./ttsBackend";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const roots: string[] = [];

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tts-backend-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return path.join(root, "agent-log-viewer");
}

/* Env restore goes through a name-indexed helper: writing
   `process.env.X_API_KEY = value` directly reads as a credential assignment to
   the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  setEnv("XDG_CONFIG_HOME", originalConfigHome);
  setEnv("LLV_TTS_BACKEND", originalBackend);
  setEnv("OPENAI_API_KEY", originalOpenAiKey);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
});

describe("TTS backend configuration", () => {
  test("environment selection locks and overrides the persisted provider", () => {
    configHome();
    writeTtsBackend("openai");
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    expect(resolveTtsBackend()).toBe("elevenlabs");
    expect(ttsBackendInfo().lockedByEnv).toBe(true);
  });

  test("reads OpenAI credentials and voice/model configuration from files", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openai-api-key"), "file-key\n");
    fs.writeFileSync(path.join(dir, "tts-model-openai"), "tts-1-hd\n");
    fs.writeFileSync(path.join(dir, "tts-voice-openai"), "nova\n");
    setEnv("OPENAI_API_KEY", undefined);
    expect(readOpenAiApiKey()).toBe("file-key");
    expect(ttsBackendInfo().options[0]).toMatchObject({ available: true, model: "tts-1-hd", voice: "nova" });
  });
});

describe("soniox as a TTS backend (#1020)", () => {
  function sonioxOption() {
    return ttsBackendInfo().options.find((option) => option.id === "soniox")!;
  }

  test("is selectable beside the existing providers, by file and by env lock", () => {
    expect(TTS_BACKENDS).toEqual(["openai", "elevenlabs", "soniox", "fishaudio"]);
    expect(isTtsBackend("soniox")).toBe(true);

    configHome();
    delete process.env.LLV_TTS_BACKEND;
    writeTtsBackend("soniox");
    expect(resolveTtsBackend()).toBe("soniox");
    expect(ttsBackendInfo()).toMatchObject({ backend: "soniox", lockedByEnv: false });

    process.env.LLV_TTS_BACKEND = "soniox";
    writeTtsBackend("openai");
    expect(resolveTtsBackend()).toBe("soniox");
    expect(ttsBackendInfo().lockedByEnv).toBe(true);
  });

  test("defaults to the current realtime model and a built-in voice, overridable per machine", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    setEnv("SONIOX_API_KEY", "env-key");
    delete process.env.LLV_TTS_SONIOX_MODEL;
    delete process.env.LLV_TTS_SONIOX_VOICE;
    delete process.env.LLV_TTS_SONIOX_LANGUAGE;
    expect(sonioxOption()).toMatchObject({
      available: true,
      keyPath: path.join(dir, "soniox-api-key"),
      model: "tts-rt-v2",
      voice: "Adrian",
      language: "en",
    });

    fs.writeFileSync(path.join(dir, "tts-voice-soniox"), "Maya\n");
    fs.writeFileSync(path.join(dir, "tts-language-soniox"), "uk\n");
    expect(sonioxOption()).toMatchObject({ voice: "Maya", language: "uk" });
  });

  test("reads the key from the same file the transcription backend uses", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    setEnv("SONIOX_API_KEY", undefined);
    expect(sonioxOption().available).toBe(false);

    fs.writeFileSync(path.join(dir, "soniox-api-key"), "file-key\n");
    expect(sonioxOption().available).toBe(true);
  });

  test("adding it leaves the OpenAI and ElevenLabs options in place", () => {
    configHome();
    expect(ttsBackendInfo().options.map((option) => option.id)).toEqual(["openai", "elevenlabs", "soniox", "fishaudio"]);
  });
});


describe("Fish Audio configuration", () => {
  const names = ["FISH_AUDIO_API_KEY", "LLV_TTS_FISHAUDIO_MODEL", "LLV_TTS_FISHAUDIO_VOICE"];
  const original = names.map((name) => process.env[name]);
  afterEach(() => names.forEach((name, index) => setEnv(name, original[index])));
  const fish = (now?: number) => ttsBackendInfo(now).options.find((option) => option.id === "fishaudio")!;

  test("file and env selection, key precedence and safe model defaults", () => {
    configHome();
    const dir = path.dirname(configFilePath("fishaudio-api-key"));
    fs.mkdirSync(dir, { recursive: true });
    names.forEach((name) => setEnv(name, undefined));
    delete process.env.LLV_TTS_BACKEND;
    writeTtsBackend("fishaudio");
    expect(resolveTtsBackend()).toBe("fishaudio");
    expect(fish()).toMatchObject({ available: false, model: "s2.1-pro-free", voice: "default", keyPath: path.join(dir, "fishaudio-api-key") });
    fs.writeFileSync(path.join(dir, "fishaudio-api-key"), "file-fixture\n");
    expect(readFishAudioApiKey()).toBe("file-fixture");
    setEnv(names[0]!, "env-fixture");
    expect(readFishAudioApiKey()).toBe("env-fixture");
    writeFishAudioModel("s2.1-pro");
    expect(fish()).toMatchObject({ available: true, model: "s2.1-pro", modelLockedByEnv: false });
    setEnv(names[1]!, "s2.1-pro-free");
    setEnv(names[2]!, "configured-voice");
    expect(fish()).toMatchObject({ model: "s2.1-pro-free", modelLockedByEnv: true, voice: "configured-voice" });
    setEnv(names[1]!, "typo-paid-model");
    expect(fish().model).toBe("s2.1-pro-free");
    setEnv(names[1]!, undefined);
    fs.writeFileSync(path.join(dir, "tts-model-fishaudio"), "typo");
    expect(fish().model).toBe("s2.1-pro-free");
    process.env.LLV_TTS_BACKEND = "fishaudio";
    writeTtsBackend("soniox");
    expect(ttsBackendInfo()).toMatchObject({ backend: "fishaudio", lockedByEnv: true });
    expect(JSON.stringify(ttsBackendInfo())).not.toContain("env-fixture");
  });

  test("free expiry has a fixed UTC boundary even when the paid model is saved", () => {
    configHome();
    expect(fish(Date.parse("2026-11-30T23:59:59Z"))).toMatchObject({ freeUntil: "2026-11-30", freeEnded: false });
    expect(fish(Date.parse("2026-12-01T00:00:00Z"))).toMatchObject({ freeEnded: true });
  });
});


describe("voice persistence", () => {
  const names = TTS_BACKENDS.map((b) => `LLV_TTS_${b.toUpperCase()}_VOICE`);
  const saved = names.map((name) => process.env[name]);
  afterEach(() => names.forEach((name, i) => setEnv(name, saved[i])));
  test("per-provider values survive a fresh module import and selection changes", async () => {
    configHome(); names.forEach((name) => setEnv(name, undefined)); delete process.env.LLV_TTS_BACKEND;
    expect(ttsBackendInfo().options.find((o) => o.id === "elevenlabs")).toMatchObject({ model: "eleven_v4_turbo", voice: "JBFqnCBsd6RMkjVDRZzb" });
    for (const backend of TTS_BACKENDS) { writeTtsVoice(backend, `${backend} voice`); writeTtsBackend(backend); }
    const restartPath = "./ttsBackend.ts?restart=voices";
    const fresh: typeof import("./ttsBackend") = await import(restartPath);
    expect(fresh.resolveTtsBackend()).toBe("fishaudio");
    for (const option of fresh.ttsBackendInfo().options) expect(option).toMatchObject({ voice: `${option.id} voice`, voiceList: option.id !== "openai", voiceLockedByEnv: false });
    process.env.LLV_TTS_ELEVENLABS_VOICE = "env voice";
    expect(fresh.ttsBackendInfo().options[1]).toMatchObject({ voice: "env voice", voiceLockedByEnv: true });
  });
  test.each(["", " ", " x", "x ", "x\ny", "x\ty", "x\u2028y", "x".repeat(129)])("rejects invalid id %j", (value) => expect(isTtsVoiceId(value)).toBe(false));
  test("accepts names and ids", () => { expect(isTtsVoiceId("Adrian")).toBe(true); expect(isTtsVoiceId("a voice")).toBe(true); });
});
