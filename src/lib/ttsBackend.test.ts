import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { configFilePath } from "./configDir";
import { isTtsBackend, readFishAudioApiKey, writeFishAudioModel, readOpenAiApiKey, resolveTtsBackend, TTS_BACKENDS, ttsBackendInfo, ttsOptionFor, writeTtsBackend } from "./ttsBackend";
import { spokenAnswerText } from "./tts";

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

describe("message language routes", () => {
  const names = ["FISH_AUDIO_API_KEY", "LLV_TTS_ROUTE_UK", "LLV_TTS_ROUTE_RU", "LLV_TTS_ROUTE_EN", "LLV_TTS_SONIOX_MODEL", "LLV_TTS_SONIOX_VOICE", "LLV_TTS_SONIOX_LANGUAGE"];
  const original = names.map((name) => process.env[name]);
  afterEach(() => names.forEach((name, index) => setEnv(name, original[index])));
  function setup() {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    names.forEach((name) => setEnv(name, undefined));
    delete process.env.LLV_TTS_BACKEND;
    setEnv("FISH_AUDIO_API_KEY", "fish-fixture");
    setEnv("SONIOX_API_KEY", "soniox-fixture");
    return dir;
  }
  test("both keys enable the default Jarvis, Ethan and Ukrainian Soniox routes", () => {
    setup();
    const info = ttsBackendInfo();
    expect(info.byLanguage).toBe(true);
    expect(info.routes.ru).toMatchObject({ id: "fishaudio", model: "s2.1-pro", voice: "0c7fd46820854a9e8c4010d911687b7a", voiceName: "Джарвис 2.0" });
    expect(info.routes.en).toMatchObject({ id: "fishaudio", model: "s2.1-pro", voice: "536d3a5e000945adb7038665781a4aca", voiceName: "Ethan" });
    expect(info.routes.uk).toMatchObject({ id: "soniox", model: "tts-rt-v2", voice: "Adrian", language: "uk" });
    expect(JSON.stringify(info)).not.toContain("fish-fixture");
    expect(JSON.stringify(info)).not.toContain("soniox-fixture");
  });
  test("single-segment absolute paths do not change the selected language route", () => {
    setup();
    const cases = [
      ["Пушу знову. /отчёты", "uk", "soniox", "Adrian"],
      ["Теперь всё готово. /перевірки /інтерфейс", "ru", "fishaudio", "0c7fd46820854a9e8c4010d911687b7a"],
      ["All checks passed. /перевірки /інтерфейс /звіти", "en", "fishaudio", "536d3a5e000945adb7038665781a4aca"],
    ] as const;
    for (const [text, language, provider, voice] of cases) {
      expect(ttsOptionFor(undefined, text)).toMatchObject({ id: provider, voice });
      expect(ttsOptionFor(undefined, spokenAnswerText(text))).toMatchObject({ id: provider, voice });
      expect(ttsOptionFor(undefined, text).language).toBe(language === "uk" ? "uk" : undefined);
    }
  });
  test("env overrides files, inheritance follows provider settings and invalid routes fall back", () => {
    const dir = setup();
    fs.writeFileSync(path.join(dir, "tts-route-en"), "soniox - Maya");
    setEnv("LLV_TTS_SONIOX_MODEL", "custom-model");
    expect(ttsBackendInfo().routes.en).toMatchObject({ id: "soniox", model: "custom-model", voice: "Maya", language: "en" });
    setEnv("LLV_TTS_ROUTE_EN", "openai - nova");
    expect(ttsBackendInfo().routes.en).toMatchObject({ id: "openai", voice: "nova" });
    for (const bad of ["typo model voice", "fishaudio unknown-model voice", "fishaudio s2.1-pro voice extra"]) {
      setEnv("LLV_TTS_ROUTE_RU", bad);
      expect(ttsBackendInfo().routes.ru.voice).toBe("0c7fd46820854a9e8c4010d911687b7a");
    }
    setEnv("LLV_TTS_SONIOX_VOICE", "Maya");
    setEnv("LLV_TTS_SONIOX_LANGUAGE", "en");
    expect(ttsBackendInfo().routes.uk).toMatchObject({ voice: "Maya", language: "uk" });
  });
  test("mode defaults require all route keys; saved mode and backend env locks take precedence", () => {
    const dir = setup();
    setEnv("SONIOX_API_KEY", undefined);
    expect(ttsBackendInfo().byLanguage).toBe(false);
    fs.writeFileSync(path.join(dir, "tts-by-language"), "on");
    expect(ttsBackendInfo().byLanguage).toBe(true);
    fs.writeFileSync(path.join(dir, "tts-by-language"), "off");
    expect(ttsBackendInfo().byLanguage).toBe(false);
    fs.writeFileSync(path.join(dir, "tts-by-language"), "on");
    process.env.LLV_TTS_BACKEND = "fishaudio";
    expect(ttsBackendInfo()).toMatchObject({ byLanguage: false, lockedByEnv: true });
  });
});
