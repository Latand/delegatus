import type { TaskHold, TaskStatus } from "./types";

export type TaskMotionKey = "needs-you" | "working" | "waiting" | "stopped" | "not-started" | "done";
export interface TaskMotion {
  key: TaskMotionKey;
  reason: TaskHold | "paused" | null;
  since: string | null;
  /** Work resumed while its declared hold remains set. */
  holdStillSet: boolean;
  due: boolean;
}
export interface TaskMotionFacts {
  status: TaskStatus;
  hold?: TaskHold;
  needsYou: boolean;
  working: number;
  inFlight: boolean;
  pipelines: readonly { state: string; pausedAt?: string | null }[];
  steps?: readonly { motion: "needs-you" | "working" | "waiting" | "stopped" | "done"; open: boolean; hold?: TaskHold; since?: string }[];
}

/** First live evidence, then declared intent. All surfaces use this projection;
    neither a finished conversation nor a historical stage means live work. */
export function taskMotion(facts: TaskMotionFacts, nowMs: number): TaskMotion {
  const { hold } = facts;
  const result = (key: TaskMotionKey, reason: TaskMotion["reason"] = null, due = false): TaskMotion => ({
    key, reason, since: typeof reason === "object" ? reason?.since ?? null : null,
    holdStillSet: key === "working" && Boolean(hold), due,
  });
  const needsYouSteps = facts.steps?.filter(step => step.open && step.motion === "needs-you") ?? [];
  const stepOperatorHold = needsYouSteps.find(step => step.hold?.kind === "operator")?.hold;
  if (facts.needsYou || hold?.kind === "operator" || needsYouSteps.length) return result("needs-you", hold?.kind === "operator" ? hold : stepOperatorHold ?? null);
  if (facts.working > 0 || facts.inFlight || facts.pipelines.some(p => p.state === "provisioning") || facts.steps?.some(step => step.motion === "working")) return result("working");
  if (facts.status === "done") return result("done");
  const openStep = facts.steps?.find(step => step.open && step.hold);
  if (openStep?.hold) {
    const due = openStep.hold.kind === "postponed" && Boolean(openStep.hold.until) && Date.parse(openStep.hold.until!) <= nowMs;
    return result(openStep.hold.kind === "unstated" || due ? "stopped" : "waiting", openStep.hold, due);
  }
  const pausedStep = facts.steps?.find(step => step.open && !step.hold && step.motion === "waiting");
  if (pausedStep) return { ...result("waiting", "paused"), since: pausedStep.since ?? null };
  if (facts.steps?.some(step => step.open)) return result("stopped");
  if (hold) {
    const due = hold.kind === "postponed" && Boolean(hold.until) && Date.parse(hold.until!) <= nowMs;
    return result(hold.kind === "unstated" || due ? "stopped" : "waiting", hold, due);
  }
  const active = facts.pipelines.filter(p => ["running", "provisioning", "needs_decision", "paused"].includes(p.state));
  if (active.length && active.every(p => p.state === "paused")) {
    return { ...result("waiting", "paused"), since: active.map(p => p.pausedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null };
  }
  return result(facts.status === "inbox" ? "not-started" : "stopped");
}
