import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { AutoWriter } from "./auto";

export interface HistoryEntry {
  at: string;
  /** `seat` only on a switch of automatic updates the orchestrator seat made. */
  by: "operator" | "auto" | "seat";
  /** `auto-on`/`auto-off`: automatic updates were switched; `target` is the
      revision they were aimed at then, or empty when there was none. */
  kind: "build" | "restart-web" | "restart-host" | "auto-on" | "auto-off";
  target: string;
  from: string | null;
  outcome: "done" | "failed" | "fell-back";
  detail?: string;
  /** Who switched automatic updates, on `auto-on`/`auto-off`. */
  writer?: AutoWriter;
  /** Idempotency key for an MCP switch. The receipt is kept with its audit row. */
  requestId?: string;
  /** The response snapshot returned for the first delivery of that switch. */
  response?: unknown;
}
function readPersistedHistory(file: string): HistoryEntry[] {
  try {
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as HistoryEntry;
        return value && typeof value.at === "string" && typeof value.kind === "string" ? [value] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

export function readHistory(file: string, limit = 20): HistoryEntry[] {
  return readPersistedHistory(file).slice(-limit).reverse().map((entry) => {
    const visible = { ...entry };
    delete visible.requestId;
    delete visible.response;
    return visible;
  });
}

export function findAutoSwitchRequest(file: string, requestId: string): HistoryEntry | null {
  try {
    for (const line of readFileSync(file, "utf8").split("\n").reverse()) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry?.requestId === requestId && (entry.kind === "auto-on" || entry.kind === "auto-off")) return entry;
      } catch { /* ignore malformed history rows */ }
    }
  } catch { /* a missing or unreadable history cannot prove a prior write */ }
  return null;
}

export function storeAutoSwitchResponse(file: string, requestId: string, response: unknown): void {
  const rows = readFileSync(file, "utf8").split("\n");
  let updated = false;
  const next = rows.map((line) => {
    if (!line) return line;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (!updated && entry.requestId === requestId) {
        updated = true;
        return JSON.stringify({ ...entry, response });
      }
    } catch { /* preserve malformed rows byte for byte */ }
    return line;
  });
  if (!updated) throw new Error("automatic update receipt row disappeared");
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, next.join("\n"));
    renameSync(temporary, file);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve the write failure */ }
    throw error;
  }
}
export function appendHistory(file: string, entry: HistoryEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  if (readFileSync(file, "utf8").split("\n").length - 1 > 1_000) {
    const latest = readPersistedHistory(file).slice(-500);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, latest.map((item) => JSON.stringify(item)).join("\n") + "\n");
    renameSync(temporary, file);
  }
}
