import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { ONBOARDING_STEP_IDS, type OnboardingStepId, type OnboardingStepState, type OnboardingWalkState } from "./steps";

/**
 * Whether this install has been through the setup guide (#1876, design §6).
 *
 * Server-side and per install, so a second browser or the phone never replays
 * it. Absent means "never decided"; the client opens the guide only then. The
 * first read of an absent marker decides once whether this is an upgrade: an
 * install that already holds Viewer-written state gets a marker dismissed as
 * `existing-install` and never sees the guide open by itself. Transcripts under
 * the engines' own homes are not Viewer state, which is what lets the guide
 * reach someone who ran `claude` before they ever opened the Viewer.
 */

export { ONBOARDING_STEP_IDS, type OnboardingStepId, type OnboardingStepState, type OnboardingWalkState } from "./steps";

/** The last health check this install ran (#1876, design §6), written by the
    check itself. Design §6 gives a failed one a `warning` dot on the "Setup
    guide" menu row; the menu rows belong to slice 1's fence, so this slice
    records the result and the dot lands with the menu work. Nothing reads the
    field yet. */
export type OnboardingLastHealth = { at: string; result: "passed" | "failed" | "stopped" | "running"; failedCode: string | null };

export type OnboardingMarker = {
  schemaVersion: 1;
  completedAt: string | null;
  dismissedAt: string | null;
  reason: "existing-install" | null;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  lastHealth: OnboardingLastHealth | null;
  /** The interface walk (#2166 §3.8): null until it ran once and was
      finished or skipped. A marker written before the field reads null. */
  walk: OnboardingWalkState;
};

const markerFile = () => statePath("onboarding.json");

export function emptySteps(): Record<OnboardingStepId, OnboardingStepState> {
  return Object.fromEntries(ONBOARDING_STEP_IDS.map((id) => [id, null])) as Record<OnboardingStepId, OnboardingStepState>;
}

function parseLastHealth(raw: unknown): OnboardingLastHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const result = record.result;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return null;
  if (result !== "passed" && result !== "failed" && result !== "stopped" && result !== "running") return null;
  return { at: record.at, result, failedCode: typeof record.failedCode === "string" ? record.failedCode : null };
}

function parseMarker(raw: unknown): OnboardingMarker | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  const steps = emptySteps();
  const rawSteps = record.steps && typeof record.steps === "object" && !Array.isArray(record.steps) ? record.steps as Record<string, unknown> : {};
  for (const id of ONBOARDING_STEP_IDS) {
    const value = rawSteps[id];
    steps[id] = value === "done" || value === "skipped" ? value : null;
  }
  return {
    schemaVersion: 1,
    completedAt: time(record.completedAt),
    dismissedAt: time(record.dismissedAt),
    reason: record.reason === "existing-install" ? "existing-install" : null,
    steps,
    lastHealth: parseLastHealth(record.lastHealth),
    walk: record.walk === "done" || record.walk === "skipped" ? record.walk : null,
  };
}

export function readOnboardingMarker(file = markerFile()): OnboardingMarker | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    /* A damaged marker reads as a dismissed one: it must never reopen the
       guide over someone's board, and the menu row still reaches it. */
    return parseMarker(JSON.parse(text)) ?? { ...freshMarker(), dismissedAt: new Date(0).toISOString() };
  } catch {
    return { ...freshMarker(), dismissedAt: new Date(0).toISOString() };
  }
}

export function writeOnboardingMarker(marker: OnboardingMarker, file = markerFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(marker, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

export function freshMarker(): OnboardingMarker {
  return { schemaVersion: 1, completedAt: null, dismissedAt: null, reason: null, steps: emptySteps(), lastHealth: null, walk: null };
}

/** Whether the install already holds state the Viewer wrote: a seat (active,
    pending or revoked), a pipeline, a task, or a saved agent mapping. Each is
    read through its store's reader by the caller that supplies it. */
export type ExistingInstallEvidence = () => boolean;

/**
 * The marker as the guide sees it. The first read of an absent marker decides
 * once: existing Viewer state writes `existing-install`; otherwise the marker
 * stays absent and the guide opens. An evidence read that fails counts as an
 * existing install, so a broken store never throws a wizard over a real board.
 */
export function resolveOnboardingMarker(evidence: ExistingInstallEvidence, now = () => new Date().toISOString(), file = markerFile()): OnboardingMarker | null {
  const current = readOnboardingMarker(file);
  if (current) return current;
  let existing: boolean;
  try {
    existing = evidence();
  } catch {
    existing = true;
  }
  if (!existing) return null;
  const marker: OnboardingMarker = { ...freshMarker(), dismissedAt: now(), reason: "existing-install" };
  writeOnboardingMarker(marker, file);
  return marker;
}

/** Step ids an older guide wrote (the Tour, retired by #2166). */
const RETIRED_STEP_IDS: ReadonlySet<string> = new Set(["tour"]);

export type OnboardingPatch = {
  completed?: true;
  dismissed?: true;
  steps?: Partial<Record<OnboardingStepId, OnboardingStepState>>;
  walk?: Exclude<OnboardingWalkState, null>;
};

export function parseOnboardingPatch(raw: unknown): OnboardingPatch | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "request body must be an object";
  const record = raw as Record<string, unknown>;
  const allowed = new Set(["completed", "dismissed", "steps", "walk"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) return `unknown field: ${unknown.join(", ")}`;
  const patch: OnboardingPatch = {};
  for (const flag of ["completed", "dismissed"] as const) {
    if (record[flag] === undefined) continue;
    if (record[flag] !== true) return `${flag} must be true`;
    patch[flag] = true;
  }
  if (record.walk !== undefined) {
    if (record.walk !== "done" && record.walk !== "skipped") return "walk must be done or skipped";
    patch.walk = record.walk;
  }
  if (record.steps !== undefined) {
    if (!record.steps || typeof record.steps !== "object" || Array.isArray(record.steps)) return "steps must be an object";
    patch.steps = {};
    for (const [id, value] of Object.entries(record.steps as Record<string, unknown>)) {
      /* A tab still running the six-step guide may send the Tour's id: it is
         dropped, the way the reader drops it. */
      if (RETIRED_STEP_IDS.has(id)) continue;
      if (!(ONBOARDING_STEP_IDS as readonly string[]).includes(id)) return `unknown step: ${id}`;
      if (value !== "done" && value !== "skipped" && value !== null) return `steps.${id} must be done, skipped or null`;
      patch.steps[id as OnboardingStepId] = value;
    }
  }
  return patch;
}

/** Writing any patch creates the marker, which is what keeps a guide in
    progress from being re-decided as an upgrade after a restart. */
export function applyOnboardingPatch(current: OnboardingMarker | null, patch: OnboardingPatch, now: string): OnboardingMarker {
  const next: OnboardingMarker = current ? structuredClone(current) : freshMarker();
  if (patch.steps) Object.assign(next.steps, patch.steps);
  if (patch.dismissed) next.dismissedAt = now;
  if (patch.completed) next.completedAt = now;
  if (patch.walk) next.walk = patch.walk;
  return next;
}

/** Record the health check's result. It creates the marker if needed, which a
    check can only have been run from inside the guide anyway. */
export function writeLastHealth(lastHealth: OnboardingLastHealth, file = markerFile()): OnboardingMarker {
  const next: OnboardingMarker = { ...(readOnboardingMarker(file) ?? freshMarker()), lastHealth };
  writeOnboardingMarker(next, file);
  return next;
}
