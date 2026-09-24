import fs from "node:fs";
import type { FileEntry } from "@/lib/types";
import type { RuntimeEngine } from "@/lib/agent/runtimeConfig";
import { lastAssistantMessage, transcriptEntryFromPath } from "@/lib/scanner/lastAssistantMessage";
import { parseFindings, type ParsedFindings } from "@/lib/review/findings";
import type { Round } from "./types";

export function readFindingsFile(round: Round): ParsedFindings | null {
  if (!round.findingsPath) return null;
  try {
    return parseFindings(fs.readFileSync(round.findingsPath, "utf8"));
  } catch {
    return null;
  }
}

export function fallbackReviewFromTranscript(
  round: Round,
  entriesByPath: Map<string, FileEntry>,
  engine: RuntimeEngine | null = round.reviewerRole?.engine ?? null,
): ParsedFindings | null {
  if (!round.reviewerPath) return null;
  const entry = entriesByPath.get(round.reviewerPath) ?? transcriptEntryFromPath(round.reviewerPath, engine);
  if (!entry) return null;
  const message = lastAssistantMessage(entry);
  if (!message) return null;
  return parseFindings(message.text);
}
