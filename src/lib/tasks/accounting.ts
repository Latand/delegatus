import { z } from "zod";
import { declaredClassSchema, instant, laneClassSchema } from "@/lib/pipelines/accounting";
import type { BoardTask } from "./types";

export const taskAccountingSchema = z.object({
  criteria: z.string().trim().min(1).max(20000).nullable(),
  holds: z.array(z.object({ kind: z.string(), since: instant, endedAt: instant.nullable() }).strict()
    .refine(hold => hold.endedAt === null || Date.parse(hold.endedAt) >= Date.parse(hold.since))).default([]),
  declaredClass: laneClassSchema,
  originalTaskId: z.string().min(1).nullable(),
  correctsTaskId: z.string().min(1).nullable(),
  readyAt: instant.nullable(),
  accepted: z.object({ at: instant, evidence: z.string().trim().min(1).max(2000), by: z.enum(["operator", "agent"]) }).strict().nullable(),
}).strict().refine(value => value.accepted === null || value.criteria !== null && value.readyAt !== null
  && Date.parse(value.accepted.at) >= Date.parse(value.readyAt), "acceptance requires creation criteria and a preceding ready observation");
export type TaskAccounting = z.infer<typeof taskAccountingSchema>;
export const taskDeclarationSchema = z.object({
  criteria: z.string().trim().min(1).max(20000).nullable().default(null),
  taskClass: declaredClassSchema.optional(),
  originalTaskId: z.string().min(1).nullable().default(null),
  correctsTaskId: z.string().min(1).nullable().default(null),
}).strict();
export const acceptTaskSchema = z.object({ evidence: z.string().trim().min(1).max(2000) }).strict();

export function taskDeclaration(value: unknown, project: string, now: string, held: BoardTask["hold"], existing: readonly BoardTask[], canonical: (project: string) => string = value => value) {
  project = canonical(project);
  const parsed = taskDeclarationSchema.safeParse(value ?? {});
  if (!parsed.success) return { ok: false as const, status: 400, field: "accounting", error: "invalid task accounting declaration" };
  const input = parsed.data;
  for (const id of [input.originalTaskId, input.correctsTaskId]) {
    if (id && !existing.some(task => task.id === id && canonical(task.project) === project))
      return { ok: false as const, status: 400, field: "accounting", error: "accounting task reference must name an existing task in this project" };
  }
  const parent = input.originalTaskId && existing.find(task => task.id === input.originalTaskId);
  if (parent && (parent.accounting?.originalTaskId || parent.accounting?.correctsTaskId))
    return { ok: false as const, status: 400, field: "accounting", error: "originalTaskId must name an original task" };
  return { ok: true as const, accounting: taskAccountingSchema.parse({ criteria: input.criteria,
    declaredClass: { ...declaredClassSchema.parse(input.taskClass ?? {}), project },
    originalTaskId: input.originalTaskId, correctsTaskId: input.correctsTaskId,
    holds: held && instant.safeParse(held.since).success ? [{ kind: held.kind, since: held.since, endedAt: null }] : [],
    readyAt: held || !instant.safeParse(now).success ? null : now, accepted: null }) };
}

/** Retain each observed hold transition even after the board clears its hold. */
export function retainAccountingHold(task: BoardTask): void {
  if (!task.accounting || !instant.safeParse(task.updatedAt).success) return;
  const accounting = task.accounting;
  const holds = accounting.holds ?? [];
  const open = holds.at(-1);
  if (open?.endedAt === null && open.kind === task.hold?.kind && open.since === task.hold?.since) return;
  if (open?.endedAt === null) open.endedAt = task.updatedAt;
  if (task.hold) holds.push({ kind: task.hold.kind, since: task.hold.since, endedAt: null });
  accounting.holds = holds;
  if (!task.hold && task.status !== "blocked" && !accounting.readyAt) accounting.readyAt = task.updatedAt;
}
