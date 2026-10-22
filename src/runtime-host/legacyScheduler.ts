import { createHash } from "node:crypto";

import { listFiles } from "@/lib/scanner";
import { LegacyRuntimeScheduler } from "@/lib/runtime/legacyScheduler";

import { RuntimeJournal } from "./journal";

/** Stable read-model evidence that drives client /api/files hydration. */
export function filesEvidence(entries: Awaited<ReturnType<typeof listFiles>>): string {
  return createHash("sha256").update(JSON.stringify(entries.map((entry) => ({
    path: entry.path,
    mtime: entry.mtime,
    size: entry.size,
    activity: entry.activity,
    activityReason: entry.activityReason ?? null,
    proc: entry.proc,
    pid: entry.pid,
    authoritativeTurn: entry.authoritativeTurn ?? null,
    pendingQuestion: entry.pendingQuestion?.toolUseId ?? null,
    waitingInput: entry.waitingInput?.since ?? null,
  })))).digest("hex");
}

/** File hydration only: the host no longer registers retired executors. */
export function createLegacyRuntimeScheduler(journal: RuntimeJournal): LegacyRuntimeScheduler {
  let previousEvidence: string | null = null;
  return new LegacyRuntimeScheduler({
    scan: listFiles,
    publishFiles(entries) {
      const evidence = filesEvidence(entries);
      if (evidence === previousEvidence) return;
      previousEvidence = evidence;
      const filesRevision = journal.snapshot().filesRevision + 1;
      journal.append({
        scope: { type: "system", id: "files" },
        kind: "files.revision",
        payload: { filesRevision, evidenceHash: evidence },
        producer: { kind: "legacy-reconciliation" },
      });
    },
  });
}
