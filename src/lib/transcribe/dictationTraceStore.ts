import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import type { DictationTrace } from "./dictationTrace";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = count.nullable();
export const dictationTraceSchema = z.object({
  id: z.string().uuid(), revision: count,
  startedAt: count, stoppedAt: time, endedAt: time,
  path: z.enum(["pending", "live", "batch", "live-batch"]),
  provider: z.enum(["pending", "soniox", "elevenlabs", "openai", "batch"]),
  tokenMs: time, connectMs: time, sampleRate: count.max(384_000),
  capturedSamples: count, sentSamples: count, bufferedSamples: count.max(1_920_000), peakBufferedSamples: count.max(1_920_000),
  finalSegments: count, commits: count, replayedFinals: count,
  closeCode: count.max(4999).nullable(), closeReason: z.enum(["none", "normal", "abnormal", "error"]),
  tokenOutcome: z.enum(["pending", "ok", "deadline", "unavailable"]),
  connectOutcome: z.enum(["unused", "pending", "ok", "deadline", "error"]),
  drainOutcome: z.enum(["unused", "pending", "ok", "deadline", "error"]),
  batchOutcome: z.enum(["unused", "pending", "ok", "deadline", "error"]),
  outcome: z.enum(["recording", "complete", "incomplete", "discarded", "buffer-limit", "no-microphone"]),
}).strict();

export const DICTATION_TRACE_LIMIT = 100;
let queue: Promise<void> = Promise.resolve();
let pending = 0;
/** Last 100 sessions, one async writer, at most 32 pending writes. Revisions
 * make delayed/retried browser checkpoints harmless, including across restart. */
export async function recordDictationTrace(value: DictationTrace): Promise<boolean> {
  const trace = dictationTraceSchema.parse(value);
  if (pending >= 32) return false;
  pending++;
  const file = statePath("diagnostics", "dictation.json");
  const write = queue.then(async () => {
    let records: DictationTrace[] = [];
    try {
      const contents = await fs.readFile(file, "utf8");
      records = z.array(dictationTraceSchema).max(DICTATION_TRACE_LIMIT).parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Dictation diagnostic read failed");
    }
    const existing = records.find(row => row.id === trace.id);
    if (existing && existing.revision >= trace.revision) return;
    records = [...records.filter(row => row.id !== trace.id), trace]
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-DICTATION_TRACE_LIMIT);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await fs.rename(temporary, file);
  });
  queue = write.catch(() => undefined);
  try { await write; return true; } finally { pending--; }
}
