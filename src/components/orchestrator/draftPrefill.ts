"use client";

import { useEffect, useRef, type RefObject } from "react";

import { launchReadiness, type AgentLaunchDraft, type LaunchEngine } from "@/components/draft/AgentLaunchControls";
import { writeSeatDraftField } from "@/components/mobile/orchestratorDraftStorage";

/**
 * The setup guide's hand-off to a project's orchestrator create draft (#1876
 * slice 3, #2166 §2.2): the draft opens already set to the engine, model,
 * effort and account the guide chose. The draft's own Confirm stays the one
 * action that designates a seat; a request with `confirm` asks the draft to
 * press it once, as soon as it is ready, so the guide's Create is one press.
 *
 * The launch parameters go into the draft's own storage (the keys the desktop
 * dock and the phone sheet share), so a draft that mounts afterwards starts
 * on them; a draft already mounted for that project hears the request and
 * applies it. The shell listens too, and opens the project and its seat.
 */

export const ORCHESTRATOR_DRAFT_EVENT = "llv:orchestrator-draft";

export type OrchestratorDraftLaunch = {
  engine: Extract<LaunchEngine, "claude" | "codex">;
  model: string;
  effort: string;
  /** The account to run on; absent leaves the engine's active one. */
  account?: string;
};

export type OrchestratorDraftRequest = {
  project: string;
  /** Null opens the seat as it is: the project already has one. */
  launch: OrchestratorDraftLaunch | null;
  /** Designate once the draft is ready (the guide's Create). */
  confirm?: boolean;
};

/** A confirm the guide asked for and no draft has taken yet. */
export type PendingSeatConfirm = { project: string; at: number; launch: OrchestratorDraftLaunch };

/** How long a confirm waits for its draft: a later visit never designates by itself. */
export const SEAT_CONFIRM_TTL_MS = 60_000;

/* The one request a surface that mounts after the event still owes an
   opening to (the phone's seat card mounts with the project's board). */
let pendingOpen: { project: string; opens: SeatOpening } | null = null;

/* The project whose desktop draft still owes the operator a look at the launch
   choices the request set: the dock mounts the draft after the event. */
let pendingReveal: string | null = null;

/* The confirm the guide asked for. It cannot ride on the event alone: the
   guide closes over the Overview, and the project's board and its draft mount
   only after the shell has selected it, when the event has fired to nobody. */
let pendingConfirm: PendingSeatConfirm | null = null;

/* The project whose board the request asked the desktop to show. */
let pendingBoard: string | null = null;

/** What a surface opens for a request: the create draft for a prefill, the
    seat itself for a project that already has one. */
export type SeatOpening = "draft" | "seat";

export function requestOrchestratorDraft(request: OrchestratorDraftRequest): void {
  if (typeof window === "undefined") return;
  if (request.launch) {
    writeSeatDraftField(request.project, "engine", request.launch.engine);
    writeSeatDraftField(request.project, "model", request.launch.model);
    writeSeatDraftField(request.project, "effort", request.launch.effort);
    writeSeatDraftField(request.project, "accountId", request.launch.account ?? "");
  }
  pendingOpen = { project: request.project, opens: request.launch ? "draft" : "seat" };
  pendingReveal = request.launch ? request.project : null;
  /* A request without confirm clears any older one. */
  pendingConfirm = request.confirm && request.launch ? { project: request.project, at: Date.now(), launch: request.launch } : null;
  pendingBoard = request.project;
  window.dispatchEvent(new CustomEvent<OrchestratorDraftRequest>(ORCHESTRATOR_DRAFT_EVENT, { detail: request }));
}

/** What a request asked this project's seat surface to open, consumed once. */
export function takePendingSeatOpen(project: string): SeatOpening | null {
  if (pendingOpen?.project !== project) return null;
  const { opens } = pendingOpen;
  pendingOpen = null;
  return opens;
}

/** The confirm a request asked this project's draft for, consumed once. One
    older than {@link SEAT_CONFIRM_TTL_MS} is dropped instead. */
export function takePendingSeatConfirm(project: string, now = Date.now()): PendingSeatConfirm | null {
  if (pendingConfirm?.project !== project) return null;
  const taken = pendingConfirm;
  pendingConfirm = null;
  return now - taken.at > SEAT_CONFIRM_TTL_MS ? null : taken;
}

/** The shell moved to another project: a confirm owed to a project the user
    left is dropped, so coming back later designates nothing by itself. */
export function dropPendingSeatConfirmOutside(project: string | null): void {
  if (pendingConfirm && pendingConfirm.project !== project) pendingConfirm = null;
}

/** Whether a request asked the desktop to show this project's Board, consumed once. */
export function takePendingBoardView(project: string): boolean {
  if (pendingBoard !== project) return false;
  pendingBoard = null;
  return true;
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
export function useOrchestratorDraftPrefill(project: string, launch: Pick<AgentLaunchDraft, "engine" | "setEngine" | "setModel" | "setEffort" | "setAccountId">): void {
  const latest = useRef(launch);
  useEffect(() => { latest.current = launch; });
  useEffect(() => onOrchestratorDraftRequest((request) => {
    if (request.project !== project || !request.launch) return;
    const draft = latest.current;
    /* Switching engines re-defaults the model and drops the account, so the
       engine goes first. */
    if (draft.engine !== request.launch.engine) draft.setEngine(request.launch.engine);
    draft.setModel(request.launch.model);
    draft.setEffort(request.launch.effort);
    draft.setAccountId(request.launch.account ?? "");
  }), [project]);
}

/** Where the draft's own seat read stands, in the three answers the pending
    confirm needs. */
export type SeatDraftReadiness = "waiting" | "draft" | "not-a-draft";

/** The draft surfaces' seat state, read for the pending confirm: a read still
    loading (or failing) is waited out; anything but a draft ends the wait. */
export function seatDraftReadiness(kind: string): SeatDraftReadiness {
  if (kind === "draft") return "draft";
  return kind === "loading" || kind === "unavailable" ? "waiting" : "not-a-draft";
}

/**
 * The draft's half of the guide's one-press Create (#2166 §2.2). The draft
 * takes a pending confirm on mount and on the event, and holds it until it is
 * ready: its seat read says there is no seat, the account options have loaded,
 * and its engine, model, effort and account equal the request's. Only then
 * does it call its own confirm, once, which goes through `useSeatConfirm` and
 * keeps its one-key idempotency.
 *
 * It never designates on a default account while the prefill is still
 * landing. A requested account that is missing or signed out once the options
 * load drops the confirm and leaves the draft on that account, where its own
 * preflight shows "Sign in to {engine} first". A confirm that outlives
 * {@link SEAT_CONFIRM_TTL_MS}, or a seat that turns out to exist, drops it too.
 */
export function usePendingSeatConfirm(
  project: string,
  launch: Pick<AgentLaunchDraft, "engine" | "model" | "effort" | "catalog" | "launchAccountId" | "setAccountId">,
  seat: SeatDraftReadiness,
  confirm: () => void,
  now: () => number = Date.now,
): void {
  const held = useRef<PendingSeatConfirm | null>(null);
  const latest = useRef({ launch, seat, confirm, now });
  useEffect(() => { latest.current = { launch, seat, confirm, now }; });

  const settle = () => {
    const pending = held.current;
    if (!pending) return;
    const { launch: draft, seat: read, confirm: press, now: clock } = latest.current;
    if (clock() - pending.at > SEAT_CONFIRM_TTL_MS || read === "not-a-draft") {
      held.current = null;
      return;
    }
    if (read === "waiting" || !draft.catalog) return;
    const wanted = pending.launch;
    const section = draft.catalog[wanted.engine];
    if (wanted.account) {
      const account = section?.accounts.find((entry) => entry.id === wanted.account);
      if (!account || account.signedOut) {
        held.current = null;
        if (account && draft.engine === wanted.engine && draft.launchAccountId !== account.id) draft.setAccountId(account.id);
        return;
      }
    }
    if (draft.engine !== wanted.engine || draft.model !== wanted.model || draft.effort !== wanted.effort) return;
    if (wanted.account && draft.launchAccountId !== wanted.account) return;
    if (launchReadiness(draft).kind !== "ready") {
      held.current = null;
      return;
    }
    held.current = null;
    press();
  };

  useEffect(() => {
    held.current = takePendingSeatConfirm(project, latest.current.now()) ?? held.current;
    settle();
    return onOrchestratorDraftRequest((request) => {
      if (request.project !== project || !request.confirm) return;
      held.current = takePendingSeatConfirm(project, latest.current.now()) ?? held.current;
      /* The prefill's own listener sets the fields in this same event; they
         render before the check below runs again. */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settle reads the latest render through its ref
  }, [project]);

  /* Every render is a chance the draft became ready. */
  useEffect(settle);
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
