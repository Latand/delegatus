import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { admitOperatorDirectory } from "@/lib/stateOwnership";
import { isStagingMode, STAGING_STATE_DIRNAME } from "@/lib/staging";
import { APP_DIR_NAMES, appDirIn } from "../../../bin/appDir.mjs";
import { decodeFlow } from "./decode";
import type { Flow } from "./types";

export const MAX_ROW_BYTES = 2 * 1024 * 1024;
export class ArchiveReadError extends Error {
  constructor(public code: "ARCHIVE_NOT_INITIALIZED" | "ARCHIVE_UNAVAILABLE" | "ARCHIVE_TOO_LARGE", public status = 503) {
    super(code);
  }
}

/** Resolve an admitted directory without configDir's first-use legacy copy.
 * Migration remains the serving process's startup responsibility. */
export function archiveDirectory(): string {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const override = process.env.LLV_STATE_DIR;
  if (isStagingMode()) {
    const directory = path.resolve(override || path.join(appDirIn(root), STAGING_STATE_DIRNAME));
    const production = [...APP_DIR_NAMES.map((name) => path.join(root, name, "state")), path.join(os.homedir(), ".claude", "viewer-state")];
    if (production.some(candidate => path.resolve(candidate) === directory)) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE");
    return directory;
  }
  return override || admitOperatorDirectory(path.join(appDirIn(root), "state"), "state");
}

/** Explicit missing-import result: GET must never import JSON or mistake it
 * for an empty archive. No writer, registry or execution module is loaded. */
export function reviewHistorySelectionSource(directory = archiveDirectory()) {
  const filename = path.join(directory, "state.sqlite");
  let db: Database | null = null;
  try {
    if (fs.existsSync(filename)) {
      const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
      if (!sqlite) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE");
      db = new sqlite.Database(filename, { readonly: true, strict: true });
      db.exec("PRAGMA query_only=ON; BEGIN");
      const initialized = db.query("SELECT 1 FROM state_collections WHERE collection='flows'").get();
      if (!initialized) throw new ArchiveReadError("ARCHIVE_NOT_INITIALIZED");
    } else if (fs.existsSync(path.join(directory, "flows.json")) || (!process.env.LLV_STATE_DIR && !process.env.XDG_CONFIG_HOME && fs.existsSync(path.join(os.homedir(), ".claude", "viewer-state", "flows.json")))) {
      throw new ArchiveReadError("ARCHIVE_NOT_INITIALIZED");
    }
  } catch (error) {
    db?.close();
    if (error instanceof ArchiveReadError) throw error;
    throw new ArchiveReadError("ARCHIVE_UNAVAILABLE");
  }
  function raw(id: string): Record<string, unknown> | null {
    if (!db) return null;
    // Bound allocation in SQLite before bringing the original JSON into JS.
    const row = db.query<{ value_json: string | null; bytes: number }, [string]>(
      "SELECT CASE WHEN length(CAST(value_json AS BLOB)) <= " + MAX_ROW_BYTES + " THEN value_json END AS value_json, length(CAST(value_json AS BLOB)) AS bytes FROM state_rows WHERE collection='flows' AND row_key=?",
    ).get(id);
    if (!row) return null;
    if (row.bytes > MAX_ROW_BYTES) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
    try {
      const value = JSON.parse(row.value_json!);
      if (!decodeFlow(value) || value.id !== id) throw new Error("invalid row");
      return value;
    } catch { throw new ArchiveReadError("ARCHIVE_UNAVAILABLE"); }
  }
  function conversationId(id: string | null | undefined): string | null {
    if (!id) return null;
    if (!db || !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_rows'").get()) return id;
    let current = id;
    const seen = new Set<string>();
    for (let hop = 0; hop < 64; hop++) {
      if (seen.has(current)) return id;
      seen.add(current);
      const row = db.query<{ value_json: string | null }, [string]>("SELECT CASE WHEN length(value_json)<=1024 THEN value_json END AS value_json FROM registry_rows WHERE collection='conversationAliases' AND row_key=?").get(current);
      if (!row) return current;
      let alias: unknown;
      try { alias = JSON.parse(row.value_json!); } catch { return id; }
      if (typeof alias !== "string" || !alias) return id;
      current = alias;
    }
    return id;
  }
  return { filename, directory, database: db, initialized: db !== null, raw, conversationId,
    read: (id: string): Flow | null => { const value = raw(id); return value ? decodeFlow(value) : null; },
    close: () => db?.close(),
  };
}

/** Alias projection reads only the already-published file, without initializing
 * either the project catalog or the state directory. */
export function archiveProjects(directory: string) {
  let aliases: Record<string, string> = {};
  const file = path.join(directory, "project-aliases.json");
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > MAX_ROW_BYTES) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (stored.schemaVersion !== 1 || !stored.aliases || typeof stored.aliases !== "object" || Array.isArray(stored.aliases)) throw new Error("invalid aliases");
      aliases = Object.fromEntries(Object.entries(stored.aliases).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch { throw new ArchiveReadError("ARCHIVE_UNAVAILABLE"); }
  }
  const canonical = (project: string) => {
    let current = project;
    const seen = new Set<string>();
    while (Object.hasOwn(aliases, current) && !seen.has(current)) { seen.add(current); current = aliases[current]!; }
    return seen.has(current) ? project : current;
  };
  return { canonical, aliases: () => aliases };
}
