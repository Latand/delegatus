import { ViewValidationError } from "./validation";

/**
 * Slow keystroke-to-paint samples a browser reports about its own composer
 * (`src/lib/typingLatencyBeacon.ts`). A sample is four numbers and carries
 * nothing the operator typed: not the text, not a length, not an element or
 * conversation identity. The wire shape is closed — an unknown key is refused,
 * so the beacon cannot be turned into a channel for anything else.
 */
export const MAX_TYPING_SAMPLES = 8;
export const MAX_TYPING_LATENCY_BYTES = 2048;
export const TYPING_LATENCY_KEYS = ["schemaVersion", "samples"] as const;
export const TYPING_SAMPLE_KEYS = ["at", "ms", "delayMs", "animations"] as const;

export interface TypingLatencySample {
  /** Epoch milliseconds when the key event was dispatched. */
  at: number;
  /** Input event to next paint, as the Event Timing API reports it. */
  ms: number;
  /** The part of it spent before any handler could run (main thread busy). */
  delayMs: number;
  /** Animations running in the document at that moment. */
  animations: number;
}

export interface TypingLatencyReport {
  schemaVersion: 1;
  samples: TypingLatencySample[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ViewValidationError("INVALID_REQUEST", `unknown ${field}.${unknown} (allowed: ${allowed.join(", ")})`);
}
function whole(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new ViewValidationError("INVALID_REQUEST", `invalid ${field}`);
  return value;
}

export function validateTypingLatency(value: unknown): TypingLatencyReport {
  const body = record(value, "request");
  exact(body, TYPING_LATENCY_KEYS, "request");
  if (body.schemaVersion !== 1) throw new ViewValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion must be 1");
  if (!Array.isArray(body.samples) || body.samples.length === 0 || body.samples.length > MAX_TYPING_SAMPLES) throw new ViewValidationError("INVALID_REQUEST", "invalid samples");
  return {
    schemaVersion: 1,
    samples: body.samples.map((item, index) => {
      const sample = record(item, `samples[${index}]`);
      exact(sample, TYPING_SAMPLE_KEYS, `samples[${index}]`);
      return {
        at: whole(sample.at, "at", 8_640_000_000_000_000),
        ms: whole(sample.ms, "ms", 600_000),
        delayMs: whole(sample.delayMs, "delayMs", 600_000),
        animations: whole(sample.animations, "animations", 100_000),
      };
    }),
  };
}

/** At most this many reports reach the log per window, whoever sends them. */
export const TYPING_LOG_LIMIT = 30;
export const TYPING_LOG_WINDOW_MS = 60_000;

export function createTypingLatencyLog(write: (line: string) => void, now: () => number = Date.now) {
  let windowStart = 0;
  let written = 0;
  let dropped = 0;
  return {
    /** Returns whether the report was written (false: over the window's limit). */
    record(report: TypingLatencyReport): boolean {
      const at = now();
      if (at - windowStart >= TYPING_LOG_WINDOW_MS) { windowStart = at; written = 0; }
      if (written >= TYPING_LOG_LIMIT) { dropped += 1; return false; }
      written += 1;
      const slowest = Math.max(...report.samples.map((sample) => sample.ms));
      write(`[typing-latency] ${JSON.stringify({ slowestMs: slowest, samples: report.samples, droppedReports: dropped })}`);
      dropped = 0;
      return true;
    },
  };
}
