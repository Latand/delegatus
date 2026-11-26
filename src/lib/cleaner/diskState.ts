import fs from "node:fs";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { diskCleanerStateFile, type CleanerHold, type DiskCleanerClass } from "./diskJournal";

export type CleanerSpace = { volume: string; roles: string[]; freeBytes: number | null };
export type DiskCleanerPass = {
  id: string;
  project: string;
  episode: string | null;
  mode: "on" | "dry-run";
  startedAt: number;
  before: CleanerSpace[];
  scratchCursor?: string;
  finished?: {
    at: number;
    after: CleanerSpace[];
    removed: Record<DiskCleanerClass, number>;
    uncertain: number;
    kept: CleanerHold[];
    errors: number;
    incomplete: boolean;
  };
  card?: boolean;
};

export function readDiskCleanerPass(): DiskCleanerPass | null {
  try {
    const pass = JSON.parse(fs.readFileSync(diskCleanerStateFile(), "utf8")) as DiskCleanerPass;
    if (/^[a-f0-9-]{36}$/.test(pass.id) && typeof pass.project === "string" && (pass.mode === "on" || pass.mode === "dry-run") && Number.isFinite(pass.startedAt)
      && Array.isArray(pass.before) && (!pass.finished || Number.isFinite(pass.finished.at))) return pass;
    throw new Error("invalid disk cleaner state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function diskCleanerAllowed(id: string, expected?: Pick<DiskCleanerPass, "project" | "mode">) {
  const pass = readDiskCleanerPass();
  return viewerReleaseOwnsTraffic() && process.env.LLV_CLEANER !== "off" && pass?.id === id && !pass.finished
    && (!expected || pass.project === expected.project && pass.mode === expected.mode);
}
