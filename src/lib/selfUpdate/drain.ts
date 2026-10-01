/* A renewable launch hold. Resolve state only when a caller reads it (#1905). */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "@/lib/configDir";

export const DRAIN_AFTER_MS = 4 * 60 * 60_000;
export const DRAIN_MAX_MS = 2 * 60 * 60_000;
export const DRAIN_LEASE_MS = 10 * 60_000;
export interface DrainLease { id: string; target: string; since: string; until: number }
export function drainFile(): string { return statePath("self-update", "auto-drain.json"); }
export function activeDrain(file = drainFile(), now = Date.now()): DrainLease | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as DrainLease;
    if (typeof value.id !== "string" || typeof value.target !== "string" || !Number.isFinite(Date.parse(value.since)) || !Number.isFinite(value.until)) throw new Error("invalid drain lease");
    return value.until > now ? value : null;
  } catch {
    // Torn writes hold conservatively, but never leave lanes held indefinitely.
    try {
      const mtime = statSync(file).mtimeMs;
      return now < mtime + DRAIN_LEASE_MS ? { id: "unreadable", target: "unknown", since: new Date(mtime).toISOString(), until: mtime + DRAIN_LEASE_MS } : null;
    } catch { return null; }
  }
}
export function writeDrain(file: string, lease: DrainLease): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
export function releaseDrain(file: string, id: string): void {
  try {
    if ((JSON.parse(readFileSync(file, "utf8")) as DrainLease).id === id) rmSync(file, { force: true });
  } catch { /* An unreadable lease expires; a newer lease belongs to its writer. */ }
}
