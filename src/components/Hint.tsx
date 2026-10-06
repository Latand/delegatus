"use client";

import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import { TooltipBubble } from "@/components/TooltipBubble";

/** How long a pointer rests on the control before the bubble shows. */
const SHOW_DELAY_MS = 150;

/** Why the bubble is up, and whether the operator has already answered it. */
interface HintState {
  hovered: boolean;
  focused: boolean;
  /** Closed by an activation, by the control going away or by something
      happening elsewhere. Holds until the pointer or the keyboard arrives anew,
      so a pointer still resting on the control does not reopen the bubble. */
  dismissed: boolean;
}

type HintEvent = "enter" | "leave" | "focus" | "blur" | "dismiss" | "gone";

const RESTING: HintState = { hovered: false, focused: false, dismissed: false };

function hintReducer(state: HintState, event: HintEvent): HintState {
  switch (event) {
    case "enter":
      /* React reports the pointer entering again whenever the node under it is
         replaced (a busy control swaps its icon for a spinner). Only an arrival
         from outside reopens a dismissed bubble. */
      return state.hovered ? state : { ...state, hovered: true, dismissed: false };
    case "leave":
      return state.hovered || state.dismissed ? { ...state, hovered: false, dismissed: false } : state;
    case "focus":
      return state.focused && !state.dismissed ? state : { ...state, focused: true, dismissed: false };
    case "blur":
      return state.focused ? { ...state, focused: false } : state;
    case "dismiss":
      /* Focus is dropped with it: a control that disables itself loses focus
         during React's commit, and React delivers no blur for that. */
      return state.dismissed && !state.focused ? state : { ...state, focused: false, dismissed: true };
    case "gone":
      return state === RESTING ? state : RESTING;
  }
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

/** Keyboard focus, as the browser itself classifies it. A click focuses a
    button too, and that focus opens no bubble. */
function focusIsVisible(target: EventTarget | null): boolean {
  try {
    return (target as Element).matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * A styled hover/focus tooltip bubble. Wraps exactly one interactive child;
 * the child keeps its own aria-label — the bubble is the visual counterpart
 * (native `title` is dropped where Hint is used, so hints never double up).
 *
 * `align` controls the horizontal anchor: "center" (default) centres the bubble
 * over the child; "right"/"left" pin the bubble's matching edge to the child.
 * The bubble is portalled and kept inside the window, so a control hugging a
 * clipping container's edge (the send button in a composer) shows it whole.
 *
 * It closes when the control is activated, when the control disables itself or
 * unmounts, and on a pointer press or a key anywhere else. Focus opens it only
 * when the focus came from the keyboard.
 */
export function Hint({
  label,
  side = "top",
  align = "center",
  children,
}: {
  label: string;
  side?: "top" | "bottom";
  align?: "center" | "left" | "right";
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [state, send] = useReducer(hintReducer, RESTING);
  const [rested, setRested] = useState(false);
  const active = !state.dismissed && (state.hovered || state.focused);
  const shown = active && rested;

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setRested(true), SHOW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setRested(false);
    };
  }, [active]);

  /* While the bubble is wanted, it also listens for the reasons to withdraw
     that never reach the anchor as a leave or a blur: the control disabling
     itself or unmounting, and anything the operator does elsewhere, which is
     how a conversation, an orchestrator or a project gets switched. */
  useEffect(() => {
    if (!active) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const observer = new window.MutationObserver((records) => {
      if (!anchor.firstElementChild) return send("gone");
      if (records.some((record) => record.type === "attributes"
        && (record.target as Element).matches(":disabled, [aria-disabled='true']"))) {
        return send("dismiss");
      }
      if (!anchor.contains(document.activeElement)) send("blur");
    });
    observer.observe(anchor, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
    const outside = (event: Event) => {
      if (!anchor.contains(event.target as Node | null)) send("dismiss");
    };
    const key = (event: KeyboardEvent) => {
      if (!MODIFIER_KEYS.has(event.key)) send("dismiss");
    };
    const navigated = () => send("dismiss");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("popstate", navigated);
    window.addEventListener("hashchange", navigated);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("popstate", navigated);
      window.removeEventListener("hashchange", navigated);
    };
  }, [active]);

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onPointerEnter={() => send("enter")}
      onPointerLeave={() => send("leave")}
      onFocus={(event) => {
        if (focusIsVisible(event.target)) send("focus");
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) send("blur");
      }}
      onClick={() => send("dismiss")}
    >
      {children}
      {shown ? (
        <TooltipBubble
          anchorRef={anchorRef}
          side={side}
          align={align}
          className="whitespace-nowrap rounded-[7px] bg-primary px-2 py-1 text-[10.5px] font-semibold text-white shadow-1"
        >
          {label}
        </TooltipBubble>
      ) : null}
    </span>
  );
}
