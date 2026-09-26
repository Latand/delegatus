import { useMemo, useSyncExternalStore } from "react";

import type { AttentionDismissalMark, DismissalOutcome, DismissalSubject, DismissalSubjectRequest, DismissalTarget, DismissedBy } from "@/lib/attention/dismissalTypes";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { laneMovedAt, laneMovedSince } from "@/lib/pipelines/laneMovement";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

/*
 * The click's side of a dismissal (docs/design/needs-attention.md §5): the one
 * request both cards send, and the few seconds between the click and the poll
 * that carries the server's record.
 *
 * A dismissal is drawn the moment it is clicked. It is layered over the polled
 * file list at the one place the Viewer reads it, so the card, the phone's ⚠
 * count and the queue all stop flagging it in the same frame, and it is
 * replaced by the server's own instant when the request answers. The layer
 * retires once the poll carries that instant, or after a bound, whichever
 * comes first: past that the server is the answer. It covers what the card
 * drew and nothing newer: a conversation's mark names the reason on the card,
 * and a lane that moved since the card drew it is not drawn over.
 */

/** How long a layered dismissal outlives an answer the poll never reflected. */
const OVERLAY_TTL_MS = 30_000;

interface ConversationEntry {
  /** The mark to draw, or null for an undo. It names the reason the card
      drew, which is all it covers, whichever clock dated it. */
  mark: AttentionDismissalMark | null;
  /** When the layer stops being drawn whatever the poll says. */
  until: number;
}

interface PipelineEntry {
  dismissedAt: string | null;
  dismissedBy: DismissedBy | null;
  /** The movement the card drew the lane at, when it said. */
  drawn: number | null | undefined;
  /** The stamp is this device's clock, not the server's: until the answer
      replaces it, it covers the movement the card drew even when this clock
      runs behind the engine's. */
  local: boolean;
  until: number;
}

interface ReportEntry {
  /** Resolved, or taken back by an undo. */
  resolved: boolean;
  until: number;
}

const conversations = new Map<string, ConversationEntry>();
const pipelines = new Map<string, PipelineEntry>();
/* An orchestrator's decision request, by its seq: the needs-you row and the
   report log's tick read this one layer, so both change on the same click. */
const reports = new Map<number, ReportEntry>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** What a subject the card drew is keyed by on the layer: the durable
    conversation id, else the transcript path. */
function conversationKey(subject: { conversationId?: string | null; path?: string | null }): string | null {
  return subject.conversationId || subject.path || null;
}

function drop(now: number): void {
  for (const [key, entry] of conversations) if (entry.until <= now) conversations.delete(key);
  for (const [key, entry] of pipelines) if (entry.until <= now) pipelines.delete(key);
  for (const [key, entry] of reports) if (entry.until <= now) reports.delete(key);
}

/** Layer a dismissal (or its undo) over what the board draws, now. `local`
    marks one stamped on this device before the server answered. */
export function layerDismissal(subjects: readonly DismissalSubjectRequest[], mark: { at: string; by: DismissedBy } | null, local: boolean, nowMs = Date.now()): void {
  const until = nowMs + OVERLAY_TTL_MS;
  for (const subject of subjects) {
    if (subject.kind === "report") {
      reports.set(subject.seq, { resolved: mark !== null, until });
      continue;
    }
    if (subject.kind === "pipeline") {
      pipelines.set(subject.pipelineId, { dismissedAt: mark?.at ?? null, dismissedBy: mark?.by ?? null, drawn: subject.laneMovedAt, local, until });
      continue;
    }
    const key = conversationKey(subject);
    if (key) conversations.set(key, { mark: mark ? { ...mark, reasonId: subject.reasonId ?? null } : null, until });
  }
  notify();
}

/** An instant no earlier than `floor` (epoch ms), as the ISO a mark carries. */
function atLeast(at: string, floor: number): string {
  const ms = Date.parse(at);
  return Number.isFinite(floor) && floor > ms ? new Date(floor).toISOString() : at;
}

/** Take a layer off again: the request was refused. */
export function unlayerDismissal(subjects: readonly DismissalSubjectRequest[]): void {
  for (const subject of subjects) {
    if (subject.kind === "report") reports.delete(subject.seq);
    else if (subject.kind === "pipeline") pipelines.delete(subject.pipelineId);
    else {
      const key = conversationKey(subject);
      if (key) conversations.delete(key);
    }
  }
  notify();
}

/** The polled list with every pending dismissal drawn over it. The arrays
    come back unchanged when nothing is layered, so an idle board keeps its
    identities. */
export function overlayDismissals(
  files: readonly FileEntry[],
  lanes: readonly Pipeline[],
  nowMs = Date.now(),
): { files: FileEntry[]; pipelines: Pipeline[] } | null {
  /* An expired layer goes quietly: the next poll re-renders anyway, and a
     store read during render must not change what it answers. */
  drop(nowMs);
  if (!conversations.size && !pipelines.size && !reports.size) return null;
  const sameMark = (a: AttentionDismissalMark | null | undefined, b: AttentionDismissalMark | null) =>
    (a?.at ?? null) === (b?.at ?? null);
  const nextFiles = conversations.size || reports.size
    ? files.map((file) => {
      const entry = conversations.size ? conversations.get(file.conversationId ?? "") ?? conversations.get(file.path) : undefined;
      const asks = reports.size ? unresolvedAsks(file) : null;
      if ((!entry || sameMark(file.attentionDismissal, entry.mark)) && !asks) return file;
      const next = { ...file };
      if (entry && !sameMark(file.attentionDismissal, entry.mark)) {
        delete next.attentionDismissal;
        if (entry.mark) next.attentionDismissal = entry.mark;
      }
      if (asks) {
        next.bridgeAsks = asks;
        next.bridgeAsk = asks.at(-1) ?? null;
      }
      return next;
    })
    : [...files];
  const nextPipelines = pipelines.size
    ? lanes.map((pipeline) => {
      const entry = pipelines.get(pipeline.id);
      if (!entry || (pipeline.dismissedAt ?? null) === entry.dismissedAt) return pipeline;
      /* It parked again after the card drew it: that decision is new. */
      if (entry.dismissedAt && laneMovedSince(pipeline, entry.drawn)) return pipeline;
      const dismissedAt = entry.dismissedAt && entry.local ? atLeast(entry.dismissedAt, laneMovedAt(pipeline)) : entry.dismissedAt;
      return { ...pipeline, dismissedAt, dismissedBy: entry.dismissedBy };
    })
    : [...lanes];
  return { files: nextFiles, pipelines: nextPipelines };
}

/** A seat's open asks without the ones resolved on this device, or null when
    none of them is layered. */
function unresolvedAsks(file: FileEntry): NonNullable<FileEntry["bridgeAsks"]> | null {
  const asks = file.bridgeAsks ?? (file.bridgeAsk ? [file.bridgeAsk] : []);
  if (!asks.some((ask) => ask.seq !== undefined && reports.get(ask.seq)?.resolved)) return null;
  return asks.filter((ask) => !(ask.seq !== undefined && reports.get(ask.seq)?.resolved));
}

/** Whether a decision request was resolved (true) or taken back (false) on
    this device and the server has not been heard from since; undefined when
    nothing is layered for it. The report log reads its ticks through this. */
export function layeredReportResolution(seq: number, nowMs = Date.now()): boolean | undefined {
  const entry = reports.get(seq);
  return entry && entry.until > nowMs ? entry.resolved : undefined;
}

/** Re-render on every layer change; the value is only a version. */
export function useDismissalLayerVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** The Viewer's one read: the polled files and lanes with pending dismissals
    drawn over them. */
export function useDismissalOverlay(files: FileEntry[], lanes: Pipeline[]): { files: FileEntry[]; pipelines: Pipeline[] } {
  const layered = useSyncExternalStore(subscribe, () => version, () => 0);
  return useMemo(() => {
    void layered;
    return overlayDismissals(files, lanes) ?? { files, pipelines: lanes };
  }, [files, lanes, layered]);
}

export type DismissalRequestOutcome =
  | { ok: true; outcome: DismissalOutcome }
  | { ok: false; error: string };

/**
 * Clear (or bring back) what a card needs the operator for: one request to
 * `POST /api/attention/dismissals`, drawn at once and replaced by the server's
 * own record when it answers. A refusal takes the layer back off and says why,
 * and so does a lane the server found `changed` since the card drew it.
 */
export async function sendDismissal(
  target: DismissalTarget,
  subjects: readonly DismissalSubjectRequest[],
  options: { undo?: boolean; surface: "desktop" | "phone"; fetchFn?: typeof fetch },
): Promise<DismissalRequestOutcome> {
  const by: DismissedBy = { kind: "operator", surface: options.surface };
  layerDismissal(subjects, options.undo ? null : { at: new Date().toISOString(), by }, true);
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)("/api/attention/dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, undo: options.undo === true, surface: options.surface }),
    });
  } catch (error) {
    unlayerDismissal(subjects);
    return { ok: false, error: error instanceof Error ? error.message : "network error" };
  }
  let body: { ok?: boolean; error?: string } & Partial<DismissalOutcome> = {};
  try {
    body = await response.json() as typeof body;
  } catch {
    /* An answer that is not JSON is judged by its status alone. */
  }
  if (!response.ok || !body.ok) {
    unlayerDismissal(subjects);
    return { ok: false, error: body.error ?? `HTTP ${response.status}` };
  }
  const outcome = body as DismissalOutcome;
  /* The server's own instant replaces the click's, so the poll that carries
     it matches the layer exactly and nothing flickers in between. */
  if (!outcome.undo) {
    const touched = new Set(outcome.dismissed.map(subjectKey));
    layerDismissal(subjects.filter((subject) => touched.has(requestKey(subject)) || subject.kind === "conversation"), { at: outcome.at, by: outcome.by }, false);
  }
  /* Nothing was stamped for them: they ask for what they wait on now. */
  const moved = new Set((outcome.changed ?? []).map(subjectKey));
  if (moved.size) unlayerDismissal(subjects.filter((subject) => moved.has(requestKey(subject))));
  requestFilesRefresh();
  return { ok: true, outcome };
}

function subjectKey(subject: DismissalSubject): string {
  if (subject.kind === "report") return `report:${subject.seq}`;
  return subject.kind === "pipeline" ? `pipeline:${subject.pipelineId}` : `conversation:${subject.conversationId}`;
}

function requestKey(subject: DismissalSubjectRequest): string {
  if (subject.kind === "report") return `report:${subject.seq}`;
  return subject.kind === "pipeline" ? `pipeline:${subject.pipelineId}` : `conversation:${subject.conversationId ?? subject.path ?? ""}`;
}

/** Test seam: forget every layer. */
export function resetDismissalOverlayForTests(): void {
  conversations.clear();
  pipelines.clear();
  reports.clear();
  notify();
}
