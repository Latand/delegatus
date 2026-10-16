import fs from "node:fs";

import { openRouterKeyPath, writeOpenRouterApiKey } from "@/lib/asks/settings";
import { configFilePath } from "@/lib/configDir";
import { telegramBotTokenPath, withStoredBotToken } from "@/lib/telegram/bot/transport";
import { writeTranscribeKey } from "@/lib/transcribeBackend";
import { writePrivate } from "@/lib/voiceCompanion/storage";

import {
  exportHeader, KEY_IDS, KEY_VARIABLE, maskKey, parseKeyLines, validKeyValue,
  type ImportConfirmation, type ImportPreview, type ImportRow, type KeyEntry, type KeyId, type KeySource,
} from "./shared";

/*
 * The «Keys» catalog (docs/design/keys-settings.md §3, storage option S1):
 * one table over the files and variables every reader already uses. A key
 * stays where it is; each one is read the way its own reader reads it (the
 * variable wins, then the file, at the moment of the call) and written by the
 * writer that wrote it before. Fish Audio had none and gets the same private
 * atomic write. Nothing here logs or throws a value.
 */

type FileKey = Exclude<KeyId, "telegram">;

/* The file each reader resolves, at call time, through the same config-dir fallback. */
const KEY_FILE: Record<FileKey, () => string> = {
  openrouter: openRouterKeyPath,
  openai: () => configFilePath("openai-api-key"),
  elevenlabs: () => configFilePath("elevenlabs-api-key"),
  soniox: () => configFilePath("soniox-api-key"),
  fishaudio: () => configFilePath("fishaudio-api-key"),
};

/* The writer each key had: OpenRouter's atomic 0600 write, the dictation route's, the voice companion's. */
const KEY_WRITER: Record<FileKey, (value: string) => void> = {
  openrouter: (value) => { if (!writeOpenRouterApiKey(value)) throw new Error("write_failed"); },
  openai: (value) => writePrivate(configFilePath("openai-api-key"), `${value}\n`),
  elevenlabs: (value) => writeTranscribeKey("elevenlabs", value),
  soniox: (value) => writeTranscribeKey("soniox", value),
  fishaudio: (value) => writePrivate(configFilePath("fishaudio-api-key"), `${value}\n`),
};

export interface KeyReading { source: KeySource; value: string | null }

/** The bot token goes through the existing connect, which asks Telegram who the bot is and records its id. */
type TelegramConnect = (token: string) => Promise<void>;
const productionConnect: TelegramConnect = async (token) => {
  const { telegramBotService } = await import("@/lib/telegram/bot/service");
  await telegramBotService().connect(token);
};
let connectTelegram: TelegramConnect = productionConnect;

/** Tests only; `null` restores the real connect. */
export function setTelegramConnectForTests(connect: TelegramConnect | null): void {
  connectTelegram = connect ?? productionConnect;
}

export function readKey(id: KeyId, env: Readonly<Record<string, string | undefined>> = process.env): KeyReading {
  if (id === "telegram") {
    try {
      const token = withStoredBotToken((value) => value);
      if (token) return { source: "file", value: token };
      return fs.existsSync(telegramBotTokenPath()) ? { source: "failed", value: null } : { source: "missing", value: null };
    } catch {
      return { source: "failed", value: null };
    }
  }
  const fromEnv = env[KEY_VARIABLE[id]]?.trim();
  if (fromEnv) return { source: "env", value: fromEnv };
  try {
    const value = fs.readFileSync(KEY_FILE[id](), "utf8").trim();
    return value ? { source: "file", value } : { source: "missing", value: null };
  } catch (error) {
    /* A missing file is an unset key, as every reader has it; anything else is a file that is there and cannot be read. */
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { source: "missing", value: null } : { source: "failed", value: null };
  }
}

/** Every key's state; the masked form only for the owner. */
export function keyEntries(owner: boolean): KeyEntry[] {
  return KEY_IDS.map((id) => {
    const { source, value } = readKey(id);
    return { id, variable: KEY_VARIABLE[id], source, masked: owner && value ? maskKey(id, value) : null };
  });
}

export type WriteOutcome = "ok" | "invalid" | "env" | "failed" | "telegram_refused";

/** Writes one key through its own writer. A key the variable sets is never written: the variable would still win. */
export async function writeKey(id: KeyId, raw: string): Promise<WriteOutcome> {
  const value = raw.trim();
  if (!validKeyValue(id, value)) return "invalid";
  if (readKey(id).source === "env") return "env";
  if (id === "telegram") {
    try { await connectTelegram(value); return "ok"; }
    catch { return "telegram_refused"; }
  }
  try { KEY_WRITER[id](value); return "ok"; }
  catch { return "failed"; }
}

/** «Copy all keys»: one NAME=value line per set key, the variable-set ones included. */
export function exportKeys(now: Date): { text: string; count: number; omitted: KeyId[] } {
  const lines: string[] = [];
  const omitted: KeyId[] = [];
  for (const id of KEY_IDS) {
    const { value } = readKey(id);
    if (!value) continue;
    /* A value with a space or a control character would not read back as one line: it is left out and named. */
    if (!/^[\x21-\x7e]+$/.test(value)) { omitted.push(id); continue; }
    lines.push(`${KEY_VARIABLE[id]}=${value}`);
  }
  return { text: [exportHeader(lines.length, now), ...lines].join("\n") + "\n", count: lines.length, omitted };
}

type PlannedRow = ImportRow & { value?: string };

function plan(text: string): { rows: PlannedRow[]; unknown: string[]; unparsed: number[] } {
  const parsed = parseKeyLines(text);
  const rows = parsed.entries.map(({ id, value }): PlannedRow => {
    if (!validKeyValue(id, value)) return { id, kind: "invalid" };
    const masked = maskKey(id, value);
    const here = readKey(id);
    if (here.source === "env") return { id, kind: "env", masked };
    if (here.value === value) return { id, kind: "same", masked };
    if (here.source === "file") return { id, kind: "replaces", masked, was: maskKey(id, here.value!), value };
    if (here.source === "failed") return { id, kind: "replaces", masked, was: null, value };
    return { id, kind: "new", masked, value };
  });
  return { rows, unknown: parsed.unknown, unparsed: parsed.unparsed };
}

/** What an import would do, masked: the page shows it before anything is written. */
export function previewImport(text: string): ImportPreview {
  const { rows, unknown, unparsed } = plan(text);
  return { rows: rows.map(({ value: _value, ...row }) => row), unknown, unparsed };
}

export interface ImportOutcome {
  saved: KeyId[];
  /** Not written because what the operator confirmed no longer matches this machine (or was never confirmed). */
  unconfirmed: KeyId[];
  failed: { id: KeyId; reason: WriteOutcome }[];
}

/**
 * Writes the keys the operator confirmed, and only while each still matches
 * what the preview showed: the same kind, and for a replacement the same key
 * being replaced. A key set or changed since the preview is left alone.
 */
export async function applyImport(text: string, confirm: ImportConfirmation): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { saved: [], unconfirmed: [], failed: [] };
  for (const id of KEY_IDS) {
    /* Re-planned per key, right before its write: an earlier write (the bot's connect awaits Telegram) may have changed this machine. */
    const row = plan(text).rows.find((candidate) => candidate.id === id);
    if (!row || (row.kind !== "new" && row.kind !== "replaces")) continue;
    const confirmed = confirm[id];
    if (!confirmed || confirmed.kind !== row.kind || (row.kind === "replaces" && (confirmed.was ?? null) !== (row.was ?? null))) {
      outcome.unconfirmed.push(id);
      continue;
    }
    const result = await writeKey(id, row.value!);
    if (result === "ok") outcome.saved.push(id);
    else outcome.failed.push({ id, reason: result });
  }
  return outcome;
}
