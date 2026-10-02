import { readTaskHold, storedTaskHold } from "./hold";
import type { TaskHold, TaskStep } from "./types";

export const TASK_STEPS_LIMIT = 20;
const STEP_ID = /^[a-zA-Z0-9_-]{1,40}$/;

export type TaskStepsResult = { ok: true; steps?: TaskStep[] } | { ok: false; error: string; status: 400; code: "TASK_INVALID_FIELD"; field: "steps" };

export interface DerivedTaskStep extends TaskStep {
  effectiveState: TaskStep["state"];
  motion: "needs-you" | "working" | "waiting" | "stopped" | "done";
  since?: string;
}

export interface TaskStepsSummary {
  done: number;
  dropped: number;
  total: number;
  open: number;
  needsYou: number;
  working: number;
  reasons: Array<{ kind: "queued" | "waiting" | "postponed" | "stopped"; note: string; count: number }>;
}

/** A pipeline reference is live only when that pipeline is linked to this
    task. Finished evidence completes an open step; explicit dropped state is
    retained so a skipped cause remains visible. */
export function deriveTaskSteps(steps: readonly TaskStep[] | undefined, pipelines: readonly { id: string; state: string; pausedAt?: string | null }[], nowMs = Date.now()): { steps: DerivedTaskStep[]; summary: TaskStepsSummary | null } {
  if (!steps?.length) return { steps: [], summary: null };
  const linked = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const derived = steps.map((step): DerivedTaskStep => {
    const pipeline = step.ref ? linked.get(step.ref) : undefined;
    let effectiveState = step.state;
    const holdDue = step.hold?.kind === "postponed" && Boolean(step.hold.until) && Date.parse(step.hold.until!) <= nowMs;
    let motion: DerivedTaskStep["motion"] = step.state === "done" ? "done" : step.state === "dropped" ? "stopped"
      : step.hold?.kind === "operator" ? "needs-you"
        : step.hold && step.hold.kind !== "unstated" && !holdDue ? "waiting" : "stopped";
    if (step.state === "open") {
      if (pipeline?.state === "completed") {
        effectiveState = "done";
        motion = "done";
      } else if (step.hold?.kind !== "operator") {
        if (pipeline?.state === "needs_decision") motion = "needs-you";
        else if (pipeline && ["running", "provisioning"].includes(pipeline.state)) motion = "working";
        else if (pipeline?.state === "paused") motion = "waiting";
      }
    }
    return { ...step, effectiveState, motion, ...(pipeline?.state === "paused" && pipeline.pausedAt ? { since: pipeline.pausedAt } : {}) };
  });
  const done = derived.filter((step) => step.effectiveState === "done").length;
  const dropped = derived.filter((step) => step.effectiveState === "dropped").length;
  const open = derived.filter((step) => step.effectiveState === "open");
  const needsYou = open.filter((step) => step.motion === "needs-you").length;
  const working = open.filter((step) => step.motion === "working").length;
  const grouped = new Map<string, { kind: "queued" | "waiting" | "postponed" | "stopped"; note: string; count: number }>();
  for (const step of open) {
    const hold = step.hold;
    if (step.motion === "working" || step.motion === "needs-you") continue;
    const kind = hold?.kind === "postponed" ? "postponed"
      : step.motion === "stopped" ? "stopped"
        : hold && ["worker", "resource", "limit"].includes(hold.kind) ? "queued" : "waiting";
    const note = hold?.note?.trim() ?? "";
    const key = `${kind}\0${note}`;
    const prior = grouped.get(key);
    grouped.set(key, { kind, note, count: (prior?.count ?? 0) + 1 });
  }
  const reasons = [...grouped.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.note.localeCompare(b.note));
  return { steps: derived, summary: { done, dropped, total: derived.length, open: open.length, needsYou, working, reasons } };
}

/** Normalize a client checklist while preserving each step hold's original
    start time when the same step's reason is edited. */
export function readTaskSteps(value: unknown, now: string, by: TaskHold["by"], conversationId?: string, previous: readonly TaskStep[] = []): TaskStepsResult {
  if (value === null || value === undefined) return { ok: true };
  const fail = (): TaskStepsResult => ({ ok: false, error: "steps must contain up to 20 valid checklist items", status: 400, code: "TASK_INVALID_FIELD", field: "steps" });
  if (!Array.isArray(value) || value.length > TASK_STEPS_LIMIT) return fail();
  const old = new Map(previous.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const steps: TaskStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !STEP_ID.test(raw.id) || seen.has(raw.id)
      || typeof raw.text !== "string" || !raw.text.trim() || raw.text.trim().length > 120
      || !["done", "open", "dropped"].includes(String(raw.state))) return fail();
    seen.add(raw.id);
    const ref = raw.ref === undefined || raw.ref === null || raw.ref === "" ? undefined : typeof raw.ref === "string" || typeof raw.ref === "number" ? String(raw.ref).trim() : null;
    if (ref === null || ref && ref.length > 200) return fail();
    let hold: TaskHold | undefined;
    if (Object.hasOwn(raw, "hold")) {
      if (raw.hold !== null) {
        hold = readTaskHold(raw.hold, now, by, old.get(raw.id)?.hold, conversationId);
        if (!hold) return fail();
      }
    } else hold = old.get(raw.id)?.hold;
    steps.push({ id: raw.id, text: raw.text.trim(), state: raw.state as TaskStep["state"], ...(ref ? { ref } : {}), ...(hold ? { hold } : {}) });
  }
  return { ok: true, ...(steps.length ? { steps } : {}) };
}

/** Old or externally edited rows load safely while keeping valid entries. */
export function storedTaskSteps(value: unknown): TaskStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const steps: TaskStep[] = [];
  for (const item of value.slice(0, TASK_STEPS_LIMIT)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !STEP_ID.test(raw.id) || seen.has(raw.id)
      || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 120
      || !["done", "open", "dropped"].includes(String(raw.state))) continue;
    const ref = raw.ref === undefined || raw.ref === null ? undefined : typeof raw.ref === "string" || typeof raw.ref === "number" ? String(raw.ref).trim() : undefined;
    if (ref && ref.length > 200) continue;
    seen.add(raw.id);
    const hold = storedTaskHold(raw.hold);
    steps.push({ id: raw.id, text: raw.text.trim(), state: raw.state as TaskStep["state"], ...(ref ? { ref } : {}), ...(hold ? { hold } : {}) });
  }
  return steps.length ? steps : undefined;
}
