import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { smallStore } from "@/lib/state/smallStore";

import { adoptRootSession, mintRootId } from "./lineage";
import { ROOT_LINEAGE_SCHEMA_VERSION, type RootAdoption, type RootLineageV1, type RootRolloverReason, type RootSessionV1 } from "./types";

/**
 * Durable home of the root conversation's identity and rollover chain (#688 D5).
 *
 * Resolved lazily rather than as a module constant, so a sandboxed
 * `LLV_STATE_DIR` set after import still redirects the file — the same reason
 * the orchestrator record resolves its path per call.
 */
export function rootLineageFile(): string {
  return statePath("root-lineage.json");
}

export class RootLineageStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RootLineageStoreError";
  }
}

function isRolloverReason(value: unknown): value is RootRolloverReason {
  return value === "crash" || value === "reboot" || value === "rollover" || value === "fresh";
}

function isSession(value: unknown): value is RootSessionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<RootSessionV1>;
  return (
    typeof session.conversationId === "string" && session.conversationId.length > 0
    && (session.path === null || typeof session.path === "string")
    && typeof session.startedAt === "string"
    && (session.endedAt === undefined || typeof session.endedAt === "string")
    && (session.seededFrom === undefined || typeof session.seededFrom === "string")
    && (session.reason === undefined || isRolloverReason(session.reason))
  );
}

function isLineage(value: unknown): value is RootLineageV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lineage = value as Partial<RootLineageV1>;
  return (
    lineage.schemaVersion === ROOT_LINEAGE_SCHEMA_VERSION
    && typeof lineage.rootId === "string" && lineage.rootId.length > 0
    && Number.isInteger(lineage.revision) && lineage.revision! >= 0
    && typeof lineage.updatedAt === "string"
    && Array.isArray(lineage.sessions) && lineage.sessions.every(isSession)
  );
}

/** Invalid structured records refuse replacement: attention references the
    stable root identity. Torn legacy bytes follow the import helper's
    preserved-gap protocol. */
function parseLineage(raw: unknown): RootLineageV1 {
  if (!isLineage(raw)) throw new RootLineageStoreError("root lineage is not a valid record");
  return raw;
}

export const rootLineageStore = smallStore<RootLineageV1 | null>({
  collection: "root_lineage", empty: () => null, parse: parseLineage,
  toRows: document => document ? [
    { key: "meta", value: { ...document, sessions: [], head: document.sessions.at(-1) ?? null } },
    ...document.sessions.map((value, index) => ({ key: `session:${index}`, value })),
  ] : [],
  fromRows: rows => {
    const meta = rows.find(row => row.key === "meta");
    if (!meta) return null;
    const { head: _head, ...lineage } = meta.value as RootLineageV1 & { head?: RootSessionV1 | null };
    return parseLineage({ ...lineage, sessions: rows.filter(row => row.key !== "meta").map(row => row.value) });
  },
  toFile: document => document,
  error: (message, cause) => new RootLineageStoreError(message, { cause }),
  readLegacy: file => {
    try { return parseLineage(JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new RootLineageStoreError("could not read the root lineage", { cause: error });
    }
  },
});

export function readRootLineage(filePath = rootLineageFile()): RootLineageV1 | null {
  return rootLineageStore.read(filePath);
}

/**
 * Record the live root session, creating the root identity on first sight and
 * appending a rollover link whenever the session id changes. Serialized through
 * the SQLite transaction so two tabs reporting the same rollover cannot
 * both append a successor.
 */
export function recordRootSession(
  candidate: { conversationId: string; path?: string | null },
  options: { now?: Date; reason?: RootRolloverReason; filePath?: string } = {},
): RootAdoption {
  const filePath = options.filePath ?? rootLineageFile();
  return rootLineageStore.mutate(filePath, current => {
    const adoption = adoptRootSession(current, candidate, {
      now: options.now,
      reason: options.reason,
      rootId: current?.rootId ?? mintRootId(),
    });
    return { next: adoption.outcome === "current" ? undefined : adoption.lineage, result: adoption };
  });
}

/** The current session, selected without materializing retained sessions. */
export function readRootHead(filePath = rootLineageFile()): RootSessionV1 | null {
  const meta = rootLineageStore.readRow(filePath, "meta")?.value as (RootLineageV1 & { head?: RootSessionV1 | null }) | undefined;
  if (!meta) return null;
  parseLineage(meta);
  if (meta.head != null && !isSession(meta.head)) throw new RootLineageStoreError("root head is not a valid session");
  return meta.head ?? null;
}

/** The stable root identity, minting one if the operator has never had a root
    session. Callers that must reference the root durably use this and nothing
    else — never a conversation id, never a transcript path (D5). */
export function rootIdentity(filePath = rootLineageFile()): string {
  const existing = rootLineageStore.readRow(filePath, "meta")?.value as RootLineageV1 | undefined;
  if (existing) return parseLineage(existing).rootId;
  return rootLineageStore.patchRows(filePath, 2, tx => {
    const current = tx.get("meta")?.value as RootLineageV1 | undefined;
    if (current) return parseLineage(current).rootId;
    const lineage: RootLineageV1 = {
      schemaVersion: ROOT_LINEAGE_SCHEMA_VERSION, rootId: mintRootId(), revision: 0,
      updatedAt: new Date().toISOString(), sessions: [],
    };
    tx.put({ key: "meta", value: lineage });
    return lineage.rootId;
  });
}
