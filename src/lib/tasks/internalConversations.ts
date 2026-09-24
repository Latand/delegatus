import type { FileEntry } from "@/lib/types";

/**
 * Conversations nobody will ever name, recognised before they mint a task.
 *
 * The scanned-conversation admission gives every root transcript a placeholder
 * task whose title waits for the agent's first action. Two kinds of transcript
 * never take one:
 *
 * - `handoff-digest` — the one-shot summarizer a seat rotation runs to compact
 *   its mandate's history (`orchestrator/handoffDigest.ts`). It runs headless
 *   in a fresh directory under the state directory, so every rotation drew a
 *   card of its own in a project of its own.
 * - `probe` — a one-line "reply with ok" check an agent or a script runs to see
 *   whether an account or a CLI answers. Nothing launched it through the
 *   Viewer and it has no work to report.
 *
 * Both are recognised from the transcript alone, by path and by prompt, so the
 * answer is the same whether or not the helper's directory still exists. They
 * join no task: the board still lists the transcript, it just owns no card.
 */
export type InternalConversationKind = "handoff-digest" | "probe";

/** The directory segments a handoff digest runs under: `<state>/orchestrator/handoff-digests/<request>/cwd`. */
const HANDOFF_DIGEST_SEGMENTS = ["state", "orchestrator", "handoff-digests"] as const;

/** The first words of the summarizer's own instructions, which is the title the
    scanner derives for it when the directory is gone from the record. */
export const HANDOFF_DIGEST_TITLE_PREFIX = "You are compacting the rotation history of a project manager agent";

/**
 * A one-line prompt that asks for a fixed acknowledgement word and nothing
 * else: "Reply with exactly: ok", "Reply with the single word ok.", "Respond
 * with just PONG". Anchored at both ends, so a real task that merely mentions
 * replying never matches.
 */
const PROBE_PROMPT = /^(?:please\s+)?(?:reply|respond|answer|say)(?:\s+(?:with|only|just|back))*(?:\s+(?:exactly|only|just))?(?:\s*:)?(?:\s+(?:the|a))?(?:\s+(?:single|one))?(?:\s+word)?(?:\s*:)?\s*["'`]?(?:ok|okay|pong|ready|yes|ack|hi|hello)["'`]?\s*[.!]?$/i;

function segmentsOf(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter(Boolean);
}

function underHandoffDigest(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const segments = segmentsOf(cwd);
  for (let index = 0; index + HANDOFF_DIGEST_SEGMENTS.length <= segments.length; index += 1) {
    if (HANDOFF_DIGEST_SEGMENTS.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}

/** Whether a prompt's first line is a bare "reply with ok" check. */
export function isProbePrompt(text: string | null | undefined): boolean {
  const lines = (text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length === 1 && PROBE_PROMPT.test(lines[0]!);
}

export function internalConversationKind(
  entry: Pick<FileEntry, "cwd" | "title" | "spawnOrigin">,
): InternalConversationKind | null {
  if (underHandoffDigest(entry.cwd) || (entry.title ?? "").trim().startsWith(HANDOFF_DIGEST_TITLE_PREFIX)) return "handoff-digest";
  /* A launch the Viewer made carries its own membership from the reservation;
     only a transcript that arrived from outside is judged by its prompt. */
  if (entry.spawnOrigin !== "viewer" && isProbePrompt(entry.title)) return "probe";
  return null;
}
