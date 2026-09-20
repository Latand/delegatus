import { redactMonitorText } from "../support/redactMonitorText";
export type Diagnostic = { label: string; text: string; limit: number };
export function diagnosticSummary(input: Diagnostic) {
  const clean = redactMonitorText(input.text.slice(0, input.limit)).trim();
  const points = [...clean];
  const limit = Math.max(1, Math.floor(input.limit));
  const truncated = points.length > limit;
  return { label: redactMonitorText(input.label), text: truncated ? points.slice(0, limit - 1).join("") + "…" : clean, truncated };
}
