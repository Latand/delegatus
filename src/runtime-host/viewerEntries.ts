import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The Viewer entries this runtime host actually bound, recorded in its state
 * directory once they listen (#2024). A release container is told neither
 * the stable port nor the gateway's remote entry, and the gateway file can
 * be edited after the host read it, so whatever needs to point something at
 * the host's entries (the phone step's `tailscale serve`) reads this record
 * rather than re-deriving the ports from configuration.
 */
export const VIEWER_ENTRIES_FILE = "viewer-entries.json";

export interface ViewerEntries {
  /** The stable port, 8898 unless `LLV_VIEWER_PORT` moved it. */
  stablePort: number;
  /** `local-entry` when a gateway file made the stable port the local entry
      at boot (whether it vouches is re-read per request); `pipe` otherwise. */
  stableEntry: "local-entry" | "pipe";
  /** The gateway's authenticated remote entry, only while it is bound. */
  remoteEntryPort: number | null;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function recordViewerEntries(filename: string, entries: ViewerEntries): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** The record, or null when there is none or it is not one. */
export function readViewerEntries(filename: string): ViewerEntries | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!validPort(record.stablePort)) return null;
  if (record.stableEntry !== "local-entry" && record.stableEntry !== "pipe") return null;
  if (record.remoteEntryPort !== null && !validPort(record.remoteEntryPort)) return null;
  return { stablePort: record.stablePort, stableEntry: record.stableEntry, remoteEntryPort: record.remoteEntryPort };
}
