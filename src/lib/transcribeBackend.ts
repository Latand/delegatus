import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCodexAuth } from "@/lib/codexAuth";
import { configFilePath } from "@/lib/configDir";
import { localWhisperReady, whisperPythonPath } from "@/lib/transcribe/local";

export type TranscribeBackend = "local" | "chatgpt" | "elevenlabs" | "soniox";

export const TRANSCRIBE_BACKENDS: readonly TranscribeBackend[] = ["local", "chatgpt", "elevenlabs", "soniox"];

export function isTranscribeBackend(value: unknown): value is TranscribeBackend {
  return typeof value === "string" && (TRANSCRIBE_BACKENDS as readonly string[]).includes(value);
}

/**
 * Which transcription path handles dictation. The default is the fully local
 * faster-whisper engine, which carries no third-party terms. The cloud paths
 * (ChatGPT, ElevenLabs Scribe, Soniox) turn on via the `LLV_TRANSCRIBE_BACKEND` env
 * (highest priority, locks the UI selector) or via the override file the mic
 * right-click menu writes.
 */
export function resolveTranscribeBackend(): TranscribeBackend {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  if (isTranscribeBackend(env)) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("transcribe-backend"), "utf8").trim().toLowerCase();
    if (isTranscribeBackend(fileValue)) return fileValue;
  } catch {
    /* no override file: stay on the local default */
  }
  return "local";
}

/** Write a config file at mode 600 through a temp file and a rename, so a
    reader never sees half of it and an older, wider file keeps no mode. */
function writePrivateConfigFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Persists the mic-menu choice; the env override, when set, still wins. */
export function writeTranscribeBackend(backend: TranscribeBackend): void {
  writePrivateConfigFile(configFilePath("transcribe-backend"), backend + "\n");
}

export type LiveTranscribeProvider = "elevenlabs" | "soniox";

export const LIVE_KEY_ENV: Record<LiveTranscribeProvider, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  soniox: "SONIOX_API_KEY",
};

/** Where a live provider's key comes from right now: the variable wins over
    the file, exactly as the readers below resolve it. */
export function liveKeySource(provider: LiveTranscribeProvider): "env" | "file" | null {
  if (process.env[LIVE_KEY_ENV[provider]]?.trim()) return "env";
  return (provider === "soniox" ? readSonioxApiKey() : readElevenLabsApiKey()) ? "file" : null;
}

/**
 * Write a live provider's key to the file its reader reads on every request
 * (#2004): mode 600, never logged, never read back by any route. The caller
 * has already refused a key the environment supplies.
 */
export function writeTranscribeKey(provider: LiveTranscribeProvider, key: string): void {
  writePrivateConfigFile(configFilePath(`${provider}-api-key`), key + "\n");
}

export interface TranscribeBackendOption {
  id: TranscribeBackend;
  /** The credential/setup this backend needs is present on this machine. */
  available: boolean;
  /** Where the missing credential must go — shown copyable in the key popup. */
  keyPath: string;
  /** For the live backends: whether the key comes from the environment or
      the file, or is absent. Never the key itself. */
  keySource?: "env" | "file" | null;
}

export interface TranscribeBackendInfo {
  backend: TranscribeBackend;
  /** "env" locks the selector: the file override cannot beat the variable. */
  lockedByEnv: boolean;
  options: TranscribeBackendOption[];
}

export function transcribeBackendInfo(): TranscribeBackendInfo {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  return {
    backend: resolveTranscribeBackend(),
    lockedByEnv: isTranscribeBackend(env),
    options: [
      { id: "local", available: localWhisperReady(), keyPath: whisperPythonPath() },
      { id: "chatgpt", available: readCodexAuth() !== null, keyPath: codexAuthPath() },
      { id: "elevenlabs", available: readElevenLabsApiKey() !== null, keyPath: configFilePath("elevenlabs-api-key"), keySource: liveKeySource("elevenlabs") },
      { id: "soniox", available: readSonioxApiKey() !== null, keyPath: configFilePath("soniox-api-key"), keySource: liveKeySource("soniox") },
    ],
  };
}

/** Mirrors readCodexAuth()'s fixed location. */
function codexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/** Read at request time so a key drop-in works without a server restart. */
export function readElevenLabsApiKey(): string | null {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("elevenlabs-api-key"), "utf8").trim();
    return fileValue || null;
  } catch {
    return null;
  }
}

/** Same read-at-request-time contract as the ElevenLabs key, one file over. */
export function readSonioxApiKey(): string | null {
  const env = process.env.SONIOX_API_KEY?.trim();
  if (env) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("soniox-api-key"), "utf8").trim();
    return fileValue || null;
  } catch {
    return null;
  }
}
