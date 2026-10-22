"use client";

import { useEffect, useRef } from "react";

import type { MobileAttentionEntry } from "@/components/attention/attentionQueue";
import { playCue, unlockAudioOnGesture } from "@/lib/audio/app";
import {
  createHeardKeys,
  planDoneCues,
  planNeedsYouCues,
  planPipelineCues,
  type DoneCuePlan,
  type HeardKeys,
  type PipelineCuePlan,
  type QueueCuePlan,
} from "@/lib/audio/workCues";
import type { DoneItemV1 } from "@/lib/done/types";
import type { Pipeline } from "@/lib/pipelines/types";

/**
 * The board's sounds (docs/design/sound-redesign.md §4.1–§4.3): S6 and S7
 * from the needs-you queue the badge counts, S3, S4 and S7 from the scope's
 * pipelines, S5 and the deploy and limit faults from the «Готово» feed.
 *
 * `certified` says whether the board payload is the answer of a request for
 * `scope` or a stand-in served while that request is still loading (#1432); a
 * stand-in is not planned on, so the pending scope never becomes a baseline.
 * `doneLoaded` says whether the «Готово» feed has answered at all.
 */
export function useWorkCues(
  needsYou: readonly MobileAttentionEntry[],
  pipelines: readonly Pipeline[],
  doneItems: readonly DoneItemV1[],
  scope: string | null,
  certified: boolean,
  doneLoaded: boolean,
): void {
  const queueRef = useRef<QueueCuePlan | null>(null);
  const lanesRef = useRef<PipelineCuePlan | null>(null);
  const doneRef = useRef<DoneCuePlan | null>(null);
  const heardRef = useRef<HeardKeys | null>(null);

  useEffect(() => unlockAudioOnGesture(), []);

  useEffect(() => {
    if (!scope) return;
    const plan = planNeedsYouCues(needsYou, queueRef.current, scope, Date.now(), certified);
    queueRef.current = plan;
    for (const request of plan?.requests ?? []) playCue(request);
  }, [needsYou, scope, certified]);

  useEffect(() => {
    if (!scope) return;
    const plan = planPipelineCues(pipelines, lanesRef.current, scope, certified);
    lanesRef.current = plan;
    for (const request of plan?.requests ?? []) playCue(request);
  }, [pipelines, scope, certified]);

  useEffect(() => {
    if (!doneLoaded) return;
    heardRef.current ??= createHeardKeys(sessionStore());
    const plan = planDoneCues(doneItems, doneRef.current, Date.now(), heardRef.current);
    doneRef.current = plan;
    for (const request of plan.requests) playCue(request);
  }, [doneItems, doneLoaded]);
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
