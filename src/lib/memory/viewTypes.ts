export type MemoryTurnReason = "projectOff" | "noKey" | "notOwner" | "capped" | "unprovenOrigin" | "invalidTurn"
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
