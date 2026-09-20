import { redactSecrets } from "@/lib/review";

export const SENSITIVE_RECORD_KEY = /(?:api.?key|access.?token|refresh.?token|authorization|bearer|secret|password|passwd|pwd|token|cookie)/i;
export const SENSITIVE_RECORD_TEXT = /(?:api|token|authorization|bearer|secret|password|passwd|pwd)/i;
const JSON_SECRET_VALUE = /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)"\s*:\s*")[^"]*/gi;
const INLINE_SECRET_VALUE = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)\s*[:=]\s*["']?)[^\s"',}]+/gi;
const BEARER_SECRET_VALUE = /(\bbearer\s+)[^\s"',}]+/gi;

export function redactTranscriptText(value: string): string {
  const bearerSafe = value.replace(BEARER_SECRET_VALUE, "$1[redacted]");
  return redactSecrets(bearerSafe).replace(JSON_SECRET_VALUE, "$1[redacted]").replace(INLINE_SECRET_VALUE, "$1[redacted]");
}

/** Sanitize the structured argument before JSON formatting loses key context.
 * The shared node/character budgets also bound wide trees; depth alone cannot.
 * Only newly built plain values reach JSON.stringify (never a source toJSON).
 */
export function boundedToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  let nodes = 160;
  let characters = 24_000;
  const visit = (value: unknown, key: string, depth: number): unknown => {
    if (--nodes < 0 || depth > 8 || characters <= 0) return "[display limit]";
    if (SENSITIVE_RECORD_KEY.test(key)) return "[redacted]";
    if (typeof value === "string") {
      const limit = Math.min(4_000, characters);
      // Bound text work too. Redaction consumes an entire token even when the
      // display boundary cuts it; sensitive-key values never reach this branch.
      const bounded = value.slice(0, limit);
      characters -= bounded.length;
      return redactTranscriptText(bounded) + (value.length > limit ? "…" : "");
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const child of value) {
        if (output.length >= 40 || nodes <= 0 || characters <= 0) {
          output.push("[display limit]");
          break;
        }
        output.push(visit(child, "", depth + 1));
      }
      return output;
    }
    if (!value || typeof value !== "object") return null;
    const output: Record<string, unknown> = Object.create(null);
    let fields = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++fields > 80 || nodes <= 0 || characters <= 0) {
        output.__truncated__ = "[display limit]";
        break;
      }
      output[key] = visit((value as Record<string, unknown>)[key], key, depth + 1);
    }
    return output;
  };
  return visit(args, "", 0) as Record<string, unknown>;
}
