import fs from "node:fs";
import path from "node:path";

import { FISH_AUDIO_FREE_UNTIL, fishAudioFreeEnded, isFishAudioModel, type FishAudioModel } from "@/lib/fishAudio";
import { withWaitCorrelation } from "@/lib/blockingWaits";
import { configFilePath } from "@/lib/configDir";
import { withFileTransaction, withFileTransactionSync } from "@/lib/state/fileTransaction";
import { readElevenLabsApiKey, readSonioxApiKey } from "@/lib/transcribeBackend";

export type TtsBackend = "openai" | "elevenlabs" | "soniox" | "fishaudio";
export const TTS_BACKENDS: readonly TtsBackend[] = ["openai", "elevenlabs", "soniox", "fishaudio"];

export interface TtsBackendOption {
  id: TtsBackend;
  available: boolean;
  keyPath: string;
  model: string;
  voice: string;
  voiceLockedByEnv?: boolean;
  voiceList: boolean;
  cap: number;
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

/* Each choice is written under its file's lock, which an install transfer
   holds while it writes the same file, so the two never interleave. */
function writeChoice(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileTransactionSync(file, "the voice settings are busy", () => fs.writeFileSync(file, text));
}

// Keep the synchronous APIs for transfer/CLI callers. Serving writes yield
// during contention, using the same queue, owner recovery and commit body.
function writeChoiceAsync(file: string, text: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withWaitCorrelation({ label: "voice-settings.write" }, () =>
    withFileTransaction(file, "the voice settings are busy", () => fs.writeFileSync(file, text)));
}

export function writeTtsBackendAsync(backend: TtsBackend): Promise<void> {
  return writeChoiceAsync(configFilePath("tts-backend"), `${backend}\n`);
}

export function writeFishAudioModelAsync(model: FishAudioModel): Promise<void> {
  return writeChoiceAsync(configFilePath("tts-model-fishaudio"), `${model}\n`);
}

export function writeTtsVoiceAsync(backend: TtsBackend, voice: string): Promise<void> {
  if (!isTtsVoiceId(voice)) return Promise.reject(new Error("invalid voice id"));
  return writeChoiceAsync(configFilePath(`tts-voice-${backend}`), `${voice}\n`);
}

export function writeTtsBackend(backend: TtsBackend): void {
  writeChoice(configFilePath("tts-backend"), `${backend}\n`);
}

export function readOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || readFile("openai-api-key");
}

export function readFishAudioApiKey(): string | null {
  return process.env.FISH_AUDIO_API_KEY?.trim() || readFile("fishaudio-api-key");
}

export function writeFishAudioModel(model: FishAudioModel): void {
  writeChoice(configFilePath("tts-model-fishaudio"), `${model}\n`);
}

export function isTtsVoiceId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 128 && !/[\p{Cc}\p{Zl}\p{Zp}]|[^\S ]/u.test(value);
}

export function writeTtsVoice(backend: TtsBackend, voice: string): void {
  if (!isTtsVoiceId(voice)) throw new Error("invalid voice id");
  writeChoice(configFilePath(`tts-voice-${backend}`), `${voice}\n`);
}

export function ttsBackendInfo(now = Date.now()): TtsBackendInfo {
  const fishModelEnv = process.env.LLV_TTS_FISHAUDIO_MODEL?.trim();
  const fishModel = fishModelEnv || readFile("tts-model-fishaudio");
  const env = process.env.LLV_TTS_BACKEND?.trim().toLowerCase();
  return {
    backend: resolveTtsBackend(),
    lockedByEnv: isTtsBackend(env),
    options: [
      {
        id: "openai",
        voiceList: false,
        voiceLockedByEnv: Boolean(process.env.LLV_TTS_OPENAI_VOICE?.trim()),
        available: readOpenAiApiKey() !== null,
        keyPath: configFilePath("openai-api-key"),
        model: process.env.LLV_TTS_OPENAI_MODEL?.trim() || readFile("tts-model-openai") || "gpt-4o-mini-tts",
        voice: process.env.LLV_TTS_OPENAI_VOICE?.trim() || readFile("tts-voice-openai") || "alloy",
        cap: 4000,
      },
      {
        id: "elevenlabs",
        voiceList: true,
        voiceLockedByEnv: Boolean(process.env.LLV_TTS_ELEVENLABS_VOICE?.trim()),
        available: readElevenLabsApiKey() !== null,
        keyPath: configFilePath("elevenlabs-api-key"),
        model: process.env.LLV_TTS_ELEVENLABS_MODEL?.trim() || readFile("tts-model-elevenlabs") || "eleven_v4_turbo",
        voice: process.env.LLV_TTS_ELEVENLABS_VOICE?.trim() || readFile("tts-voice-elevenlabs") || "JBFqnCBsd6RMkjVDRZzb",
        cap: 4000,
      },
      {
        id: "soniox",
        voiceList: true,
        voiceLockedByEnv: Boolean(process.env.LLV_TTS_SONIOX_VOICE?.trim()),
        available: readSonioxApiKey() !== null,
        keyPath: configFilePath("soniox-api-key"),
        model: process.env.LLV_TTS_SONIOX_MODEL?.trim() || readFile("tts-model-soniox") || "tts-rt-v2",
        voice: process.env.LLV_TTS_SONIOX_VOICE?.trim() || readFile("tts-voice-soniox") || "Adrian",
        language: process.env.LLV_TTS_SONIOX_LANGUAGE?.trim() || readFile("tts-language-soniox") || "en",
        cap: 4000,
      },
      {
        id: "fishaudio",
        voiceList: true,
        voiceLockedByEnv: Boolean(process.env.LLV_TTS_FISHAUDIO_VOICE?.trim()),
        available: readFishAudioApiKey() !== null,
        keyPath: configFilePath("fishaudio-api-key"),
        model: isFishAudioModel(fishModel) ? fishModel : "s2.1-pro-free",
        modelLockedByEnv: Boolean(fishModelEnv),
        voice: process.env.LLV_TTS_FISHAUDIO_VOICE?.trim() || readFile("tts-voice-fishaudio") || "default",
        cap: 4000,
        freeUntil: FISH_AUDIO_FREE_UNTIL,
        freeEnded: fishAudioFreeEnded(now),
      },
    ],
  };
}

export function activeTtsOption(): TtsBackendOption {
  const info = ttsBackendInfo();
  return info.options.find((option) => option.id === info.backend)!;
}
