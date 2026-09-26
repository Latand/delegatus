import fs from "node:fs";

import { configFilePath, statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";

/*
 * The "Asks you" switch (docs/research/attention-classifier.md §7), one per
 * installation and off until the operator turns it on: while it is on, the
 * last message of an agent's turn leaves the machine for the classifier.
 *
 * The OpenRouter key is read the way the Viewer reads its other provider keys
 * (`readElevenLabsApiKey`): the environment first, then a file in the config
 * directory, at the moment of the call. It is never logged, never returned by
 * a route and never written by one.
 */

export const DEFAULT_ASKS_MONTHLY_CAP_USD = 1;
/** The research measured about USD 0.73 a month for every turn-ending message
    on two machines; a cap this high only guards against a runaway. */
const MAX_ASKS_MONTHLY_CAP_USD = 50;

export interface AsksYouSettings {
  enabled: boolean;
  capUsd: number;
  /** ISO time the switch last changed, or null when it never did. Messages
      older than the moment it turned on are never classified. */
  changedAt: string | null;
}

interface AsksYouSettingsFile {
  schemaVersion: 1;
  enabled?: boolean;
  capUsd?: number;
  changedAt?: string;
}

export function asksYouSettingsFile(): string {
  return statePath("asks-you-settings.json");
}

function validCap(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_ASKS_MONTHLY_CAP_USD ? value : null;
}

/** An absent or malformed file reads as off, with the default cap. */
export function readAsksYouSettings(file = asksYouSettingsFile()): AsksYouSettings {
  let parsed: Partial<AsksYouSettingsFile> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Partial<AsksYouSettingsFile>;
  } catch {
    // off
  }
  return {
    enabled: parsed.schemaVersion === 1 && parsed.enabled === true,
    capUsd: validCap(parsed.capUsd) ?? DEFAULT_ASKS_MONTHLY_CAP_USD,
    changedAt: typeof parsed.changedAt === "string" && Number.isFinite(Date.parse(parsed.changedAt)) ? parsed.changedAt : null,
  };
}

/** The operator's write. False when the file could not be written. */
export function writeAsksYouSettings(
  change: { enabled?: boolean; capUsd?: number },
  now = new Date(),
  file = asksYouSettingsFile(),
): AsksYouSettings | false {
  const current = readAsksYouSettings(file);
  const cap = change.capUsd === undefined ? current.capUsd : validCap(change.capUsd);
  if (cap === null) return false;
  const enabled = change.enabled ?? current.enabled;
  const next: AsksYouSettingsFile = {
    schemaVersion: 1,
    enabled,
    capUsd: cap,
    ...(enabled !== current.enabled ? { changedAt: now.toISOString() } : current.changedAt ? { changedAt: current.changedAt } : {}),
  };
  try {
    writeJsonDurably(file, next);
  } catch {
    return false;
  }
  return readAsksYouSettings(file);
}

export function isAsksMonthlyCap(value: unknown): value is number {
  return validCap(value) !== null;
}

export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

export function openRouterKeyPath(): string {
  return configFilePath("openrouter-api-key");
}

/** Read at the moment of the call, so a key dropped in works without a restart. */
export function readOpenRouterApiKey(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const fromEnv = env[OPENROUTER_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(openRouterKeyPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Where the key comes from right now, never the key. */
export function openRouterKeySource(env: Readonly<Record<string, string | undefined>> = process.env): "env" | "file" | null {
  if (env[OPENROUTER_KEY_ENV]?.trim()) return "env";
  return readOpenRouterApiKey({}) ? "file" : null;
}
