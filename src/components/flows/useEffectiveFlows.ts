"use client";

import type { ReviewGroup } from "./reviewGroup";

/** Cached snapshot compatibility: display retired history exactly as received.
 * An optimistic close from an old tab must never rewrite its recorded outcome. */
export function useEffectiveFlows(flows: ReviewGroup[]): ReviewGroup[] {
  return flows;
}
