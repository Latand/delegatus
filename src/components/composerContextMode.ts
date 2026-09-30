"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The composer's context mode for Codex (docs/design/composer-context-mode.md).
 *
 * In context mode the draft is added to the thread's context instead of being
 * sent as a message that interrupts the running turn. By default the mode
 * follows the host's turn axis, and three named windows keep it from
 * flickering. The rules are a pure reducer so they can be read and tested with
 * a clock in hand; {@link ContextModeController} owns the timer.
 */

/** A running turn must hold this long before the mode enters context. */
export const CONTEXT_ENTER_AFTER_MS = 400;
/** An idle turn must hold this long before the mode returns to normal. It
    outlasts the short idle gap between a turn ending and the queued next one
    starting, where a drop to normal would turn the next Enter into an interrupt. */
export const CONTEXT_EXIT_AFTER_MS = 2_500;
/** No draft edit for this long before an automatic flip. */
export const CONTEXT_TYPING_QUIET_MS = 1_500;

export type ContextMode = "normal" | "context";
type Turn = "idle" | "running";
export type TurnReading = Turn | "unknown";

export interface ContextModeState {
  /** The turn after debouncing; null until the first known reading. */
  debouncedTurn: Turn | null;
  /** A reading waiting out its window. */
  candidate: { turn: Turn; since: number } | null;
  /** A manual press made while auto is on; holds until the next boundary. */
  override: { mode: ContextMode; anchor: Turn | null } | null;
  /** The mode while auto is off. */
  manual: ContextMode;
  /** What the toolbar shows and Enter uses. */
  shown: ContextMode;
}

export interface ContextModeInputs {
  reading: TurnReading;
  supported: boolean;
  autoEnabled: boolean;
  /** When the draft was last edited (ms), or null. */
  lastEditAt: number | null;
  /** An input-method composition is open. */
  composing: boolean;
  dictating: boolean;
  /** An injection, send or save is on its way. */
  inFlight: boolean;
}

export function initialContextModeState(manual: ContextMode = "normal"): ContextModeState {
  return { debouncedTurn: null, candidate: null, override: null, manual, shown: manual };
}

/** Turn axis to reading: an interrupt still in progress is a running turn. */
export function turnReading(turn: string | null | undefined): TurnReading {
  if (turn === "running" || turn === "interrupt_requested") return "running";
  if (turn === "idle") return "idle";
  return "unknown";
}

const windowFor = (turn: Turn) => (turn === "running" ? CONTEXT_ENTER_AFTER_MS : CONTEXT_EXIT_AFTER_MS);

function typingUntil(inputs: ContextModeInputs): number | null {
  return inputs.lastEditAt === null ? null : inputs.lastEditAt + CONTEXT_TYPING_QUIET_MS;
}

function guardsHold(inputs: ContextModeInputs, now: number): boolean {
  if (inputs.dictating || inputs.inFlight || inputs.composing) return true;
  const until = typingUntil(inputs);
  return until !== null && now < until;
}

function desiredMode(state: ContextModeState, inputs: ContextModeInputs): ContextMode {
  const wanted: ContextMode = inputs.autoEnabled
    ? state.override?.mode ?? (state.debouncedTurn === "running" ? "context" : "normal")
    : state.manual;
  /* A host that cannot inject is never entered from here. A context mode
     already on screen stays until the rule itself wants normal, so an ordinary
     send never replaces what the operator chose behind their back. */
  return wanted === "context" && !inputs.supported && state.shown !== "context" ? "normal" : wanted;
}

/** One evaluation. Returns the same object when nothing changed. */
export function stepContextMode(state: ContextModeState, inputs: ContextModeInputs, now: number): ContextModeState {
  let { debouncedTurn, candidate, override } = state;
  let boundary = false;
  if (inputs.reading === "unknown") {
    candidate = null;
  } else if (debouncedTurn === null) {
    debouncedTurn = inputs.reading;
    candidate = null;
  } else if (inputs.reading === debouncedTurn) {
    candidate = null;
  } else {
    if (!candidate || candidate.turn !== inputs.reading) candidate = { turn: inputs.reading, since: now };
    if (now - candidate.since >= windowFor(candidate.turn)) {
      debouncedTurn = candidate.turn;
      candidate = null;
      boundary = true;
    }
  }
  if (boundary) override = null;
  const draft: ContextModeState = { ...state, debouncedTurn, candidate, override };
  const desired = desiredMode(draft, inputs);
  const shown = desired !== state.shown && !guardsHold(inputs, now) ? desired : state.shown;
  const next: ContextModeState = { ...draft, shown };
  const same = next.debouncedTurn === state.debouncedTurn
    && next.shown === state.shown
    && next.override === state.override
    && (next.candidate === state.candidate
      || (next.candidate !== null && state.candidate !== null
        && next.candidate.turn === state.candidate.turn && next.candidate.since === state.candidate.since));
  return same ? state : next;
}

/** The operator pressed the toggle. Never deferred. */
export function pressContextToggle(state: ContextModeState, autoEnabled: boolean): ContextModeState {
  const shown: ContextMode = state.shown === "context" ? "normal" : "context";
  return autoEnabled
    ? { ...state, shown, override: { mode: shown, anchor: state.debouncedTurn } }
    : { ...state, shown, manual: shown };
}

/** The operator switched auto off or on. Nothing on screen moves by itself. */
export function setContextAuto(state: ContextModeState, autoEnabled: boolean): ContextModeState {
  return autoEnabled ? { ...state, override: null } : { ...state, manual: state.shown, override: null };
}

/** The nearest moment at which a pending change could land, or null. */
export function nextContextDeadline(state: ContextModeState, inputs: ContextModeInputs, now: number): number | null {
  const deadlines: number[] = [];
  if (inputs.reading !== "unknown" && state.candidate && inputs.reading === state.candidate.turn) {
    deadlines.push(state.candidate.since + windowFor(state.candidate.turn));
  }
  const until = typingUntil(inputs);
  if (until !== null && until > now && desiredMode(state, inputs) !== state.shown) deadlines.push(until);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export interface ContextModeSnapshot {
  shown: ContextMode;
  autoEnabled: boolean;
  /** Auto is deciding the mode right now (no manual override in force). */
  followsAgent: boolean;
  /** The last automatic change, for a polite live region; null after a press. */
  announcement: "on" | "off" | null;
}

export const CONTEXT_AUTO_STORAGE_KEY = "llv_composer_context_auto";
const modeStorageKey = (cardId: string) => `llv_composer_context_mode:${cardId}`;

function readAutoEnabled(): boolean {
  try {
    return localStorage.getItem(CONTEXT_AUTO_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function readManualMode(cardId: string): ContextMode {
  try {
    return sessionStorage.getItem(modeStorageKey(cardId)) === "context" ? "context" : "normal";
  } catch {
    return "normal";
  }
}

type Timer = ReturnType<typeof setTimeout>;

interface ControllerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/**
 * The state, its timer and its subscribers. It is a plain object rather than
 * component state because the mode is a function of the clock as well as of
 * props: a deadline passing has to change what is shown with nothing else
 * having re-rendered.
 */
export class ContextModeController {
  private state = initialContextModeState();
  private inputs: ContextModeInputs = {
    reading: "unknown", supported: false, autoEnabled: true,
    lastEditAt: null, composing: false, dictating: false, inFlight: false,
  };
  private cardId: string | null = null;
  private timer: Timer | null = null;
  private announcement: "on" | "off" | null = null;
  private snapshot: ContextModeSnapshot = { shown: "normal", autoEnabled: true, followsAgent: true, announcement: null };
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ControllerOptions["clearTimer"]>;

  constructor(options: ControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ContextModeSnapshot => this.snapshot;

  /** Start over for a conversation: the machine resets, and `manual` is read
      from that conversation's own key. */
  reset(cardId: string, autoEnabled: boolean = readAutoEnabled()): void {
    this.cardId = cardId;
    this.state = initialContextModeState(readManualMode(cardId));
    this.inputs = { ...this.inputs, autoEnabled, lastEditAt: null, composing: false };
    this.announcement = null;
    this.evaluate();
  }

  /** New readings from the composer. Anything omitted keeps its value. */
  feed(patch: Partial<Pick<ContextModeInputs, "reading" | "supported" | "dictating" | "inFlight">>): void {
    const next = { ...this.inputs, ...patch };
    if (next.reading === this.inputs.reading && next.supported === this.inputs.supported
      && next.dictating === this.inputs.dictating && next.inFlight === this.inputs.inFlight) return;
    this.inputs = next;
    this.evaluate();
  }

  noteEdit(): void {
    this.inputs = { ...this.inputs, lastEditAt: this.now() };
    this.evaluate();
  }

  setComposing(open: boolean): void {
    if (this.inputs.composing === open) return;
    this.inputs = { ...this.inputs, composing: open, ...(open ? {} : { lastEditAt: this.now() }) };
    this.evaluate();
  }

  press(): void {
    this.state = pressContextToggle(this.state, this.inputs.autoEnabled);
    this.announcement = null;
    this.persistManual();
    this.evaluate(true);
  }

  setAuto(autoEnabled: boolean): void {
    if (autoEnabled === this.inputs.autoEnabled) return;
    try {
      if (autoEnabled) localStorage.removeItem(CONTEXT_AUTO_STORAGE_KEY);
      else localStorage.setItem(CONTEXT_AUTO_STORAGE_KEY, "0");
    } catch { /* storage unavailable: the choice lasts for this page */ }
    this.state = setContextAuto(this.state, autoEnabled);
    this.inputs = { ...this.inputs, autoEnabled };
    this.persistManual();
    this.evaluate(true);
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private persistManual(): void {
    if (!this.cardId || this.inputs.autoEnabled) return;
    try {
      if (this.state.manual === "context") sessionStorage.setItem(modeStorageKey(this.cardId), "context");
      else sessionStorage.removeItem(modeStorageKey(this.cardId));
    } catch { /* storage unavailable */ }
  }

  private evaluate(manualChange = false): void {
    const now = this.now();
    const before = this.state.shown;
    this.state = stepContextMode(this.state, this.inputs, now);
    if (!manualChange && this.state.shown !== before) this.announcement = this.state.shown === "context" ? "on" : "off";
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const deadline = nextContextDeadline(this.state, this.inputs, now);
    if (deadline !== null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.evaluate();
      }, Math.max(0, deadline - now));
    }
    const next: ContextModeSnapshot = {
      shown: this.state.shown,
      autoEnabled: this.inputs.autoEnabled,
      followsAgent: this.inputs.autoEnabled && this.state.override === null,
      announcement: this.announcement,
    };
    const prev = this.snapshot;
    if (prev.shown === next.shown && prev.autoEnabled === next.autoEnabled
      && prev.followsAgent === next.followsAgent && prev.announcement === next.announcement) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The composer's binding. `active` is false where the toggle is not offered
 * (Claude, tmux): the machine is then held at normal and nothing runs.
 */
export function useContextMode(options: {
  cardId: string;
  active: boolean;
  reading: TurnReading;
  supported: boolean;
  dictating: boolean;
  inFlight: boolean;
}): { snapshot: ContextModeSnapshot; controller: ContextModeController } {
  const [controller] = useState(() => new ContextModeController());
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { cardId, active, reading, supported, dictating, inFlight } = options;
  useEffect(() => {
    controller.reset(cardId);
  }, [controller, cardId]);
  useEffect(() => {
    controller.feed({ reading: active ? reading : "unknown", supported: active && supported, dictating, inFlight });
  }, [controller, active, reading, supported, dictating, inFlight]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { snapshot, controller };
}
