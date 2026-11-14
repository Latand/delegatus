import { z } from "zod";

export const REPEAT_REASONS = ["review-finding", "restart", "host-lost", "account-limit", "spawn-failure", "new-requirement", "operator-revision", "unknown"] as const;
export const repeatReasonSchema = z.enum(REPEAT_REASONS);
export type RepeatReason = z.infer<typeof repeatReasonSchema>;
export const declaredClassSchema = z.object({
  size: z.string().trim().min(1).max(80).nullable().default(null),
  money: z.boolean().nullable().default(null),
  access: z.boolean().nullable().default(null),
  dataMigration: z.boolean().nullable().default(null),
}).strict();
export type DeclaredClass = z.infer<typeof declaredClassSchema>;
export const laneClassSchema = declaredClassSchema.extend({ project: z.string().min(1) });
export type LaneClass = z.infer<typeof laneClassSchema>;
export const instant = z.string().datetime({ offset: true });
export const timeKinds = ["model", "tools", "checkRunner", "checkQueue"] as const;
export type TimeKind = typeof timeKinds[number];
export type TimeSpan = { kind: TimeKind; start: number; end: number };
export const timeSpanSchema = z.object({ kind: z.enum(timeKinds), start: z.number().finite(), end: z.number().finite() }).strict().refine(span => span.end >= span.start);
const milliseconds = z.number().finite().nonnegative();
export const timeSplitSchema = z.object({
  intervalMs: milliseconds.nullable(), modelMs: milliseconds.nullable(), toolsMs: milliseconds.nullable(),
  checkQueueMs: milliseconds.nullable(), checkRunnerMs: milliseconds.nullable(), unknownMs: milliseconds.nullable(),
  toleranceMs: z.literal(0),
}).strict().refine(value => {
  const parts = [value.modelMs, value.toolsMs, value.checkQueueMs, value.checkRunnerMs];
  return value.intervalMs === null ? value.unknownMs === null && parts.every(part => part === null)
    : value.unknownMs !== null && parts.reduce<number>((total, part) => total + (part ?? 0), value.unknownMs) === value.intervalMs;
}, "time components must reconcile exactly with their interval");
export type TimeSplit = z.infer<typeof timeSplitSchema>;
export const attemptAccountingSchema = z.object({
  admittedAt: instant.nullable(), startedAt: instant.nullable(),
  spans: z.array(timeSpanSchema).max(4096).optional(),
  repeatReason: repeatReasonSchema.nullable(), time: timeSplitSchema.nullable(),
}).strict();
export type AttemptAccounting = z.infer<typeof attemptAccountingSchema>;

/** Exclusive wall time. Nested checks win over tools, and tools over turns.
 * Only closed, observed intervals are attributed; all other time is unknown.
 * Zero tolerance means the displayed components reconcile exactly. */
export function splitAttemptTime(start: string | null, end: string | null, spans: readonly TimeSpan[] = []): TimeSplit {
  const a = Date.parse(start ?? ""), b = Date.parse(end ?? "");
  const empty = { modelMs: null, toolsMs: null, checkQueueMs: null, checkRunnerMs: null, toleranceMs: 0 as const };
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return { ...empty, intervalMs: null, unknownMs: null };
  const valid = spans.filter(s => timeKinds.includes(s.kind) && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start && s.end > a && s.start < b)
    .map(s => ({ ...s, start: Math.max(a, s.start), end: Math.min(b, s.end) }));
  const changes = new Map<number, number[]>();
  const change = (at: number, kind: TimeKind, delta: number) => {
    const counts = changes.get(at) ?? [0, 0, 0, 0];
    counts[timeKinds.indexOf(kind)]! += delta; changes.set(at, counts);
  };
  for (const s of valid) { change(s.start, s.kind, 1); change(s.end, s.kind, -1); }
  changes.set(a, changes.get(a) ?? [0, 0, 0, 0]); changes.set(b, changes.get(b) ?? [0, 0, 0, 0]);
  const totals = [0, 0, 0, 0], active = [0, 0, 0, 0];
  let last = a, unknown = 0;
  for (const [at, counts] of [...changes].sort(([x], [y]) => x - y)) {
    const kind = active.findLastIndex(count => count > 0);
    if (kind < 0) unknown += at - last; else totals[kind]! += at - last;
    counts.forEach((count, index) => { active[index]! += count; }); last = at;
  }
  return { intervalMs: b - a, modelMs: valid.some(s => s.kind === "model") ? totals[0]! : null,
    toolsMs: valid.some(s => s.kind === "tools") ? totals[1]! : null,
    checkQueueMs: valid.some(s => s.kind === "checkQueue") ? totals[3]! : null,
    checkRunnerMs: valid.some(s => s.kind === "checkRunner") ? totals[2]! : null,
    unknownMs: unknown, toleranceMs: 0 };
}
