import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_HANDOFF_MS = 5 * 60_000;

export function restartGateFile(requestFile: string): string {
  return join(dirname(requestFile), "auto-admission.json");
}

export function activeRestartGate(file: string, now = Date.now()): string | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; until?: unknown };
    if (typeof value.id !== "string" || typeof value.until !== "number") throw new Error("invalid gate");
    return value.until > now ? value.id : null;
  } catch {
    // A torn or unreadable gate is conservatively held for its bounded life.
    try { return now - statSync(file).mtimeMs < MAX_HANDOFF_MS ? "unreadable" : null; }
    catch { return null; }
  }
}

export function beginRestartGate(file: string, now = Date.now()): string | null {
  if (activeRestartGate(file, now)) return null;
  const id = randomUUID();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ id, until: now + MAX_HANDOFF_MS })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return id;
}

export function endRestartGate(file: string, id: string): void {
  try {
    if ((JSON.parse(readFileSync(file, "utf8")) as { id?: string }).id === id) rmSync(file, { force: true });
  } catch { /* A newer handoff or a removed file must not be touched. */ }
}
