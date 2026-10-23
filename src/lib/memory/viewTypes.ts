export type MemoryTurnReason = "projectOff" | "memorySource" | "noKey" | "notOwner" | "capped" | "unprovenOrigin" | "invalidTurn"
  | "cancelled" | "timeout" | "candidateTimeout" | "ledgerPending" | "failed"
  | "noCandidates" | "noMatches" | "prepared" | "unconfirmed" | "delivered";
/** Browser-safe, numeric status. Counts cover the whole installation. */
export interface MemorySettingView {
  enabled: boolean;
  reasons: Array<"projectOff" | "noKey" | "capped" | "notOwner">;
  lastTurn?: MemoryTurnReason | null;
  keySource: "env" | "file" | null;
  staging?: boolean;
  capUsd: number;
  spentUsd: number;
  month: string;
  counts: { decisions: number; delivered: number; skipped: number; failed: number; noCandidates: number; noMatches: number; prepared: number };
}

export type MemoryImportReason = "integrity" | "backup_refused" | "source_changed" | "interrupted" | "failed";
/** `GET /api/memory/source` (memory-source-switch.md §3.1, §4.9): the
    installation's choice and counts only, never a path or a note's text. */
export interface MemorySourceView {
  choice: "delegatus" | "engines" | null;
  phase: "importing" | "draining" | "active" | null;
  import?: {
    counts: { files: number; parts: number; pendingFiles: number; pendingParts: number; pendingLoadedParts: number; adopted: number; dropped: number } | null;
    remainingGenerations: number;
    hold: MemoryImportReason | null;
  };
  sync?: { intervalHours: number; lastAt: string | null; nextAt: string | null; added: number; capped: boolean; failure: MemoryImportReason | null };
  /** The newest import that failed since the current choice, which put the switch back. */
  lastFailure?: { reason: MemoryImportReason; at: string };
}
