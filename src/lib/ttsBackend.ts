import fs from "node:fs";
import path from "node:path";

import { FISH_AUDIO_FREE_UNTIL, FISH_AUDIO_VOICE_NAMES, fishAudioFreeEnded, isFishAudioModel, type FishAudioModel } from "@/lib/fishAudio";
import { speechLanguage, type ProseLanguage } from "@/lib/i18n/proseLanguage";
import { configFilePath } from "@/lib/configDir";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";

export type TtsBackend = "openai" | "elevenlabs" | "soniox" | "fishaudio";
export const TTS_BACKENDS: readonly TtsBackend[] = ["openai", "elevenlabs", "soniox", "fishaudio"];

export interface TtsBackendOption {
  id: TtsBackend;
  available: boolean;
  keyPath: string;
  model: string;
  voice: string;
  cap: number;
  voiceName?: string;
  /** Soniox requires the language of the input text on every request; the
      other providers infer it from the text. */
  language?: string;
  modelLockedByEnv?: boolean;
  freeUntil?: string;
  freeEnded?: boolean;
}

export interface TtsBackendInfo {
  backend: TtsBackend;
  lockedByEnv: boolean;
  options: TtsBackendOption[];
  byLanguage: boolean;
  routes: Record<ProseLanguage, TtsBackendOption>;
}

export function isTtsBackend(value: unknown): value is TtsBackend {
  return typeof value === "string" && (TTS_BACKENDS as readonly string[]).includes(value);
}

function readFile(name: string): string | null {
  try {
    return fs.readFileSync(configFilePath(name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function resolveTtsBackend(): TtsBackend {
  const env = process.env.LLV_TTS_BACKEND?.trim().toLowerCase();
  if (isTtsBackend(env)) return env;
  const saved = readFile("tts-backend")?.toLowerCase();
  return isTtsBackend(saved) ? saved : "openai";
}

export function writeTtsBackend(backend: TtsBackend): void {
  const file = configFilePath("tts-backend");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${backend}\n`);
}

export function readOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || readFile("openai-api-key");
}

export function readFishAudioApiKey(): string | null {
  return process.env.FISH_AUDIO_API_KEY?.trim() || readFile("fishaudio-api-key");
}

export function writeFishAudioModel(model: FishAudioModel): void {
  const file = configFilePath("tts-model-fishaudio");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${model}\n`);
}

export function ttsBackendInfo(now = Date.now()): TtsBackendInfo {
  const fishModelEnv = process.env.LLV_TTS_FISHAUDIO_MODEL?.trim();
  const fishModel = fishModelEnv || readFile("tts-model-fishaudio");
  const env = process.env.LLV_TTS_BACKEND?.trim().toLowerCase();
  const options: TtsBackendOption[] = [
    {
      id: "openai",
      available: readOpenAiApiKey() !== null,
      keyPath: configFilePath("openai-api-key"),
      model: process.env.LLV_TTS_OPENAI_MODEL?.trim() || readFile("tts-model-openai") || "gpt-4o-mini-tts",
      voice: process.env.LLV_TTS_OPENAI_VOICE?.trim() || readFile("tts-voice-openai") || "alloy",
      cap: 4000,
    },
    {
      id: "elevenlabs",
      available: readElevenLabsApiKey() !== null,
      keyPath: configFilePath("elevenlabs-api-key"),
      model: process.env.LLV_TTS_ELEVENLABS_MODEL?.trim() || readFile("tts-model-elevenlabs") || "eleven_multilingual_v2",
      voice: process.env.LLV_TTS_ELEVENLABS_VOICE?.trim() || readFile("tts-voice-elevenlabs") || "21m00Tcm4TlvDq8ikWAM",
      cap: 4000,
    },
    {
      id: "soniox",
      available: readSonioxApiKey() !== null,
      keyPath: configFilePath("soniox-api-key"),
      model: process.env.LLV_TTS_SONIOX_MODEL?.trim() || readFile("tts-model-soniox") || "tts-rt-v2",
      voice: process.env.LLV_TTS_SONIOX_VOICE?.trim() || readFile("tts-voice-soniox") || "Adrian",
      language: process.env.LLV_TTS_SONIOX_LANGUAGE?.trim() || readFile("tts-language-soniox") || "en",
      cap: 4000,
    },
    {
      id: "fishaudio",
      available: readFishAudioApiKey() !== null,
      keyPath: configFilePath("fishaudio-api-key"),
      model: isFishAudioModel(fishModel) ? fishModel : "s2.1-pro-free",
      modelLockedByEnv: Boolean(fishModelEnv),
      voice: process.env.LLV_TTS_FISHAUDIO_VOICE?.trim() || readFile("tts-voice-fishaudio") || "default",
      cap: 4000,
      freeUntil: FISH_AUDIO_FREE_UNTIL,
      freeEnded: fishAudioFreeEnded(now),
    },
  ];
  const routes = Object.fromEntries((["uk", "ru", "en"] as const).map((language) => [language, resolveSpeechRoute(language, options)])) as Record<ProseLanguage, TtsBackendOption>;
  const mode = readFile("tts-by-language");
  return {
    backend: resolveTtsBackend(),
    lockedByEnv: isTtsBackend(env),
    options,
    routes,
    byLanguage: !isTtsBackend(env) && (mode === "on" || (mode !== "off" && Object.values(routes).every((option) => option.available))),
  };
}

export function activeTtsOption(): TtsBackendOption {
  const info = ttsBackendInfo();
  return info.options.find((option) => option.id === info.backend)!;
}

const DEFAULT_SPEECH_ROUTES: Record<ProseLanguage, string> = {
  uk: "soniox",
  ru: "fishaudio s2.1-pro 0c7fd46820854a9e8c4010d911687b7a",
  en: "fishaudio s2.1-pro 536d3a5e000945adb7038665781a4aca",
};

function parseSpeechRoute(line: string | null): { provider: TtsBackend; model?: string; voice?: string } | null {
  if (!line) return null;
  const [provider, model, voice, extra] = line.trim().split(/\s+/u);
  if (!isTtsBackend(provider) || extra !== undefined || (provider === "fishaudio" && model && model !== "-" && !isFishAudioModel(model))) return null;
  return { provider, model: model === "-" ? undefined : model, voice: voice === "-" ? undefined : voice };
}

function resolveSpeechRoute(language: ProseLanguage, options: TtsBackendOption[]): TtsBackendOption {
  const route = parseSpeechRoute(process.env[`LLV_TTS_ROUTE_${language.toUpperCase()}`]?.trim() ?? null)
    ?? parseSpeechRoute(readFile(`tts-route-${language}`))
    ?? parseSpeechRoute(DEFAULT_SPEECH_ROUTES[language])!;
  const base = options.find((option) => option.id === route.provider)!;
  const voice = route.voice ?? base.voice;
  return { ...base, model: route.model ?? base.model, voice,
    language: base.id === "soniox" ? language : base.language,
    voiceName: base.id === "fishaudio" ? FISH_AUDIO_VOICE_NAMES[voice] : undefined };
}

export function writeTtsByLanguage(on: boolean): void {
  const file = configFilePath("tts-by-language");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${on ? "on" : "off"}\n`);
}

export function ttsOptionFor(language: ProseLanguage | undefined, text: string): TtsBackendOption {
  const info = ttsBackendInfo();
  return info.byLanguage ? info.routes[language ?? speechLanguage(text)] : info.options.find((option) => option.id === info.backend)!;
}
