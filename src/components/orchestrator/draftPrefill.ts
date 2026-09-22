"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { AgentLaunchDraft } from "@/components/draft/AgentLaunchControls";
import { writeSeatDraftField } from "@/components/mobile/orchestratorDraftStorage";

/**
 * The setup guide's first action (#1876 slice 3, design §2.4 card 5): open a
 * project's orchestrator create draft already set to Claude Opus at the effort
 * the tour chose. Nothing is spawned here: the draft's own Confirm stays the
 * one action that designates a seat.
 *
 * The launch parameters go into the draft's own storage (the keys the desktop
 * dock and the phone sheet share), so a draft that mounts afterwards starts
 * on them; a draft already mounted for that project hears the request and
 * applies it. The shell listens too, and opens the project and its seat.
 */

export const ORCHESTRATOR_DRAFT_EVENT = "llv:orchestrator-draft";

export type OrchestratorDraftRequest = {
  project: string;
  /** Null opens the seat as it is: the project already has one. */
  launch: { engine: "claude"; model: string; effort: string } | null;
};

/* The one request a surface that mounts after the event still owes an
   opening to (the phone's seat card mounts with the project's board). */
let pendingOpen: { project: string; opens: SeatOpening } | null = null;

/* The project whose desktop draft still owes the operator a look at the launch
   choices the request set: the dock mounts the draft after the event. */
let pendingReveal: string | null = null;

/** What a surface opens for a request: the create draft for a prefill, the
    seat itself for a project that already has one. */
export type SeatOpening = "draft" | "seat";

export function requestOrchestratorDraft(request: OrchestratorDraftRequest): void {
  if (typeof window === "undefined") return;
  if (request.launch) {
    writeSeatDraftField(request.project, "engine", request.launch.engine);
    writeSeatDraftField(request.project, "model", request.launch.model);
    writeSeatDraftField(request.project, "effort", request.launch.effort);
  }
  pendingOpen = { project: request.project, opens: request.launch ? "draft" : "seat" };
  pendingReveal = request.launch ? request.project : null;
  window.dispatchEvent(new CustomEvent<OrchestratorDraftRequest>(ORCHESTRATOR_DRAFT_EVENT, { detail: request }));
}

/** What a request asked this project's seat surface to open, consumed once. */
export function takePendingSeatOpen(project: string): SeatOpening | null {
  if (pendingOpen?.project !== project) return null;
  const { opens } = pendingOpen;
  pendingOpen = null;
  return opens;
}

export function onOrchestratorDraftRequest(listener: (request: OrchestratorDraftRequest) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OrchestratorDraftRequest>).detail;
    if (detail && typeof detail.project === "string") listener(detail);
  };
  window.addEventListener(ORCHESTRATOR_DRAFT_EVENT, handler);
  return () => window.removeEventListener(ORCHESTRATOR_DRAFT_EVENT, handler);
}

/** A mounted create draft takes the request's launch parameters for its own
    project. */
export function useOrchestratorDraftPrefill(project: string, launch: Pick<AgentLaunchDraft, "engine" | "setEngine" | "setModel" | "setEffort">): void {
  const latest = useRef(launch);
  useEffect(() => { latest.current = launch; });
  useEffect(() => onOrchestratorDraftRequest((request) => {
    if (request.project !== project || !request.launch) return;
    const draft = latest.current;
    /* Switching engines re-defaults the model, so the engine goes first. */
    if (draft.engine !== request.launch.engine) draft.setEngine(request.launch.engine);
    draft.setModel(request.launch.model);
    draft.setEffort(request.launch.effort);
  }), [project]);
}

/** The dock opens the draft at its short default height, where the intro and
    the Create button fill the view and the engine, account and reasoning the
    tour chose sit below the fold. A hand-off scrolls them into view, whether
    the draft was on screen already or mounts after the request. */
export function useOrchestratorDraftReveal(project: string, target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let frame: ReturnType<typeof setTimeout> | null = null;
    /* After the prefill's state has rendered, so the rows are the ones shown. */
    const reveal = () => {
      if (frame !== null) clearTimeout(frame);
      frame = setTimeout(() => {
        frame = null;
        target.current?.scrollIntoView({ block: "nearest" });
      }, 0);
    };
    if (pendingReveal === project) {
      pendingReveal = null;
      reveal();
    }
    const off = onOrchestratorDraftRequest((request) => {
      if (request.project !== project || !request.launch) return;
      pendingReveal = null;
      reveal();
    });
    return () => {
      off();
      if (frame !== null) clearTimeout(frame);
    };
  }, [project, target]);
}
