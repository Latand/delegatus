/** Numeric counters and closed vocabularies only. No audio, text, key or raw error. */
export interface DictationTrace {
  id: string;
  revision: number;
  startedAt: number;
  stoppedAt: number | null;
  endedAt: number | null;
  path: "pending" | "live" | "batch" | "live-batch";
  provider: "pending" | "soniox" | "elevenlabs" | "openai" | "batch";
  tokenMs: number | null;
  connectMs: number | null;
  sampleRate: number;
  capturedSamples: number;
  sentSamples: number;
  bufferedSamples: number;
  peakBufferedSamples: number;
  finalSegments: number;
  commits: number;
  replayedFinals: number;
  closeCode: number | null;
  closeReason: "none" | "normal" | "abnormal" | "error";
  tokenOutcome: "pending" | "ok" | "deadline" | "unavailable";
  connectOutcome: "unused" | "pending" | "ok" | "deadline" | "error";
  drainOutcome: "unused" | "pending" | "ok" | "deadline" | "error";
  batchOutcome: "unused" | "pending" | "ok" | "deadline" | "error";
  outcome: "recording" | "complete" | "incomplete" | "discarded" | "buffer-limit" | "no-microphone";
}
export function newDictationTrace(): DictationTrace {
  return { id: crypto.randomUUID(), revision: 0, startedAt: Date.now(), stoppedAt: null, endedAt: null,
    path: "pending", provider: "pending", tokenMs: null, connectMs: null, sampleRate: 0,
    capturedSamples: 0, sentSamples: 0, bufferedSamples: 0, peakBufferedSamples: 0,
    finalSegments: 0, commits: 0, replayedFinals: 0, closeCode: null, closeReason: "none",
    tokenOutcome: "pending", connectOutcome: "unused", drainOutcome: "unused", batchOutcome: "unused", outcome: "recording" };
}
const STORAGE_KEY = "delegatus.dictation.diagnostics";
/** Keep eight numeric snapshots for retry on the next diagnostic transition. */
export function publishDictationTrace(trace: DictationTrace): void {
  trace.revision++;
  let records: DictationTrace[] = [];
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) records = stored.filter(row => row && typeof row === "object"
      && typeof row.id === "string" && Number.isSafeInteger(row.revision)).slice(-7);
  } catch { /* Storage can be disabled. */ }
  records = [...records.filter(r => r.id !== trace.id), { ...trace }].slice(-8);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* Quota or disabled storage. */ }
  // The server validates every field; even a modified local snapshot cannot log text.
  for (const record of records) {
    void fetch("/api/transcribe/diagnostics", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(record), keepalive: true, signal: AbortSignal.timeout(5_000) }).then(response => {
        if (!response.ok) return;
        try {
          const pending: DictationTrace[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pending.filter(row => row.id !== record.id || row.revision > record.revision).slice(-8)));
        } catch { /* Storage is optional; server retention is authoritative. */ }
      }).catch(() => undefined);
  }
}
