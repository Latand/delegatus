"use client";

/*
 * The one channel between a rendered artifact link — wherever it appears: a
 * settled transcript row, a streaming live turn, expanded tool output — and
 * the single ArtifactPreviewHost mounted in the Viewer shell. A module-level
 * bus rather than context because feed rows render inside portals and memoized
 * chunk lists that must not re-render when the preview opens.
 */

import type { FileLinkTarget } from "@/lib/artifact/linkTarget";

export interface ArtifactPreviewRequest {
  /** The linked local path exactly as the transcript spelled it (may carry a
      `:line` suffix and a `~/` prefix; the host normalizes for transport). */
  path: string;
  /** What the link resolver made of that spelling where the link was
      rendered, with that page's host context; the host re-reads `path` only
      when this is absent. */
  target?: FileLinkTarget;
  /** Where this preview reads from when it is not a local path: a meta URL and
      a content URL that answer like `/api/artifact` (a task's committed
      files). Absent, the sheet reads `/api/artifact` as every link does. */
  source?: ArtifactPreviewSource;
  /** `overlay` paints the sheet above a modal dialog that opened it. */
  layer?: "overlay";
}

export interface ArtifactPreviewSource {
  metaUrl: string;
  contentUrl: string;
}

type Listener = (request: ArtifactPreviewRequest) => void;

const listeners = new Set<Listener>();

export function openArtifactPreview(path: string, target?: FileLinkTarget, options: { source?: ArtifactPreviewSource; layer?: "overlay" } = {}): void {
  const request: ArtifactPreviewRequest = { path, ...(target ? { target } : {}), ...(options.source ? { source: options.source } : {}), ...(options.layer ? { layer: options.layer } : {}) };
  for (const listener of [...listeners]) listener(request);
}

export function onArtifactPreview(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a host is mounted — links fall back to default behavior when not. */
export function hasArtifactPreviewHost(): boolean {
  return listeners.size > 0;
}
