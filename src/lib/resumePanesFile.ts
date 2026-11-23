/**
 * The record a registry file written while agents ran in terminal panes keeps
 * under `legacyResumePanes`. Nothing acts on it; the shape is kept so such a
 * file still loads.
 */
export interface ResumePaneRecord {
  paneId: string;
  panePid?: number;
  windowName: string;
  engine?: "claude" | "codex" | "copilot";
}
