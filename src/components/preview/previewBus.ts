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
}

type Listener = (request: ArtifactPreviewRequest) => void;

const listeners = new Set<Listener>();

export function openArtifactPreview(path: string, target?: FileLinkTarget): void {
  for (const listener of [...listeners]) listener(target ? { path, target } : { path });
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
