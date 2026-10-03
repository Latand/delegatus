/* A renewable launch hold. Resolve state only when a caller reads it (#1905). */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "@/lib/configDir";
import type { Flow } from "@/lib/flows/types";

/** A fresh automatic round waits for admission. Already submitted work keeps
    its custody and is observed to completion during the drain. */
export function flowAwaitingAdmission(flow: Pick<Flow, "mode" | "state" | "rounds">): boolean {
  if (flow.mode !== "auto") return false;
  const round = flow.rounds.at(-1);
  if (!round) return false;
  if (flow.state === "spawning") return !round.spawnStartedAt && !round.launchId
    && !round.reviewerPath && !round.sessionId && !round.reviewerPane && round.reviewerPid == null;
  return flow.state === "relaying" && !round.relayStartedAt && !round.relayPendingSettlement && !round.relayedAt;
}

export const DRAIN_NOTICE_MS = 6 * 60 * 60_000;
export const DRAIN_LEASE_MS = 10 * 60_000;
export interface DrainLease { id: string; target: string; since: string; until: number; persistent?: boolean }
export function drainFile(): string { return statePath("self-update", "auto-drain.json"); }
export function activeDrain(file = drainFile(), now = Date.now()): DrainLease | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as DrainLease;
    if (typeof value.id !== "string" || typeof value.target !== "string" || !Number.isFinite(Date.parse(value.since)) || !Number.isFinite(value.until)) throw new Error("invalid drain lease");
    return value.persistent === true || value.until > now ? value : null;
  } catch {
    // An unreadable custody record needs repair; a timer cannot admit work.
    try {
      const mtime = statSync(file).mtimeMs;
      return { id: "unreadable", target: "unknown", since: new Date(mtime).toISOString(), until: mtime + DRAIN_LEASE_MS, persistent: true };
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
  } catch { /* An unreadable or newer custody record remains held for its owner. */ }
}
