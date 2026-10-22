import type { ConversationReason } from "@/components/attention";
import type { MobileAttentionEntry } from "@/components/attention/attentionQueue";
import type { DoneItemV1 } from "@/lib/done/types";
import type { Pipeline, PipelineMergeState } from "@/lib/pipelines/types";

import type { CueRequest } from "./cues";

/**
 * The board's sources of the sound map (docs/design/sound-redesign.md §4.1–§4.3),
 * as pure planners: the previous read and the current one in, the cue
 * requests the difference earns out. What sounds, when, stays the player's
 * call: identity, staleness, windows, gaps, caps and the lane.
 *
 * Every planner baselines on its first certified read, so a reload over work
 * that is already waiting stays silent, and absorbs what a new scope shows the
 * first time it shows it.
 */

// ── S6 and S7: the needs-you queue (§4.1) ──────────────────────────────────

/**
 * Which sound a conversation reason earns. The inferred «asks you» (`ask`) is
 * the classifier's reading of an agent's prose, mostly an orchestrator tick
 * ending in a question: it earns none, and the badge still counts it.
 */
const SOUND_OF_REASON: Record<ConversationReason["kind"], "your-move" | "fault" | null> = {
  decision: "your-move",
  question: "your-move",
  plan: "your-move",
  permission: "your-move",
  delivery: "fault",
  launch: "fault",
  memory: "fault",
  ask: null,
};

export interface QueueCuePlan {
  /** The entries of the last certified read. */
  seen: Set<string>;
  scope: string;
  requests: CueRequest[];
}

/**
 * The request one needs-you entry earns, with its obligation key (the task
 * when the entry names one, else the entry) and its own clock of asking: a
 * conversation's `raisedAt` (never `since`: a stuck delivery asks half an
 * hour after its admission), a parked lane's `now − seconds`, a form's
 * `createdAt`, the update decision's `at`.
 */
function needsYouRequest(entry: MobileAttentionEntry, now: number): CueRequest | null {
  const eventId = `needs-you:${entry.id}`;
  switch (entry.kind) {
    case "conversation": {
      const cue = SOUND_OF_REASON[entry.item.reason.kind];
      if (!cue) return null;
      return { cue, eventId, occurredAt: entry.item.reason.raisedAt * 1000, obligation: entry.id };
    }
    case "pipeline":
      return {
        cue: "your-move",
        eventId,
        occurredAt: entry.row.seconds === null ? now : now - entry.row.seconds * 1000,
        obligation: entry.row.pipeline.taskIds?.[0] ?? entry.id,
      };
    case "prototype":
      return { cue: "your-move", eventId, occurredAt: parseTime(entry.notice.createdAt, now), obligation: entry.notice.taskId ?? entry.id };
    case "update":
      return { cue: "your-move", eventId, occurredAt: parseTime(entry.decision.at, now), obligation: entry.id };
  }
}

/**
 * `certified` is the payload's own claim to `scope`. A scope still loading is
 * answered by the last certified representation re-labelled for it (#1432);
 * planning on that stand-in would make the pending scope the baseline, so an
 * uncertified read changes nothing.
 */
export function planNeedsYouCues(
  entries: readonly MobileAttentionEntry[],
  previous: QueueCuePlan | null,
  scope: string,
  now: number,
  certified = true,
): QueueCuePlan | null {
  if (!certified) return previous;
  const seen = new Set(entries.map((entry) => entry.id));
  if (!previous || previous.scope !== scope) return { seen, scope, requests: [] };
  const requests: CueRequest[] = [];
  for (const entry of entries) {
    if (previous.seen.has(entry.id)) continue;
    const request = needsYouRequest(entry, now);
    if (request) requests.push(request);
  }
  return { seen, scope, requests };
}

// ── S3, S4 and S7: the board's pipelines (§4.2) ────────────────────────────

interface TrackedLane {
  passed: Set<string>;
  merge: PipelineMergeState | null;
  completed: boolean;
}

export interface PipelineCuePlan {
  tracked: Map<string, TrackedLane>;
  scope: string;
  requests: CueRequest[];
}

function trackLane(pipeline: Pipeline): TrackedLane {
  const passed = new Set<string>();
  for (const run of pipeline.runs ?? []) {
    for (const attempt of run.attempts ?? []) {
      /* Lineage-adopted evidence is history, never this lane's progress. */
      if (attempt.state === "passed" && !attempt.historical) passed.add(`${run.stageId}:${attempt.n}`);
    }
  }
  return { passed, merge: pipeline.merge?.state ?? null, completed: pipeline.state === "completed" };
}

function attemptCompletedAt(pipeline: Pipeline, key: string): string | null {
  for (const run of pipeline.runs ?? []) {
    for (const attempt of run.attempts ?? []) {
      if (`${run.stageId}:${attempt.n}` === key) return attempt.completedAt;
    }
  }
  return null;
}

/**
 * - S3 on an attempt entering `passed`, keyed `step:<lane>:<stage>:<n>`;
 * - S4 on the merge entering `merged`, or the lane entering `completed` with
 *   no merge state, keyed `landed:<lane>` so a merged lane that then completes
 *   lands once; a lane completing with its merge `blocked` or `cancelled`
 *   never lands;
 * - S7 on the merge entering `blocked`, keyed `merge-blocked:<lane>`.
 *
 * A lane new to the scope is compared with nothing; the staleness rule
 * absorbs whatever old history it brings.
 */
export function planPipelineCues(
  pipelines: readonly Pipeline[],
  previous: PipelineCuePlan | null,
  scope: string,
  certified = true,
  /** The fallback clock for a record missing its own time. */
  now = Date.now(),
): PipelineCuePlan | null {
  if (!certified) return previous;
  const tracked = new Map(pipelines.map((pipeline) => [pipeline.id, trackLane(pipeline)]));
  if (!previous || previous.scope !== scope) return { tracked, scope, requests: [] };
  const requests: CueRequest[] = [];
  const empty: TrackedLane = { passed: new Set(), merge: null, completed: false };
  for (const pipeline of pipelines) {
    const was = previous.tracked.get(pipeline.id) ?? empty;
    const cur = tracked.get(pipeline.id)!;
    for (const key of cur.passed) {
      if (was.passed.has(key)) continue;
      const completedAt = attemptCompletedAt(pipeline, key);
      requests.push({ cue: "step", eventId: `step:${pipeline.id}:${key}`, occurredAt: parseTime(completedAt, now), pipeline: pipeline.id });
    }
    if (cur.merge === "merged" && was.merge !== "merged") {
      requests.push({ cue: "landed", eventId: `landed:${pipeline.id}`, occurredAt: parseTime(pipeline.merge?.mergedAt ?? null, now), pipeline: pipeline.id });
    } else if (cur.completed && !was.completed && cur.merge === null) {
      requests.push({ cue: "landed", eventId: `landed:${pipeline.id}`, occurredAt: parseTime(pipeline.closedAt, now), pipeline: pipeline.id });
    }
    if (cur.merge === "blocked" && was.merge !== "blocked") {
      requests.push({ cue: "fault", eventId: `merge-blocked:${pipeline.id}`, occurredAt: parseTime(pipeline.merge?.blockedAt ?? null, now) });
    }
  }
  return { tracked, scope, requests };
}

// ── S5 and the deploy and limit faults: the «Готово» feed (§4.3) ──────────

/** A deploy restarts the Viewer, so its item is read after the reload. */
export const DEPLOY_FRESH_MS = 5 * 60_000;
/** Done keys that sounded, remembered across reloads of this tab. */
export const HEARD_KEYS_STORAGE_KEY = "llvAudioHeardDone";
export const HEARD_KEYS_CAPACITY = 256;

export interface HeardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HeardKeys {
  has(key: string): boolean;
  add(key: string): void;
}

/** The done keys this tab has sounded, kept in `sessionStorage` so a second reload stays silent. */
export function createHeardKeys(storage: HeardStorage | null): HeardKeys {
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(storage?.getItem(HEARD_KEYS_STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) keys = parsed.filter((key): key is string => typeof key === "string").slice(-HEARD_KEYS_CAPACITY);
  } catch {
    /* unreadable: start empty */
  }
  return {
    has: (key) => keys.includes(key),
    add(key) {
      if (keys.includes(key)) return;
      keys.push(key);
      if (keys.length > HEARD_KEYS_CAPACITY) keys = keys.slice(-HEARD_KEYS_CAPACITY);
      try {
        storage?.setItem(HEARD_KEYS_STORAGE_KEY, JSON.stringify(keys));
      } catch {
        /* storage refused: memory for this page only */
      }
    },
  };
}

function doneRequest(item: DoneItemV1, now: number): CueRequest | null {
  const eventId = `done:${item.key}`;
  const occurredAt = parseTime(item.at, now);
  if (item.kind === "deploy") {
    const phase = item.refs?.phase;
    if (phase === "succeeded") return { cue: "released", eventId, occurredAt, maxAgeMs: DEPLOY_FRESH_MS };
    if (phase === "failed" || phase === "rolled-back") return { cue: "fault", eventId, occurredAt, maxAgeMs: DEPLOY_FRESH_MS };
    return null;
  }
  if (item.kind === "limit") return { cue: "fault", eventId, occurredAt };
  return null;
}

export interface DoneCuePlan {
  seen: Set<string>;
  requests: CueRequest[];
}

/**
 * S5 on a deploy item with phase `succeeded`; S7 on `failed` or
 * `rolled-back`, and on a limit episode. Every other kind is silent: its
 * news already sounded as a landing. On the baseline read a deploy item less
 * than 5 minutes old still sounds, because the deploy restarted the page that
 * would have heard it; every key that sounded is remembered so a second
 * reload stays silent.
 */
export function planDoneCues(items: readonly DoneItemV1[], previous: DoneCuePlan | null, now: number, heard: HeardKeys): DoneCuePlan {
  const seen = new Set(items.map((item) => item.key));
  const requests: CueRequest[] = [];
  for (const item of items) {
    if (previous?.seen.has(item.key) || heard.has(item.key)) continue;
    const request = doneRequest(item, now);
    if (!request) continue;
    if (!previous && !(item.kind === "deploy" && now - request.occurredAt! < DEPLOY_FRESH_MS)) continue;
    heard.add(item.key);
    requests.push(request);
  }
  return { seen, requests };
}

function parseTime(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
