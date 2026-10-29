"use client";

import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import { PIPELINES_CHANGED_EVENT } from "@/components/pipelines/pipelineEvents";
import { applyPipelineSnapshot, revertPipelineSnapshot } from "@/hooks/useFiles";

/**
 * The pipeline writes the kanban board makes (#1695 K5b), over the existing
 * `GET`/`PATCH /api/pipelines/:id` routes. Unlike the scheme's `patchPipeline`
 * helper they answer with the status, so a refusal the operator can act on
 * (a stage that already started) is told apart from any other failure.
 *
 * A write may carry the record it predicts (pause, resume, the "finishes the
 * task" flag): it is drawn on every surface before the request, the echo
 * confirms it, and a refusal or a write with no answer takes it back.
 */

/**
 * A write's answer. A refusal the route explained is a known outcome. With no
 * answer at all (the request failed on its way, status 0) or an answer that
 * carries neither the pipeline nor the route's error, the write may or may not
 * have happened: `unknown`, which nothing may treat as a refusal or resend
 * blindly.
 */
export type PipelineWriteResult =
  | { ok: true; pipeline: Pipeline }
  | { ok: false; status: number; error: string; code?: string; field?: string; unknown?: true };

/** A pipeline as the route reads it, with each stage's digest (`stageDigest`), which guards `override-stage`. */
export interface PipelineRead {
  pipeline: Pipeline;
  stageDigests: Readonly<Record<string, string>>;
  /** The record's revision, which one more review round names as `expectedRevision` (#1938). */
  revision?: string | null;
  /** The digest of the whole ordered plan, which guards `add-stage`. */
  graphDigest?: string | null;
}

export interface PipelinePorts {
  /** The stored record, or null when it cannot be read. */
  read(id: string): Promise<PipelineRead | null>;
  patch(id: string, body: PatchPipelineRequest, predicted?: Pipeline): Promise<PipelineWriteResult>;
  /** Ask every surface to read the catalog again: a check found it behind. */
  refresh(): void;
}

/** Actions whose effects reach past the record: the catalog is read again after them. */
const REFRESH_ACTIONS = new Set(["retry-stage", "skip-stage", "resume", "pause", "close", "continue-review", "accept-head"]);

export const browserPipelinePorts: PipelinePorts = {
  async read(id) {
    try {
      const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; stageDigests?: Record<string, unknown>; revision?: unknown; graphDigest?: unknown } | null;
      if (!json?.pipeline) return null;
      const stageDigests = Object.fromEntries(Object.entries(json.stageDigests ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return { pipeline: json.pipeline, stageDigests, revision: typeof json.revision === "string" ? json.revision : null, graphDigest: typeof json.graphDigest === "string" ? json.graphDigest : null };
    } catch {
      return null;
    }
  },
  async patch(id, body, predicted) {
    if (predicted) applyPipelineSnapshot(predicted, false);
    const result = await patchPipelineRecord(id, body);
    if (predicted && !result.ok) revertPipelineSnapshot(id);
    return result;
  },
  refresh() {
    window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
  },
};

async function patchPipelineRecord(id: string, body: PatchPipelineRequest): Promise<PipelineWriteResult> {
  try {
    const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; error?: string; code?: string; field?: string } | null;
    if (response.ok && json?.pipeline) {
      applyPipelineSnapshot(json.pipeline, true);
      if (REFRESH_ACTIONS.has(body.action)) window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return { ok: true, pipeline: json.pipeline };
    }
    if (response.ok || typeof json?.error !== "string") return { ok: false, status: response.status, error: `HTTP ${response.status}`, unknown: true };
    return { ok: false, status: response.status, error: json.error, ...(json.code ? { code: json.code } : {}), ...(json.field ? { field: json.field } : {}) };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), unknown: true };
  }
}

/** The record a pause or a resume leaves, as the engine writes it; null for any other action. */
export function predictedPauseResume(pipeline: Pipeline, action: string, now = new Date().toISOString()): Pipeline | null {
  if (action === "pause" && pipeline.state !== "paused" && pipeline.state !== "draft") return { ...pipeline, pausedState: pipeline.state, state: "paused", pausedAt: now };
  if (action === "resume" && pipeline.state === "paused") return { ...pipeline, state: pipeline.pausedState ?? "running", pausedState: null, resumedAt: now };
  return null;
}

/** The engine's refusal of a guarded write: the stage it named is not the one the pipeline holds now. */
export function isStageChanged(result: PipelineWriteResult): boolean {
  return !result.ok && !result.unknown && result.status === 409 && result.code === "STAGE_CHANGED";
}

/** The engine's refusal for a stage whose first attempt exists (`override-stage`). */
export function isAlreadyStarted(result: PipelineWriteResult): boolean {
  return !result.ok && !result.unknown && result.status === 409 && /already started/i.test(result.error);
}
