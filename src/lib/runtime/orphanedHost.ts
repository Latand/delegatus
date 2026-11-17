import { structuredClaimIdentity, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { registryConversationsForEntryKey } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus, type ProcessIdentityProbe } from "@/lib/processIdentity";

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
 * from the durable admission of the send that needs the host, so a restart
 * neither resets nor extends it. It is shorter than the send settlement window
 * (`SEND_SETTLEMENT_WINDOW_MS`, ten minutes), so the stop and the resume still
 * fit inside the time a held send is kept.
 */
export const ORPHANED_HOST_IN_FLIGHT_GRACE_MS = 3 * 60_000;

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
