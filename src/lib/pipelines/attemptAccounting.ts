import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { readNativeTiming } from "@/lib/runtime/attemptTiming";
import { RecordedCheckStore, type CheckRow } from "@/lib/recordedChecks/store";
import { splitAttemptTime, type TimeSpan } from "./accounting";
import type { PipelineStageAttempt } from "./types";

export function checkTimeSpans(row: CheckRow): TimeSpan[] {
  const terminal = row.result?.terminal;
  const spans: TimeSpan[] = (terminal?.queueSpans ?? []).filter(span => span.start >= row.descriptor.startedAt
    && span.end >= span.start && span.end <= terminal!.closedAt).map(span => ({ kind: "checkQueue", ...span }));
  const report = terminal?.report;
  if (report?.executionStartedAt !== undefined && report.phase === "close"
    && report.executionStartedAt >= row.descriptor.startedAt && report.at >= report.executionStartedAt)
    spans.push({ kind: "checkRunner", start: report.executionStartedAt, end: report.at });
  return spans;
}

/** Called only for a record being written. A snapshot follows the current completion interval;
 * the weekly report needs neither a host nor retained runtime files. */
export function settleAttemptAccounting(attempt: PipelineStageAttempt): void {
  const accounting = attempt.accounting;
  if (!accounting) return;
  if (!attempt.completedAt) {
    if (accounting.time) { accounting.time = null; delete accounting.spans; }
    return;
  }
  const start = accounting.startedAt ?? attempt.startedAt ?? accounting.admittedAt;
  const delta = Date.parse(attempt.completedAt) - Date.parse(start ?? "");
  const interval = Number.isFinite(delta) && delta >= 0 ? delta : null;
  if (accounting.time && accounting.time.intervalMs === interval) return;
  const spans: TimeSpan[] = [];
  try { if (attempt.sessionId) spans.push(...readNativeTiming(attempt.sessionId)); }
  catch { /* A missing timing source leaves its whole interval unknown. */ }
  const filename = statePath("state.sqlite");
  if (attempt.launchId && fs.existsSync(filename)) {
    let checks: RecordedCheckStore | undefined;
    try {
      checks = new RecordedCheckStore(filename, false);
      if (checks.hasLedger()) for (const check of checks.forAttempt(attempt.launchId)) {
        spans.push(...checkTimeSpans(check));
        if (spans.length > 4096) { spans.length = 0; break; }
      }
    } catch { /* Unknown is retained, never extrapolated from a deadline. */ }
    finally { checks?.close(); }
  }
  accounting.spans = spans.slice(0, 4096);
  accounting.time = splitAttemptTime(start, attempt.completedAt, accounting.spans);
}
