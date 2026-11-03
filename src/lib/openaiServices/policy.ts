import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { configFilePath } from "@/lib/configDir";
import { readApiKey as readKey, type ApiKeyId } from "@/lib/keys/reading";
import { withFileTransactionAsync, withFileTransactionSync } from "@/lib/state/fileTransaction";
import { transcribeBackendInfo, nativeTranscribeBackend, isTranscribeBackend, writeTranscribeBackendAsync, type TranscribeBackend } from "@/lib/transcribeBackend";
import { ttsBackendInfo, nativeTtsBackend, isTtsBackend, writeTtsBackendAsync, type TtsBackend } from "@/lib/ttsBackend";
import { CompanionStorage, type CompanionBackend } from "@/lib/voiceCompanion/storage";
import { localWhisperReady } from "@/lib/transcribe/local";
import { readCodexAuth } from "@/lib/codexAuth";
import { listCodexAccounts } from "@/lib/accounts/codex";

export const SERVICE_FEATURES = ["asks", "memory", "rules", "dictation", "read", "voice"] as const;
export type ServiceFeature = typeof SERVICE_FEATURES[number];
export type ClassifierProvider = "openrouter" | "openai";
type Providers = { asks: ClassifierProvider; memory: ClassifierProvider; rules: ClassifierProvider; dictation: TranscribeBackend; read: TtsBackend; voice: CompanionBackend };
export interface ServiceResolution<P extends string = string> {
  feature: ServiceFeature;
  requested: P;
  effective: P;
  held: boolean;
  available: boolean;
  lockedBy: string | null;
  /** Dispatch only. Never include this field in a route answer. */
  apiKey: string | null;
}
type Choices = { version: 1; openai: Partial<Record<ServiceFeature, { since: string }>> };
let warned = false;
function readChoices(): Choices {
  try {
    const file = configFilePath("openai-services.json");
    if (fs.statSync(file).size > 16 * 1024) throw Error("oversized");
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    if (body?.version !== 1 || !body.openai || typeof body.openai !== "object" || Array.isArray(body.openai)
      || Object.entries(body.openai).some(([feature, row]) => !isServiceFeature(feature) || !row || typeof row !== "object"
        || typeof (row as { since?: unknown }).since !== "string" || !Number.isFinite(Date.parse((row as { since: string }).since)))) throw Error("invalid");
    return body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !warned) { warned = true; console.warn("[openai-services] unreadable"); }
    return { version: 1, openai: {} };
  }
}
export function isServiceFeature(value: unknown): value is ServiceFeature {
  return typeof value === "string" && (SERVICE_FEATURES as readonly string[]).includes(value);
}
const openaiProvider = (feature: ServiceFeature) => feature === "voice" ? "api" : "openai";

function baseline(feature: ServiceFeature, voiceBaseline?: CompanionBackend): { provider: string; lockedBy: string | null } {
  if (feature === "read") return { provider: nativeTtsBackend(), lockedBy: isTtsBackend(process.env.LLV_TTS_BACKEND?.trim().toLowerCase()) ? "LLV_TTS_BACKEND" : null };
  if (feature === "dictation") return { provider: nativeTranscribeBackend(), lockedBy: isTranscribeBackend(process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase()) ? "LLV_TRANSCRIBE_BACKEND" : null };
  if (feature === "voice") return { provider: voiceBaseline ?? new CompanionStorage().nativeBackend(), lockedBy: null };
  return { provider: "openrouter", lockedBy: null };
}
function serviceOptions(feature: ServiceFeature): { id: string; available: boolean }[] {
  if (feature === "read") return ttsBackendInfo(Date.now(), true).options;
  if (feature === "dictation") return transcribeBackendInfo(true).options;
  if (feature === "voice") return [{ id: "codex", available: codexVoiceAvailable() }, { id: "api", available: !!readKey("openai").value }];
  return ["openrouter", "openai"].map(id => ({ id, available: !!readKey(id as ApiKeyId).value }));
}
function codexVoiceAvailable(): boolean { return listCodexAccounts().some(account => account.kind === "managed" && account.authPresent); }
export function resolveService<F extends ServiceFeature>(feature: F, options: { voiceBaseline?: CompanionBackend } = {}): ServiceResolution<Providers[F]> {
  const native = baseline(feature, options.voiceBaseline);
  const openai = readKey("openai");
  const opted = !native.lockedBy && !!readChoices().openai[feature];
  const requested = opted ? openaiProvider(feature) : native.provider;
  const held = opted && !openai.value;
  const effective = opted && openai.value ? openaiProvider(feature) : native.provider;
  const keyId = effective === "api" ? "openai" : effective;
  const apiKey = keyId === "openai" ? openai.value : ["openrouter", "elevenlabs", "soniox", "fishaudio"].includes(keyId) ? readKey(keyId as ApiKeyId).value : null;
  return { feature, requested, effective, held, lockedBy: native.lockedBy,
    available: effective === "local" ? localWhisperReady() : effective === "chatgpt" ? readCodexAuth() !== null : effective === "codex" ? codexVoiceAvailable() : !!apiKey,
    apiKey } as ServiceResolution<Providers[F]>;
}

export function serviceState(feature: ServiceFeature) {
  const { apiKey: _secret, ...state } = resolveService(feature);
  const options = serviceOptions(feature).slice().sort((a, b) => Number(a.id === openaiProvider(feature)) - Number(b.id === openaiProvider(feature)))
    .map(({ id, available }) => ({ id, available }));
  return { ...state, options };
}
export function servicesView() {
  return { openaiKey: readKey("openai").source, features: SERVICE_FEATURES.map(serviceState) };
}
export class ServiceChoiceError extends Error {
  constructor(readonly code: "invalid_provider" | "locked_by_env" | "unavailable") { super(code); }
}

function choice(feature: ServiceFeature, provider: string, legacy: boolean): boolean | null {
  const state = serviceState(feature);
  const option = state.options.find(row => row.id === provider);
  if (!option) throw new ServiceChoiceError("invalid_provider");
  if (state.lockedBy) throw new ServiceChoiceError("locked_by_env");
  if (!legacy && !option.available) {
    if (provider === state.requested) return null;
    throw new ServiceChoiceError("unavailable");
  }
  return provider === openaiProvider(feature) && !!readKey("openai").value;
}
function saveChoice(file: string, feature: ServiceFeature, opted: boolean) {
  const choices = readChoices();
  if (opted) choices.openai[feature] ??= { since: new Date().toISOString() };
  else delete choices.openai[feature];
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(choices) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
/** All selector routes serialize the baseline write and opt-in change here. */
export async function chooseService(feature: ServiceFeature, provider: string, options: { legacy?: boolean } = {}): Promise<void> {
  const file = configFilePath("openai-services.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withFileTransactionAsync(file, "the provider settings are busy", async () => {
    const opted = choice(feature, provider, options.legacy === true);
    if (opted === null) return;
    if (!opted) {
      if (feature === "read") await writeTtsBackendAsync(provider as TtsBackend);
      if (feature === "dictation") await writeTranscribeBackendAsync(provider as TranscribeBackend);
      if (feature === "voice") await new CompanionStorage().writeNativeBackendAsync(provider as CompanionBackend);
    }
    saveChoice(file, feature, opted);
  });
}
/** The existing synchronous storage/CLI API uses the same policy and lock. */
export function chooseVoiceService(provider: CompanionBackend, writeNative: () => void): void {
  const file = configFilePath("openai-services.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileTransactionSync(file, "the provider settings are busy", () => {
    const opted = choice("voice", provider, true);
    if (opted === null) return;
    if (!opted) writeNative();
    saveChoice(file, "voice", opted);
  });
}
