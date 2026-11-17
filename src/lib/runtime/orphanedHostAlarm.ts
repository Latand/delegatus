import crypto from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";

import { structuredClaimIdentity, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { registryConversationsForEntryKey } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus } from "@/lib/processIdentity";

import { forgetOrphanedHostGrace, reconnectableCodexOrphan, structuredHostOrphaned } from "./orphanedHost";
import { startupHostSnapshot } from "./startupSnapshot";
import { orphanedHostNotice, startupRowNotice, startupRowRetries, type StartupRowRetry } from "./startupRowRetries";

/** The rows whose orphan alarm is raised, so a later scan can close it once
    the row is adopted, stopped or gone. Keyed by the row's key id. */
type OrphanAlarmRecords = Record<string, { engine: SessionKey["engine"]; sessionId: string; cwd: string }>;

const alarmFile = (registry: AgentRegistry) => `${registry.filename}.orphan-alarms.json`;

// A pending async read inherits and retains the startup pass's snapshot.
function readAlarms(registry: AgentRegistry): OrphanAlarmRecords {
  try {
    const parsed = JSON.parse(syncFs.readFileSync(alarmFile(registry), "utf8")) as unknown;
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

/* Every read-modify-write of one alarm file runs in turn, so a recovery that
   closes a row's alarm and a startup scan that raises another never lose
   each other's record. A scan uses one turn and one file read for the whole
   pass, reading each row again when it reaches it. */
const alarmTurns = new Map<string, Promise<unknown>>();

async function withAlarms<T>(registry: AgentRegistry, turn: (alarms: OrphanAlarmRecords) => Promise<{ changed: boolean; result: T }>,
  assertActive: () => void): Promise<T> {
  const file = alarmFile(registry);
  const previous = alarmTurns.get(file) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const alarms = readAlarms(registry);
    const { changed, result } = await turn(alarms);
    if (changed) await writeAlarms(registry, alarms, assertActive);
    return result;
  });
  alarmTurns.set(file, run);
  try { return await run; } finally { if (alarmTurns.get(file) === run) alarmTurns.delete(file); }
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
 * orphan's quarantine card carries the same alarm. A Codex orphan whose
 * socket still verifies is reachable, since a send reconnects to it, so it
 * raises none. A row that stops being an
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
  assertActive();
  const rows = [...scan.rows];
  // A terminal-only pass with no recorded alarm has nothing to inspect or
  // close. Keep its async context out of the file-operation queue entirely.
  if (rows.every(row => "structuredHost" in row && !mayBeOwnedElsewhere(row))
    && !syncFs.existsSync(alarmFile(registry))) return [];
  return withAlarms(registry, async recorded => {
    let changed = false;
    const seen = new Set<string>();
    const incumbentOwned: SessionKey[] = [];
    for (const row of rows) {
      assertActive();
      const key = { engine: row.key.engine, sessionId: row.key.sessionId } as SessionKey;
      const id = sessionKeyId(key);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!recorded[id] && "structuredHost" in row && !mayBeOwnedElsewhere(row)) continue;
      const snapshot = startupHostSnapshot(registry, key);
      const entry: AgentRegistryEntry | undefined = snapshot.entries[id];
      const retry = scan.retry(id);
      const quarantined = retry?.quarantined && !retry.resolved ? retry : null;
      const candidate = Boolean(entry && !scan.adopted.has(id) && mayBeOwnedElsewhere(entry));
      if (candidate && structuredHostOrphaned(entry)) {
        /* A send reconnects a Codex orphan whose socket still verifies,
           without a stop; that host is reachable, so it raises no alarm. */
        if (reconnectableCodexOrphan(entry)) {
          console.error("[structured hosts] orphaned Codex host left for a send's socket reconnect", {
            key: id, pid: entry!.structuredHost?.process?.pid,
          });
        } else {
          const conversationIds = registryConversationsForEntryKey(snapshot, id).map(row => row.id);
          try {
            if (quarantined) await startupRowNotice(entry!, quarantined, assertActive, { orphaned: true, conversationIds });
            else await orphanedHostNotice(entry!, conversationIds, assertActive);
          } catch (error) {
            assertActive();
            console.error("[structured hosts] orphaned host alarm publication deferred", { key: id, error: String(error) });
            continue;
          }
          console.error("[structured hosts] orphaned host surfaced to its seat", {
            key: id, pid: entry!.structuredHost?.process?.pid, conversations: conversationIds, quarantined: Boolean(quarantined),
          });
          if (!recorded[id]) {
            recorded[id] = { engine: key.engine, sessionId: key.sessionId, cwd: entry!.cwd };
            changed = true;
          }
          continue;
        }
      }
      const incumbent = candidate && ownedByAnotherLiveProcess(entry!);
      if (incumbent) incumbentOwned.push(key);
      const record = recorded[id];
      if (!record) continue;
      if (!await closeAlarm(entry ?? { key, cwd: record.cwd }, quarantined, id, assertActive)) continue;
      await forgetOrphanedHostGrace(registry.filename, id);
      assertActive();
      delete recorded[id];
      changed = true;
    }
    if (scan.sweepAbsent) {
      for (const [id, absent] of Object.entries(recorded)) {
        if (seen.has(id)) continue;
        const key = { engine: absent.engine, sessionId: absent.sessionId } as SessionKey;
        assertActive();
        if (startupHostSnapshot(registry, key).entries[id]?.structuredHost) continue;
        if (!await closeAlarm({ key, cwd: absent.cwd }, null, id, assertActive)) continue;
        await forgetOrphanedHostGrace(registry.filename, id);
        assertActive();
        delete recorded[id];
        changed = true;
      }
    }
    return { changed, result: incumbentOwned };
  }, assertActive);
}

/**
 * Raises the row's orphan alarm from outside a startup pass: a send's
 * recovery found the orphan and could not stop it. `refusal` says why, and
 * the card names every conversation of the row. Recorded like a scan's alarm,
 * so whatever later ends the orphan closes it.
 */
export async function raiseOrphanedHostAlarm(registry: AgentRegistry, key: SessionKey, refusal: string,
  assertActive: () => void = () => {}): Promise<void> {
  const id = sessionKeyId(key);
  await withAlarms(registry, async alarms => {
    const snapshot = startupHostSnapshot(registry, key);
    const entry = snapshot.entries[id];
    if (!entry || !structuredHostOrphaned(entry)) return { changed: false, result: undefined };
    const conversationIds = registryConversationsForEntryKey(snapshot, id).map(row => row.id);
    const retry = startupRowRetries(registry).get(id);
    const quarantined = retry?.quarantined && !retry.resolved ? retry : null;
    if (quarantined) await startupRowNotice(entry, quarantined, assertActive, { orphaned: true, conversationIds });
    else await orphanedHostNotice(entry, conversationIds, assertActive, refusal);
    console.error("[structured hosts] orphaned host whose stop was refused surfaced to its seat", { key: id, conversations: conversationIds, refusal });
    if (alarms[id]) return { changed: false, result: undefined };
    alarms[id] = { engine: key.engine, sessionId: key.sessionId, cwd: entry.cwd };
    return { changed: true, result: undefined };
  }, assertActive);
}

/**
 * Closes the row's orphan alarm once the row is no orphan any more: its host
 * was stopped or retired, or a send claimed it again. A quarantined row keeps
 * its quarantine card without the orphan alarm. Nothing is written when no
 * alarm of the row is recorded, so every stop may call it. The row's grace
 * and refusal records go with it.
 */
export async function closeOrphanedHostAlarm(registry: AgentRegistry, key: SessionKey,
  assertActive: () => void = () => {}): Promise<void> {
  const id = sessionKeyId(key);
  await forgetOrphanedHostGrace(registry.filename, id);
  await withAlarms(registry, async alarms => {
    const record = alarms[id];
    if (!record) return { changed: false, result: undefined };
    const entry = startupHostSnapshot(registry, key).entries[id];
    if (entry && structuredHostOrphaned(entry) && !reconnectableCodexOrphan(entry)) return { changed: false, result: undefined };
    const retry = startupRowRetries(registry).get(id);
    const quarantined = retry?.quarantined && !retry.resolved ? retry : null;
    if (!await closeAlarm(entry ?? { key, cwd: record.cwd }, quarantined, id, assertActive)) return { changed: false, result: undefined };
    delete alarms[id];
    return { changed: true, result: undefined };
  }, assertActive);
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
