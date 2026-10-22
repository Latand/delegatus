import fs from "node:fs";

import { readStableTailRecords } from "@/lib/scanner/activity";

const MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
const TAIL_BYTES = 131_072;

export function normalizedClaudePermissionMode(value: unknown): string | null {
  return typeof value === "string" && MODES.has(value) ? value : null;
}

/** Claude records the active mode on user turns. Message content and assistant
 * fields cannot authorize a permission change. The latest recorded mode wins. */
function recordedMode(records: Record<string, unknown>[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const row = records[i]!;
    if (row.type !== "user" || !Object.hasOwn(row, "permissionMode")) continue;
    return normalizedClaudePermissionMode(row.permissionMode) ?? "default";
  }
  return null;
}

/** Async, uncached and bounded for structured launch and startup paths. Missing
 * or uncertain evidence leaves the caller on the confirmation default. */
export async function readClaudePermissionMode(pathname: string | null | undefined): Promise<string | null> {
  if (!pathname) return null;
  const tail = await readStableTailRecords(pathname, TAIL_BYTES);
  return tail.integrity === "complete" ? recordedMode(tail.records) : null;
}

/** The synchronous terminal-command composer needs the same bounded evidence.
 * Do not use the scanner's display cache for a permission decision. */
export function readClaudePermissionModeSync(pathname: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return null;
    const length = Math.min(before.size, TAIL_BYTES);
    const start = before.size - length;
    const prefix = start > 0 ? 1 : 0;
    const buffer = Buffer.alloc(length + prefix);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, start - prefix + offset);
      if (!read) return null;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(pathname);
    for (const stat of [after, current]) {
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size
        || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) return null;
    }
    const boundary = start > 0 ? buffer.indexOf(0x0a) + 1 : 0;
    if (start > 0 && !boundary) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(boundary));
    const records: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      records.push(value as Record<string, unknown>);
    }
    return recordedMode(records);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
