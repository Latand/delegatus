import crypto from "node:crypto";
import fs from "node:fs/promises";

import { structuredClaimIdentity, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { registryConversationsForEntryKey } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus } from "@/lib/processIdentity";

import { structuredHostOrphaned } from "./orphanedHost";
import { startupHostSnapshot } from "./startupSnapshot";
import { orphanedHostNotice, startupRowNotice, type StartupRowRetry } from "./startupRowRetries";

/** The rows whose orphan alarm is raised, so a later scan can close it once
    the row is adopted, stopped or gone. Keyed by the row's key id. */
type OrphanAlarmRecords = Record<string, { engine: SessionKey["engine"]; sessionId: string; cwd: string }>;

const alarmFile = (registry: AgentRegistry) => `${registry.filename}.orphan-alarms.json`;

async function readAlarms(registry: AgentRegistry): Promise<OrphanAlarmRecords> {
  try {
    const parsed = JSON.parse(await fs.readFile(alarmFile(registry), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const records: OrphanAlarmRecords = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<OrphanAlarmRecords[string]> | null;
      if (record && typeof record.engine === "string" && typeof record.sessionId === "string" && typeof record.cwd === "string"
        && `${record.engine}:${record.sessionId}` === key) records[key] = record as OrphanAlarmRecords[string];
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeAlarms(registry: AgentRegistry, records: OrphanAlarmRecords, assertActive: () => void): Promise<void> {
  const file = alarmFile(registry);
  const temporary = `${file}.${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: "wx" });
    assertActive();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export interface OrphanedHostScan {
  registry: AgentRegistry;
  /** The rows this scan looks at: the pass's scope. A row given with its
      pass-time fields skips the current read when those fields already rule
      it out (terminal, no engine, no structured claim) and no alarm of it is
      recorded; a bare key is always read. */
  rows: Iterable<{ key: SessionKey } & Partial<Pick<AgentRegistryEntry, "status" | "structuredHost" | "claimOwner">>>;
  /** Rows this pass adopted; an adopted row is owned by this Viewer. */
  adopted: ReadonlySet<string>;
  /** The row's startup retry record, if any. A quarantined row's alarm is its
      quarantine card, so a row never carries two. */
  retry: (key: string) => StartupRowRetry | undefined;
  /** A full pass also closes recorded alarms whose row left the registry. */
  sweepAbsent: boolean;
  assertActive: () => void;
}

/**
 * Surfaces every row in scope whose engine still runs while its recorded
 * owner process is gone, and which this pass neither adopted nor
 * quarantined, as an assigned card naming its conversations; a quarantined
 * orphan's quarantine card carries the same alarm. A row that stops being an
 * orphan has its alarm closed. Idempotent across passes: the card is
 * deterministic per row and rewritten only when its text or state changes.
 *
 * Answers the rows whose engine runs under an owner that is another live
 * process. During a release handover that is the predecessor Viewer, which
 * the successor's first pass can still see alive; those rows are only proven
 * orphans once it exits, so the caller looks at them again.
 */
export async function surfaceOrphanedHosts(scan: OrphanedHostScan): Promise<SessionKey[]> {
  const { registry, assertActive } = scan;
  const alarms = await readAlarms(registry);
  let changed = false;
  const seen = new Set<string>();
  const incumbentOwned: SessionKey[] = [];
  for (const row of scan.rows) {
    assertActive();
    const key = { engine: row.key.engine, sessionId: row.key.sessionId } as SessionKey;
    const id = sessionKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!alarms[id] && "structuredHost" in row && !mayBeOwnedElsewhere(row)) continue;
    const snapshot = startupHostSnapshot(registry, key);
    const entry: AgentRegistryEntry | undefined = snapshot.entries[id];
    const retry = scan.retry(id);
    const quarantined = retry?.quarantined && !retry.resolved ? retry : null;
    if (entry && !scan.adopted.has(id) && mayBeOwnedElsewhere(entry) && structuredHostOrphaned(entry)) {
      const conversationIds = registryConversationsForEntryKey(snapshot, id).map(row => row.id);
      try {
        if (quarantined) await startupRowNotice(entry, quarantined, assertActive, { orphaned: true, conversationIds });
        else await orphanedHostNotice(entry, conversationIds, assertActive);
      } catch (error) {
        assertActive();
        console.error("[structured hosts] orphaned host alarm publication deferred", { key: id, error: String(error) });
        continue;
      }
      console.error("[structured hosts] orphaned host surfaced to its seat", {
        key: id, pid: entry.structuredHost?.process?.pid, conversations: conversationIds, quarantined: Boolean(quarantined),
      });
      if (!alarms[id]) { alarms[id] = { engine: key.engine, sessionId: key.sessionId, cwd: entry.cwd }; changed = true; }
      continue;
    }
    if (entry && !scan.adopted.has(id) && mayBeOwnedElsewhere(entry) && ownedByAnotherLiveProcess(entry)) incumbentOwned.push(key);
    const recorded = alarms[id];
    if (!recorded) continue;
    if (await closeAlarm(entry ?? { key, cwd: recorded.cwd }, quarantined, id, assertActive)) {
      delete alarms[id];
      changed = true;
    }
  }
  if (scan.sweepAbsent) {
    for (const [id, recorded] of Object.entries(alarms)) {
      if (seen.has(id)) continue;
      const key = { engine: recorded.engine, sessionId: recorded.sessionId } as SessionKey;
      if (startupHostSnapshot(registry, key).entries[id]?.structuredHost) continue;
      if (await closeAlarm({ key, cwd: recorded.cwd }, null, id, assertActive)) {
        delete alarms[id];
        changed = true;
      }
    }
  }
  if (changed) await writeAlarms(registry, alarms, assertActive);
  return incumbentOwned;
}

/** The row is no orphan any more: a quarantine card drops the alarm, any
    other card closes. */
async function closeAlarm(entry: Pick<AgentRegistryEntry, "key" | "cwd">, quarantined: StartupRowRetry | null, id: string,
  assertActive: () => void): Promise<boolean> {
  try {
    await startupRowNotice(entry, quarantined, assertActive);
    console.error("[structured hosts] orphaned host alarm closed", { key: id });
    return true;
  } catch (error) {
    assertActive();
    console.error("[structured hosts] orphaned host alarm closure deferred", { key: id, error: String(error) });
    return false;
  }
}

/** A row that is not terminal and records an engine and a structured claim
    owner. Terminal rows belong to the terminal orphan path, as in recovery. */
function mayBeOwnedElsewhere(row: Partial<Pick<AgentRegistryEntry, "status" | "structuredHost" | "claimOwner">>): boolean {
  return row.status !== "dead" && row.status !== "unhosted" && Boolean(row.structuredHost?.process)
    && Boolean(row.claimOwner && structuredClaimIdentity(row.claimOwner));
}

/** The engine runs and its structured claim owner is another process that
    still runs. */
function ownedByAnotherLiveProcess(entry: AgentRegistryEntry): boolean {
  const engine = entry.structuredHost?.process;
  const owner = entry.claimOwner ? structuredClaimIdentity(entry.claimOwner) : null;
  return Boolean(engine && owner && owner.pid !== process.pid
    && processIdentityStatus(owner) === "alive" && processIdentityStatus(engine) !== "dead");
}

/** Delays of the follow-up scans for rows still held by another live owner.
    They cover a predecessor Viewer that exits after the successor's pass,
    about half an hour in all, and then stop. */
export const ORPHAN_FOLLOW_UP_DELAYS_MS = [30_000, 60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000] as const;
