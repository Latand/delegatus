import fs from "node:fs";

import { configFilePath } from "@/lib/configDir";
import { KEY_VARIABLE, type KeyId, type KeySource } from "./shared";

export type ApiKeyId = Exclude<KeyId, "telegram">;
export interface KeyReading { source: KeySource; value: string | null }

const KEY_FILE: Record<ApiKeyId, string> = {
  openrouter: "openrouter-api-key",
  openai: "openai-api-key",
  elevenlabs: "elevenlabs-api-key",
  soniox: "soniox-api-key",
  fishaudio: "fishaudio-api-key",
};

/** Reads at dispatch time, without loading key writers or connection services. */
export function readApiKey(id: ApiKeyId, env: Readonly<Record<string, string | undefined>> = process.env): KeyReading {
  const fromEnv = env[KEY_VARIABLE[id]]?.trim();
  if (fromEnv) return { source: "env", value: fromEnv };
  try {
    const value = fs.readFileSync(configFilePath(KEY_FILE[id]), "utf8").trim();
    return value ? { source: "file", value } : { source: "missing", value: null };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { source: "missing", value: null } : { source: "failed", value: null };
  }
}
