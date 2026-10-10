"use client";

import { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import { TooltipBubble } from "@/components/TooltipBubble";

/** How long a pointer rests on the control before the bubble shows. */
export const SHOW_DELAY_MS = 150;
/** The hint's bubble, for a surface that shows one without wrapping a control in `Hint`. */
export const HINT_BUBBLE_CLASS = "whitespace-nowrap rounded-[7px] bg-primary px-2 py-1 text-[10.5px] font-semibold text-white shadow-1";

/** Why the bubble is up, and whether the operator has already answered it. */
interface HintState {
  hovered: boolean;
  focused: boolean;
  /** Closed by an activation, by the control going away, by something
      happening elsewhere or by the surface being handed another conversation.
      Holds until the keyboard focuses the control or the pointer arrives anew,
      so a pointer still resting on the control does not reopen the bubble. */
  dismissed: boolean;
  /** The pointer has left the control since the dismissal, so its next real
      movement over the control is a new arrival. */
  left: boolean;
}

/** `arrive` is the pointer's own input on the control: a movement, or a
    finger or pen pressing it. */
type HintEvent = "enter" | "leave" | "arrive" | "focus" | "blur" | "dismiss" | "gone";

const RESTING: HintState = { hovered: false, focused: false, dismissed: false, left: false };

function hintReducer(state: HintState, event: HintEvent): HintState {
  switch (event) {
    case "enter":
      /* An enter alone never reopens a dismissed bubble. React reports one
         whenever the node under the pointer is replaced (a busy control swaps
         its icon for a spinner), and the browser reports a leave and an enter
         when the layout shifts for a frame under a resting pointer, which is
         what a conversation hand-over does to the strip. */
      return state.hovered ? state : { ...state, hovered: true };
    case "leave":
      return state.hovered || (state.dismissed && !state.left) ? { ...state, hovered: false, left: state.dismissed } : state;
    case "arrive":
      if (state.dismissed) return state.left ? { ...state, hovered: true, dismissed: false, left: false } : state;
      return state.hovered ? state : { ...state, hovered: true };
    case "focus":
      return state.focused && !state.dismissed ? state : { ...state, focused: true, dismissed: false, left: false };
    case "blur":
      return state.focused ? { ...state, focused: false } : state;
    case "dismiss":
      /* Focus is dropped with it: a control that disables itself loses focus
         during React's commit, and React delivers no blur for that. */
      return state.dismissed && !state.focused ? state : { ...state, focused: false, dismissed: true, left: !state.hovered };
    case "gone":
      return state === RESTING ? state : RESTING;
  }
}

/** What the hints below are about: the conversation a surface shows. */
const HintScopeContext = createContext("");

/**
 * Names what every Hint inside is about. When `id` changes, an open bubble
 * closes: a surface that keeps its components mounted while it is handed
 * another conversation (the orchestrator dock, a reader) would otherwise
 * carry a bubble about the previous conversation into the next one, and that
 * hand-over reaches no anchor as a pointer, a key or a blur. Scopes nest, so
 * a change anywhere above a hint reaches it.
 */
export function HintScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(HintScopeContext);
  return <HintScopeContext.Provider value={`${parent}\u0000${id}`}>{children}</HintScopeContext.Provider>;
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
 * unmounts, on a pointer press or a key anywhere else, and when the surface
 * around it is handed another conversation (`HintScope`). Focus opens it only
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
  const scope = useContext(HintScopeContext);
  const shownScope = useRef(scope);
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

  useEffect(() => {
    if (shownScope.current === scope) return;
    shownScope.current = scope;
    send("dismiss");
  }, [scope]);

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
      onPointerMove={() => send("arrive")}
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") send("arrive");
      }}
      onFocus={(event) => {
        if (focusIsVisible(event.target)) send("focus");
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) send("blur");
      }}
      /* In the capture phase, so a control that stops its own click (Send
         with nothing to send stays enabled for its menu and swallows the
         click) still closes its bubble. */
      onClickCapture={() => send("dismiss")}
    >
      {children}
      {shown ? (
        <TooltipBubble
          anchorRef={anchorRef}
          side={side}
          align={align}
          className={HINT_BUBBLE_CLASS}
        >
          {label}
        </TooltipBubble>
      ) : null}
    </span>
  );
}
