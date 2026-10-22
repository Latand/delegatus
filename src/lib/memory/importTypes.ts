import type { MemorySourceFile } from "./source";
import type { CuratorReason } from "./roleTypes";

export function validateImportId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw Error("invalid memory import id");
}

export interface ImportRoots { claudeHomes: readonly string[]; codexHomes: readonly string[] }
export interface ImportRequest {
  importId: string;
  previous: MemorySourceFile | null;
  /** Explicit roots are for fixture homes and operator tools; the job discovers managed homes otherwise. */
  roots?: ImportRoots;
  at?: string;
  advance?: boolean;
  rescan?: boolean;
  /** The periodic sync of memory-source-switch.md §4.9: a capped delta scan of
      a ready import while the engines' memory is selected. */
  sync?: boolean;
}
export type ImportWriter = { kind: "seat" | "stage" | "operator" | "unknown"; roleId: string | null };
export interface ImportOccurrence {
  id: string;
  file: string;
  sha256: string;
  type: "user" | "feedback" | "project" | "reference" | "summary" | null;
  writtenAt: string | null;
  writer: ImportWriter;
  project: string | null;
}
export interface ImportCandidate {
  kind: "candidate";
  id: string;
  importId: string;
  engine: "claude" | "codex";
  store: "claude_topic" | "codex_summary";
  group: string;
  /** Offsets address the exact backed-up bytes. Normalization is used only for comparison. */
  part: { index: number; of: number; bytes: [number, number] };
  contentSha256: string;
  linked: string[];
  occurrences: ImportOccurrence[];
  anchor: string;
  loadedAtStart: boolean;
  suggestedScope: string;
  curationProject?: string;
  title: string;
  body: string;
  readBy?: string[];
  /** Durable pass-level acknowledgement that these occurrences were explicitly deferred. */
  deferred?: { pass: string; occurrences: string[] }[];
  dispositions: { at: string; pass: string; kind: "adopt" | "drop"; ruleIds: string[]; reason?: CuratorReason; note: string; occurrences: string[]; forRoom?: boolean }[];
}
export interface ImportRecord {
  kind: "import";
  id: string;
  state: "copying" | "ready" | "failed";
  at: string;
  previous: MemorySourceFile | null;
  backup: string;
  files: number;
  candidates: number;
  parts: number;
  /** Fixed diagnostic codes never echo private paths or note text. */
  curationDirty?: boolean;
  observedMemoryRevision?: string;
  progress?: { files: number; parts: number; pendingFiles: number; pendingParts: number; pendingLoadedParts: number; adopted: number; dropped: number };
  roots?: ImportRoots;
  hostProject?: string;
  flippedAt?: string;
  drainedAt?: string;
  legacyGenerations?: string[];
  remainingGenerations?: string[];
  lastScanAt?: string;
  /** The last periodic sync attempt (§4.9); its time drives the schedule across restarts. */
  sync?: ImportSyncRun;
  /** Durable trigger, evaluated once each project finishes its initial import. */
  raisedOrchestratorProjects?: string[];
  reason?: "integrity" | "backup_refused" | "source_changed" | "interrupted" | "failed";
}
export interface ImportSyncRun {
  lastAt: string;
  /** "running" from the lock on; a helper the deadline ended leaves it behind. */
  result: "running" | "ok" | "capped" | "failed";
  /** Candidate parts this run added that did not inherit a disposition. */
  added: number;
  reason?: NonNullable<ImportRecord["reason"]>;
}
export interface ImportManifestFile {
  file: string;
  copy: string;
  engine: "claude" | "codex";
  kind: "claude_topic" | "claude_index" | "codex_summary" | "history";
  size: number;
  modifiedAt: string;
  sha256: string;
  home: string;
  project: string | null;
  loadedAtStart: boolean;
  /** Candidate rows for this verified copy have committed to the import collection. */
  candidatesComplete?: boolean;
}
export interface ImportManifest {
  schemaVersion: 1;
  importId: string;
  createdAt: string;
  files: ImportManifestFile[];
}
