"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/*
 * Where an open decision is answered (docs/design/operator-decision-forms.md,
 * variant 3). On the desktop the seat panel of the project draws the
 * «Рішення» column and registers itself here; asking for a project's
 * decisions then opens that column on the form. Where no panel of the project
 * stands (the phone, a seat folded away on another screen) the page's one
 * sheet answers instead, mounted by the prototype review host.
 */

export interface DecisionRequest { project: string; reviewId?: string }
type Surface = (request: DecisionRequest) => void;

const surfaces = new Map<string, Surface[]>();
let sheet: DecisionRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Open a project's decisions on the form named, wherever they are answered here. */
export function openOperatorDecisions(request: DecisionRequest): void {
  const surface = surfaces.get(request.project)?.at(-1);
  if (surface) { surface(request); return; }
  sheet = { ...request };
  emit();
}

/** A seat panel that draws the column for `project` while `active`. */
export function useDecisionSurface(project: string, active: boolean, open: Surface): void {
  const handler = useRef(open);
  useEffect(() => { handler.current = open; });
  useEffect(() => {
    if (!active) return;
    const surface: Surface = (request) => handler.current(request);
    surfaces.set(project, [...surfaces.get(project) ?? [], surface]);
    return () => {
      const left = (surfaces.get(project) ?? []).filter((entry) => entry !== surface);
      if (left.length) surfaces.set(project, left);
      else surfaces.delete(project);
    };
  }, [project, active]);
}

/** The sheet's request, while one is open. */
export function useDecisionSheet(): DecisionRequest | null {
  return useSyncExternalStore(subscribe, () => sheet, () => null);
}

export function closeDecisionSheet(): void {
  if (!sheet) return;
  sheet = null;
  emit();
}

/** Tests only. */
export function resetDecisionSurfacesForTests(): void {
  surfaces.clear();
  sheet = null;
  emit();
}
