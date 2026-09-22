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
    let settle: (() => void) | null = null;
    /* The last row of the block, Reasoning, carries the model and effort the
       tour chose; the dock's body can be shorter than the whole block, so it
       is that row the reveal is about. */
    const row = (): HTMLElement | null => {
      const block = target.current;
      const last = block?.firstElementChild?.lastElementChild;
      return (last instanceof HTMLElement ? last : block) ?? null;
    };
    const scroll = () => row()?.scrollIntoView({ block: "end" });
    const revealed = (): boolean => {
      const node = row();
      const scroller = target.current?.parentElement;
      if (!node || !scroller) return true;
      const inner = node.getBoundingClientRect();
      const outer = scroller.getBoundingClientRect();
      return inner.bottom <= outer.bottom + 1 && inner.top >= outer.top - 1;
    };
    /* One scroll is not enough: the dock opens the draft and then settles its
       own height, which moves the rows again, and a draft that mounts into a
       body of no height scrolls nothing at all. So the reveal is repeated
       until the row is actually in view, for at most a moment, and it lets go
       as soon as the operator touches the draft. */
    const hold = () => {
      settle?.();
      const scroller = target.current?.parentElement;
      if (!scroller) return;
      const until = Date.now() + 1_500;
      const tick = setInterval(() => {
        if (revealed() || Date.now() > until) {
          settle?.();
          return;
        }
        scroll();
      }, 50);
      const release = () => settle?.();
      const inputs = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
      for (const name of inputs) scroller.addEventListener(name, release, { passive: true });
      settle = () => {
        settle = null;
        clearInterval(tick);
        for (const name of inputs) scroller.removeEventListener(name, release);
      };
    };
    const reveal = () => {
      if (frame !== null) clearTimeout(frame);
      /* After the prefill's state has rendered, so the rows are the ones shown. */
      frame = setTimeout(() => {
        frame = null;
        scroll();
        hold();
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
      settle?.();
    };
  }, [project, target]);
}
