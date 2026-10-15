import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import type { LegacyImportHooks, LegacyImportOutcome } from "@/lib/state/legacyImport";
import { LegacyDocumentStore } from "@/lib/state/legacyDocumentStore";

import {
  MAX_OPERATOR_MESSAGE_KEY_CHARS,
  REPLY_SUGGESTION_ADMISSION_CAPACITY,
  REPLY_SUGGESTIONS_SCHEMA_VERSION,
  type ReplySuggestionAdmissionV1,
  type ReplySuggestionsFileV1,
} from "./types";

/**
 * The durable record of operator message admissions (see `./types`): a
 * collection in `state.sqlite` written under its lease since #1870 slice 5,
 * so a receipt survives a viewer restart and two callers racing.
 *
 * A damaged file reads as an empty record instead of raising: forgetting a
 * message's admission costs a replay window, never the send that records it.
 */

const BUSY = "reply suggestions are busy";

export function replySuggestionsFile(): string {
  return statePath("reply-suggestions.json");
}

function emptyFile(now: Date): ReplySuggestionsFileV1 {
  return {
    schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    admissions: [],
  };
}

function parseAdmission(value: unknown): ReplySuggestionAdmissionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const admission = value as Record<string, unknown>;
  if (typeof admission.conversationId !== "string" || !admission.conversationId) return null;
  if (typeof admission.key !== "string" || !admission.key) return null;
  if (typeof admission.at !== "string" || !Number.isFinite(Date.parse(admission.at))) return null;
  return { conversationId: admission.conversationId, key: admission.key, at: admission.at };
}

/** Validate a parsed record. Anything unreadable — a record from a schema this
    build does not know, an admission that fails its shape — reads as empty,
    which the next write replaces wholesale. A record's `sets` (reply drafts an
    older release stored) are not read. */
function parseSuggestionsBody(raw: unknown, now: Date): ReplySuggestionsFileV1 {
  const parsed = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<ReplySuggestionsFileV1>;
  if (parsed.schemaVersion !== REPLY_SUGGESTIONS_SCHEMA_VERSION) return emptyFile(now);
  return {
    schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) ? parsed.revision! : 0,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
    /* Absent in a record written before admissions existed, and absent again
       the moment one is unreadable: forgetting a message's admission costs a
       replay window, never the read. */
    admissions: Array.isArray(parsed.admissions)
      ? parsed.admissions.map(parseAdmission).filter((entry): entry is ReplySuggestionAdmissionV1 => entry !== null)
      : [],
  };
}

/** `reply-suggestions.json` as the store read it before #1870, for a release
    that may not import yet. A missing or truncated file is an empty record. */
function readLegacySuggestionsFile(filePath: string, now: Date): ReplySuggestionsFileV1 {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    return emptyFile(now);
  }
  try {
    return parseSuggestionsBody(JSON.parse(contents) as unknown, now);
  } catch {
    return emptyFile(now);
  }
}

const META_KEY = "meta";
type SuggestionsMeta = Pick<ReplySuggestionsFileV1, "schemaVersion" | "revision" | "updatedAt">;
const admissionKey = (admission: ReplySuggestionAdmissionV1) => `a:${admission.conversationId}\0${admission.key}`;

/**
 * The record in `state.sqlite` (#1870 slice 5): a `meta` row with the record's
 * revision and one `a:<conversation>\0<key>` row per admission receipt, oldest
 * first. The `s:<conversation>` rows an older release wrote for reply drafts
 * are not read, and a write leaves them out, which deletes them.
 */
const suggestionsStore = new LegacyDocumentStore<ReplySuggestionsFileV1>({
  collection: "reply_suggestions",
  migrationId: "reply-suggestions-json-v1",
  busyMessage: BUSY,
  parse: (raw) => parseSuggestionsBody(raw, new Date()),
  toRows: (file) => {
    /* One row per key: duplicate receipts collapse. */
    const admissions = file.admissions.filter((entry, index) =>
      file.admissions.findLastIndex((other) => admissionKey(other) === admissionKey(entry)) === index);
    return [
      { key: META_KEY, value: { schemaVersion: file.schemaVersion, revision: file.revision, updatedAt: file.updatedAt } satisfies SuggestionsMeta },
      ...admissions.map((admission) => ({ key: admissionKey(admission), value: admission })),
    ];
  },
  fromRows: (rows) => {
    const meta = rows.find((row) => row.key === META_KEY)?.value as SuggestionsMeta | undefined;
    return {
      schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
      revision: meta?.revision ?? 0,
      updatedAt: meta?.updatedAt ?? "",
      admissions: rows.filter((row) => row.key.startsWith("a:")).map((row) => row.value as ReplySuggestionAdmissionV1),
    };
  },
  /* A release that predates #1870 reads the file as empty without a `sets`
     array, admissions included. */
  toFile: (file) => ({ ...file, sets: [] }),
  mergeRow: (key, held, incoming) => {
    if (key !== META_KEY) return undefined;
    const [ours, theirs] = [held as SuggestionsMeta, incoming as SuggestionsMeta];
    return theirs.revision > ours.revision ? theirs : ours;
  },
  readLegacy: (filePath) => readLegacySuggestionsFile(filePath, new Date()),
  error: (message, cause) => new Error(message, { cause }),
});

/** The store's legacy import spec, for the import driver and its tests. */
export function replySuggestionsLegacyCollection(filePath = replySuggestionsFile()) {
  return suggestionsStore.legacyCollection(filePath);
}

/** Import `reply-suggestions.json` into SQLite now (the Viewer's activation). */
export function importLegacyReplySuggestions(
  filePath = replySuggestionsFile(),
  options: { reconcile: boolean; hooks?: LegacyImportHooks } = { reconcile: true },
): LegacyImportOutcome {
  return suggestionsStore.importLegacy(filePath, options);
}

/** Write `reply-suggestions.json` from SQLite for a rollback release that predates #1870. */
export function checkpointReplySuggestionsRollbackMirrorForDemotion(filePath = replySuggestionsFile()): void {
  suggestionsStore.checkpointRollbackMirror(filePath);
}

/** The persisted record, oldest admission first. */
export function readReplySuggestionsFile(filePath = replySuggestionsFile(), now = new Date()): ReplySuggestionsFileV1 {
  const file = suggestionsStore.read(filePath);
  return file.updatedAt ? file : { ...file, updatedAt: now.toISOString() };
}

/**
 * Remember when the operator's message to this conversation was first
 * admitted. Called from the send paths themselves, whether or not a feed is
 * mounted.
 *
 * `messageKey` is the send path's idempotency key. A client re-delivering the
 * same message under it is not a second message: the first admission is kept
 * and the replay records nothing. A message without a key records nothing.
 * Answers whether a receipt was written.
 *
 * Never throws: a message the operator sent must land even when this record
 * cannot be written.
 */
export function recordOperatorMessageAdmission(conversationId: string, at: Date, messageKey = ""): boolean {
  const key = messageKey.trim().slice(0, MAX_OPERATOR_MESSAGE_KEY_CHARS);
  if (!conversationId || !key) return false;
  const now = new Date();
  try {
    return suggestionsStore.mutate(replySuggestionsFile(), (current) => {
      if (current.admissions.some((entry) => entry.conversationId === conversationId && entry.key === key)) {
        return { next: undefined, result: false };
      }
      return {
        next: {
          schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
          revision: current.revision + 1,
          /* The record's own write clock, not the message's. */
          updatedAt: now.toISOString(),
          admissions: [...current.admissions, { conversationId, key, at: at.toISOString() }].slice(-REPLY_SUGGESTION_ADMISSION_CAPACITY),
        } satisfies ReplySuggestionsFileV1,
        result: true,
      };
    });
  } catch {
    return false;
  }
}
