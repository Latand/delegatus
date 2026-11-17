import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { structuredClaimIdentity, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { registryConversationsForEntryKey } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus, type ProcessIdentity, type ProcessIdentityProbe } from "@/lib/processIdentity";

/**
 * A structured host whose recorded writer claim names a process that is gone
 * while the engine process it hosted still runs.
 *
 * A Claude broker talks over stdio pipes that belong to the Viewer process
 * that started it. When a release replaces that Viewer, an idle engine sees
 * its input close and exits, but a busy one, or one waiting on background
 * shells, keeps running with nobody on the other end of its pipes. The row
 * still names the old Viewer as its claim owner and a live engine as its
 * process, which read as a deliverable host. A send was then accepted and
 * failed within a tenth of a second as `dead-host`.
 *
 * Only proof counts: the claim must be a structured-host identity this
 * process can parse, that identity must be proven dead, and the engine must
 * not be proven dead. A legacy or unreadable claim, or an owner whose start
 * identity cannot be read, is left to the paths that already handle it.
 */
export function structuredHostOrphaned(
  entry: Pick<AgentRegistryEntry, "claimOwner" | "structuredHost"> | null | undefined,
  probe?: ProcessIdentityProbe,
): boolean {
  const engine = entry?.structuredHost?.process;
  if (!entry?.claimOwner || !engine) return false;
  const owner = structuredClaimIdentity(entry.claimOwner);
  if (!owner) return false;
  if (processIdentityStatus(owner, probe) !== "dead") return false;
  return processIdentityStatus(engine, probe) !== "dead";
}

export const ORPHANED_HOST_REASON =
  "the structured host's recorded owner process is gone while its engine process still runs; delivery requires recovery";

/**
 * How long recovery leaves an orphan that still has work in flight (an open
 * turn, attention, or Claude background shells) before it stops it. Measured
 * from the later of the durable admission of the send that needs the host and
 * the first durable observation of this orphan with work in flight, so a send
 * admitted long before recovery first sees the orphan still gets the whole
 * grace, and a restart neither resets nor extends it. It is shorter than the
 * send settlement window (`SEND_SETTLEMENT_WINDOW_MS`, ten minutes), so the
 * stop and the resume still fit inside the time a held send is kept.
 */
export const ORPHANED_HOST_IN_FLIGHT_GRACE_MS = 3 * 60_000;

interface OrphanGraceRecord {
  key: string;
  engine: ProcessIdentity;
  firstObservedAt: number;
}

function orphanGraceFile(registryFile: string, key: string): string {
  return path.join(`${registryFile}.orphan-grace`, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
}

function sameEngine(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.startIdentity === right.startIdentity
    && (left.bootEpoch ?? null) === (right.bootEpoch ?? null);
}

function parsedGraceRecord(text: string, key: string, engine: ProcessIdentity): number | null {
  try {
    const record = JSON.parse(text) as Partial<OrphanGraceRecord>;
    return record.key === key && record.engine && typeof record.engine === "object"
      && sameEngine(record.engine as ProcessIdentity, engine)
      && Number.isSafeInteger(record.firstObservedAt) && record.firstObservedAt! >= 0
      ? record.firstObservedAt! : null;
  } catch { return null; }
}

/**
 * When this orphan was first durably observed with work in flight. The first
 * caller records `now`; every later caller, in this process or a successor
 * Viewer, reads that record back. A record left by another engine process of
 * the same row (an earlier orphan) is replaced, as is one that cannot be
 * read, so a stale record never shortens a new orphan's grace.
 */
export async function orphanedHostFirstObservedAt(
  registryFile: string,
  key: string,
  engine: ProcessIdentity,
  now: number,
): Promise<number> {
  const file = orphanGraceFile(registryFile, key);
  try {
    const existing = parsedGraceRecord(await fs.readFile(file, "utf8"), key, engine);
    if (existing !== null) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record: OrphanGraceRecord = { key, engine: { pid: engine.pid, startIdentity: engine.startIdentity, bootEpoch: engine.bootEpoch ?? null }, firstObservedAt: now };
  const temporary = `${file}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
      // Create only when absent, so two observers agree on the first one.
      await fs.link(temporary, file);
      return now;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const raced = parsedGraceRecord(await fs.readFile(file, "utf8"), key, engine);
    if (raced !== null) return raced;
    await fs.rename(temporary, file);
    return now;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Drops the grace record once the orphan it timed is stopped. */
export async function forgetOrphanedHostGrace(registryFile: string, key: string): Promise<void> {
  await fs.rm(orphanGraceFile(registryFile, key), { force: true });
}

/** What the startup quarantine notice says about one row: whether it is an
    orphan, and the conversations the seat will recognise it by. `snapshot` is
    the row-scoped startup snapshot of that one row. */
export function orphanedHostNoticeContext(
  snapshot: RegistryFile,
  entryKey: string,
): { orphaned: boolean; conversationIds: string[] } {
  return {
    orphaned: structuredHostOrphaned(snapshot.entries[entryKey]),
    conversationIds: registryConversationsForEntryKey(snapshot, entryKey).map(row => row.id),
  };
}
