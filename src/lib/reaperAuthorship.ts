import { readReaperEvidence, readReaperStateDocument } from "@/lib/reaperState";

/**
 * Human-authorship evidence recorded by the reaper (PR #125). The reaper scans
 * live transcripts for a real user message — filtering Claude task-notification
 * records and viewer-injected relays — and persists every path it confirms as
 * sticky authorship evidence that survives restarts (`reaperState.ts`). The
 * board reads that evidence (rather than re-scanning every transcript on the
 * hot files poll) to pin owner-touched cards against worker-class
 * auto-collapse (issue #112).
 *
 * The reaper's viewer-aware count is the RIGHT source here, not a raw
 * transcript scan: a headless reviewer is spawned with an engine prompt and a
 * flow implementer receives viewer-relayed findings as user-role records, so a
 * naive "has a user message" scan would mark both as owner-touched and defeat
 * the very collapse this feature exists for. The reaper discounts those
 * viewer/spawn-injected messages (its message allowance) and only records a
 * path once a genuine human message clears it — exactly the pin we want.
 *
 * Missing or unreadable evidence is treated as "no evidence yet". `scannedAt`
 * is the PATH-SCOPED freshness map: for each transcript the reaper scanned to
 * completion and cleared, the transcript mtime (seconds) it observed. The board
 * fails CLOSED against it: a claude/codex worker is only collapse-eligible when
 * `scannedAt[path]` is at least as fresh as the file's current mtime — the
 * reaper actually looked at this exact content. A path the reaper never scanned
 * (a worker that exited before any cycle reached it) has no stamp and stays
 * pinned, so an unobserved user-authored transcript can never collapse. A single
 * global "last cycle" timestamp could not express this: it advances every cycle
 * regardless of which paths were scanned, and would certify the unscanned.
 *
 * Both are lookups into the store's read copy, which is loaded once per
 * process and then follows only the paths a cycle changed.
 */
export interface AuthorshipEvidence {
  userAuthoredPaths: Pick<ReadonlySet<string>, "has">;
  scannedAt: Pick<ReadonlyMap<string, number>, "get">;
}

export function readAuthorshipEvidence(): AuthorshipEvidence {
  const evidence = readReaperEvidence();
  return {
    userAuthoredPaths: { has: (pathname) => evidence.authored(pathname) },
    scannedAt: { get: (pathname) => evidence.scannedAt(pathname) },
  };
}

/** Every confirmed-authorship path, enumerated. */
export function readUserAuthoredPaths(): Set<string> {
  try {
    return new Set(Object.keys(readReaperStateDocument().userAuthoredPaths));
  } catch (error) {
    console.error("[reaper] authorship evidence unavailable", error instanceof Error ? error.message : String(error));
    return new Set();
  }
}
