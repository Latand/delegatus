"use client";

import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import { PIPELINES_CHANGED_EVENT } from "@/components/pipelines/pipelineEvents";
import { applyPipelineSnapshot } from "@/hooks/useFiles";

/**
 * The pipeline writes the kanban board makes (#1695 K5b), over the existing
 * `GET`/`PATCH /api/pipelines/:id` routes. Unlike the scheme's `patchPipeline`
 * helper they answer with the status, so a refusal the operator can act on
 * (a stage that already started) is told apart from any other failure.
 */

export type PipelineWriteResult =
  | { ok: true; pipeline: Pipeline }
  | { ok: false; status: number; error: string; code?: string };

export interface PipelinePorts {
  /** The stored record, or null when it cannot be read. */
  read(id: string): Promise<Pipeline | null>;
  patch(id: string, body: PatchPipelineRequest): Promise<PipelineWriteResult>;
  /** Ask every surface to read the catalog again: a check found it behind. */
  refresh(): void;
}

/** Actions whose effects reach past the record: the catalog is read again after them. */
const REFRESH_ACTIONS = new Set(["retry-stage", "skip-stage", "resume", "pause", "close"]);

export const browserPipelinePorts: PipelinePorts = {
  async read(id) {
    try {
      const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline } | null;
      return json?.pipeline ?? null;
    } catch {
      return null;
    }
  },
  async patch(id, body) {
    try {
      const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json().catch(() => null)) as { pipeline?: Pipeline; error?: string; code?: string } | null;
      if (response.ok && json?.pipeline) {
        applyPipelineSnapshot(json.pipeline, true);
        if (REFRESH_ACTIONS.has(body.action)) window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
        return { ok: true, pipeline: json.pipeline };
      }
      return { ok: false, status: response.status, error: json?.error ?? `HTTP ${response.status}`, ...(json?.code ? { code: json.code } : {}) };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  },
  refresh() {
    window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
  },
};

/** The engine's refusal for a stage whose first attempt exists (`override-stage`). */
export function isAlreadyStarted(result: PipelineWriteResult): boolean {
  return !result.ok && result.status === 409 && /already started/i.test(result.error);
}
