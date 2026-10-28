import fs from "node:fs";
import path from "node:path";

import { cachedJsonFile } from "@/lib/state/cachedJsonFile";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { statePath } from "@/lib/configDir";
import { FileTransactionBusyError, withFileTransactionSync } from "@/lib/state/fileTransaction";

/*
 * The operator's own settings, installation-wide (docs/design/orchestrator-reports.md §4.2).
 *
 * The interface language used to live only in the browser's storage, so no
 * agent and no server surface could know which language the operator chose.
 * The client now writes it here, and `get_orchestrator`, the seat tick's wake,
 * the MCP session instructions and the report renderer read it. There is one
 * interface language per operator: the last choice wins on every device.
 *
 * The time zone rides along because report headers print the operator's local
 * time, and the host's zone is not necessarily theirs.
 *
 * Same shape as `src/lib/projects/settings.ts`: a file snapshot read and an
 * atomic write. An absent or malformed file reads as nothing set.
 */

export type OperatorLocale = "en" | "uk";
export type OperatorLocaleSource = "chosen" | "detected";

export interface OperatorLocaleSetting {
  value: OperatorLocale;
  /** `chosen` came from the language toggle; `detected` is what a client
      showed before anyone chose. A detected value never replaces a chosen one. */
  source: OperatorLocaleSource;
  changedAt: string;
}

export interface OperatorTimeZoneSetting {
  /** IANA zone name the client reported. */
  value: string;
  changedAt: string;
}

export interface OperatorSettings {
  locale: OperatorLocaleSetting | null;
  timeZone: OperatorTimeZoneSetting | null;
}

interface OperatorSettingsFile {
  schemaVersion: 1;
  locale?: OperatorLocaleSetting;
  timeZone?: OperatorTimeZoneSetting;
}

const cache = cachedJsonFile(decodeSettings);

function settingsFile(): string {
  return statePath("operator-settings.json");
}

export function isOperatorLocale(value: unknown): value is OperatorLocale {
  return value === "en" || value === "uk";
}

/** A zone `Intl` accepts, bounded. Anything else is refused rather than stored. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function localeOf(value: unknown): OperatorLocaleSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isOperatorLocale(record.value) || (record.source !== "chosen" && record.source !== "detected")) return null;
  if (typeof record.changedAt !== "string") return null;
  return { value: record.value, source: record.source, changedAt: record.changedAt };
}

function timeZoneOf(value: unknown): OperatorTimeZoneSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isTimeZone(record.value) || typeof record.changedAt !== "string") return null;
  return { value: record.value, changedAt: record.changedAt };
}

function decodeSettings(raw: string | null): OperatorSettings {
  let settings: OperatorSettings = { locale: null, timeZone: null };
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<OperatorSettingsFile>;
    if (parsed.schemaVersion === 1) settings = { locale: localeOf(parsed.locale), timeZone: timeZoneOf(parsed.timeZone) };
  } catch {
    settings = { locale: null, timeZone: null };
  }
  return settings;
}

export function readOperatorSettings(): OperatorSettings {
  return { ...cache.read(settingsFile()) };
}

/** The operator's interface language, or null until a client has reported it. */
export function operatorLocale(): OperatorLocale | null {
  try {
    return readOperatorSettings().locale?.value ?? null;
  } catch {
    return null;
  }
}

/** The operator's IANA time zone, or null until a client has reported it. */
export function operatorTimeZone(): string | null {
  try {
    return readOperatorSettings().timeZone?.value ?? null;
  } catch {
    return null;
  }
}

function write(settings: OperatorSettings): boolean {
  const file = settingsFile();
  const body: OperatorSettingsFile = {
    schemaVersion: 1,
    ...(settings.locale ? { locale: settings.locale } : {}),
    ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonDurably(file, body);
    cache.invalidate();
    return true;
  } catch {
    return false;
  }
}

export interface OperatorSettingsUpdate {
  locale?: OperatorLocale;
  source?: OperatorLocaleSource;
  timeZone?: string;
}

/**
 * Apply a client's write. A `detected` language never overwrites a `chosen`
 * one: a second device that merely shows its browser's language must not undo
 * the operator's choice. A write that changes nothing keeps its `changedAt`.
 * Null on a failed write.
 */
export function updateOperatorSettings(update: OperatorSettingsUpdate, now: string = new Date().toISOString()): OperatorSettings | null {
  /* Under the file's lock, which an install transfer holds while it writes
     the same file, so neither loses the other's value. */
  try { return withFileTransactionSync(settingsFile(), "operator settings are busy", () => { cache.invalidate(); return updateLocked(update, now); }); }
  catch (error) { if (error instanceof FileTransactionBusyError) return null; throw error; }
}

function updateLocked(update: OperatorSettingsUpdate, now: string): OperatorSettings | null {
  const current = readOperatorSettings();
  const next: OperatorSettings = { ...current };
  let changed = false;
  if (update.locale) {
    const source = update.source ?? "chosen";
    const held = current.locale;
    const blocked = source === "detected" && held?.source === "chosen";
    if (!blocked && (held?.value !== update.locale || held.source !== source)) {
      next.locale = { value: update.locale, source, changedAt: held?.value === update.locale ? held.changedAt : now };
      changed = true;
    }
  }
  if (update.timeZone && current.timeZone?.value !== update.timeZone) {
    next.timeZone = { value: update.timeZone, changedAt: now };
    changed = true;
  }
  if (!changed) return current;
  return write(next) ? readOperatorSettings() : null;
}

export function resetOperatorSettingsForTests(): void {
  cache.invalidate();
}
