import { LAYER } from "@/components/layers";

/*
 * The voice companion's stylesheet (#2519). It lives beside the component and
 * is rendered by it, so the prototype adds nothing to the product's global
 * stylesheet. Every colour is a product token; the emblem's own colours stay
 * inside the character. Teal (`--color-info`) is the delegation's colour here
 * and on the delegated row in the orchestrator's conversation.
 *
 * The companion itself takes no pointer: only the character, its controls,
 * a bubble and a call element do, so a click anywhere else in the lane reaches
 * the page underneath. Motion is transform and opacity only.
 *
 * The lane is clipped at its end beside the character and nowhere else: a new
 * element comes out from behind that edge while the older ones rise, and an
 * element that grows shows its new part from there.
 *
 * One look (the operator's choice of 2026-10-06 among the prototype's three):
 * the character in a lit halo whose ring takes the state's colour, glass speech
 * bubbles with a warm glow and a tail on the newest, call cards with an icon
 * tile, the delegation as a rounded teal card, a rounded tile when collapsed.
 * The spacing is the compact one: 8 px between elements, 8 by 12 px inside a
 * bubble, a call card as tall as its two lines.
 *
 * It floats on the dock layer: over the board and the panes, under every sheet,
 * dialog and menu.
 */
export const VOICE_COMPANION_CSS = `
.vc {
  --vc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --vc-ring: var(--color-border);
  --vc-teal-ink: color-mix(in srgb, var(--color-info) 66%, var(--color-primary));
  --vc-teal-fill: color-mix(in srgb, var(--color-info) 82%, black);
  position: fixed; left: 0; top: 0; z-index: ${LAYER.dock};
  box-sizing: border-box;
  color: var(--color-primary);
  font-family: var(--font-sans);
  pointer-events: none;
  transition: transform 260ms var(--vc-ease);
  will-change: transform;
}
.vc *, .vc *::before, .vc *::after { box-sizing: border-box; }
.vc[data-dragging] { transition: none; }
.vc[data-phase="listening"] { --vc-ring: var(--color-accent); }
.vc[data-phase="speaking"] { --vc-ring: var(--color-primary); }
.vc[data-phase="thinking"] { --vc-ring: var(--color-muted); }
.vc[data-phase="idle"] { --vc-ring: var(--color-success); }
.vc[data-starting] { --vc-ring: var(--color-muted); }

/* The character, its state and its controls */
.vc-block { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.vc-figure {
  position: relative; display: grid; place-items: center; padding: 0; border: 0; background: none; color: inherit;
  pointer-events: auto; cursor: grab; touch-action: none; border-radius: 50%;
  padding: 4px;
}
.vc[data-dragging] .vc-figure { cursor: grabbing; }
.vc-figure:focus-visible, .vc-btn:focus-visible, .vc-act:focus-visible, .vc-shape:focus-visible, .vc-talk:focus-visible,
.vc-instruction:focus-visible, .vc-answer:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vc-state {
  display: flex; flex-direction: column; align-items: center; gap: 0; pointer-events: none;
  font-size: 11px; line-height: 14px; color: var(--color-secondary); text-align: center; max-width: 100%;
  padding: 2px 8px; border-radius: 10px; border: 1px solid var(--color-border);
  background: var(--color-raised);
}
.vc-phase { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; white-space: nowrap; }
.vc-sim { color: var(--color-muted); white-space: nowrap; }
.vc-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vc-ring); }
.vc[data-phase="offline"] .vc-dot { background: none; border: 1.5px dashed var(--color-muted); }
.vc-controls { display: flex; align-items: center; gap: 4px; }
.vc-controls > * { pointer-events: auto; }
.vc-btn {
  display: inline-grid; place-items: center; width: 28px; height: 28px; flex: none; padding: 0;
  border: 1px solid var(--color-border); border-radius: 50%; background: var(--color-raised); color: var(--color-secondary); cursor: pointer;
  box-shadow: var(--shadow-1); transition: background-color 150ms ease-out, color 150ms ease-out, transform 120ms ease-out;
}
.vc-btn:hover { background: var(--color-sunken); color: var(--color-primary); }
.vc-btn:active { transform: scale(0.94); }
.vc-btn[data-on] { color: var(--color-danger); }
.vc-btn:disabled { opacity: 0.45; cursor: default; }
.vc-talk {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px; border: 0; border-radius: 999px;
  background: var(--color-primary); color: var(--color-raised); font: 600 12px/1 var(--font-sans); cursor: pointer; white-space: nowrap;
  box-shadow: var(--shadow-1); transition: transform 120ms ease-out;
}
.vc-talk:active { transform: scale(0.96); }

.vc-char { display: block; overflow: visible; }
.vc-char-body { transform-box: fill-box; transform-origin: 50% 100%; animation: vc-breathe 3800ms ease-in-out infinite; }
@keyframes vc-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.018, 1.026); } }
.vc-char { transition: transform 260ms var(--vc-ease); }
.vc[data-phase="listening"] .vc-char { transform: rotate(-5deg); }
.vc-char-eyes { transform-box: fill-box; transform-origin: center; animation: vc-blink 4600ms infinite; }
@keyframes vc-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
.vc[data-phase="thinking"] .vc-char-eyes { animation: none; transform: translate(1px, -1.1px); }
.vc[data-phase="offline"] .vc-char { filter: saturate(0.55); opacity: 0.85; }
.vc-char-open { transform-box: fill-box; transform-origin: center; }
.vc-char-rest { transition: opacity 90ms linear; }

/* The halo: a warm light behind the character, ringed in the state's colour */
.vc-figure::before {
  content: ""; position: absolute; inset: -2px; border-radius: 50%; z-index: -1;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--color-warning) 30%, transparent), transparent 100%);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vc-ring) 55%, transparent);
  transition: box-shadow 200ms ease-out;
}
.vc[data-dragging] .vc-figure::before { box-shadow: 0 0 0 2px color-mix(in srgb, var(--vc-ring) 55%, transparent), 0 10px 22px rgb(20 20 30 / 0.2); }
.vc[data-phase="listening"] .vc-figure::before, .vc[data-starting] .vc-figure::before { animation: vc-glow 1300ms ease-in-out infinite; }
@keyframes vc-glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

/* Collapsed: the small shape that stays */
.vc-shape {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0;
  pointer-events: auto; cursor: grab; touch-action: none; color: var(--color-primary);
  background: color-mix(in srgb, var(--color-warning) 12%, var(--color-raised)); border: 2px solid var(--vc-ring); border-radius: 16px; box-shadow: var(--shadow-2);
  animation: vc-pop 200ms var(--vc-ease);
}
@keyframes vc-pop { from { opacity: 0.2; transform: scale(0.9); } to { opacity: 1; transform: none; } }
.vc[data-phase="offline"] .vc-shape { border-style: dashed; }
.vc-flag {
  position: absolute; top: -3px; right: -3px; width: 13px; height: 13px; border-radius: 50%;
  background: var(--color-info); border: 2px solid var(--color-raised); animation: vc-flag 1600ms ease-in-out infinite;
}
@keyframes vc-flag { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
.vc-flag[data-tone="failure"] { background: var(--color-danger); }
/* The collapsed shape's hang-up: inside the shape's own box, so it takes no place on the page the shape does not. */
.vc-shape-end { position: absolute; right: 0; bottom: 0; width: 24px; height: 24px; pointer-events: auto; color: var(--color-danger); animation: vc-pop 200ms var(--vc-ease); }

/* The lane: bubbles and calls, each its own element */
.vc-lane { position: absolute; pointer-events: none; clip-path: inset(-4000px -48px 0 -48px); }
.vc-lane[data-direction="down"] { clip-path: inset(0 -48px -4000px -48px); }
.vc-stack { position: relative; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; padding-bottom: 8px; }
.vc-lane[data-direction="down"] .vc-stack { flex-direction: column-reverse; padding-bottom: 0; padding-top: 8px; }
.vc-floater { display: flex; min-width: 0; will-change: transform; }
.vc-lane[data-side="left"] .vc-floater { justify-content: flex-end; transform-origin: 100% 100%; }
.vc-lane[data-side="right"] .vc-floater { justify-content: flex-start; transform-origin: 0 100%; }
.vc-lane[data-side="left"][data-direction="down"] .vc-floater { transform-origin: 100% 0; }
.vc-lane[data-side="right"][data-direction="down"] .vc-floater { transform-origin: 0 0; }
.vc-lane[data-side="left"] .vc-floater[data-speaker="operator"] { justify-content: flex-start; }
.vc-lane[data-side="right"] .vc-floater[data-speaker="operator"] { justify-content: flex-end; }
.vc-floater > * { pointer-events: auto; max-width: 280px; }
.vc-floater[data-leaving] > * { pointer-events: none; }

.vc-bubble {
  position: relative; margin: 0; padding: 8px 12px; font-size: 14px; line-height: 20px; font-weight: 500;
  overflow-wrap: anywhere; user-select: text; cursor: text;
}
/* The component ties a bubble's last two words together, so its last line is never one word left over by the wrap. */
.vc-text { text-wrap: pretty; }
.vc-bubble[data-speaker="operator"] { font-size: 13px; line-height: 18px; font-weight: 400; }
.vc-who { font-weight: 700; margin-right: 6px; }
.vc-cut { display: block; margin-top: 2px; font-size: 11px; line-height: 14px; font-style: italic; font-weight: 400; opacity: 0.8; }

/* Glass bubbles lit by the halo; the newest one points at the character */
.vc-bubble[data-speaker="companion"] {
  background: color-mix(in srgb, var(--color-raised) 92%, transparent); border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--color-warning) 16%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.vc-bubble[data-speaker="companion"][data-newest]::after {
  content: ""; position: absolute; bottom: 9px; width: 10px; height: 10px;
  background: color-mix(in srgb, var(--color-raised) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border)); border-width: 0 1px 1px 0;
  /* Only the half outside the bubble is drawn, so the glass is not doubled under it. */
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
}
.vc-lane[data-side="left"] .vc-bubble[data-newest]::after { right: -6px; transform: rotate(-45deg); }
.vc-lane[data-side="right"] .vc-bubble[data-newest]::after { left: -6px; transform: rotate(135deg); }
.vc-bubble[data-speaker="operator"] {
  background: color-mix(in srgb, var(--color-sunken) 94%, transparent); color: var(--color-secondary); border-radius: 14px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}

/* Calls: what is being called, running, done or failed */
.vc-call {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 10px 4px 5px; font-size: 12px; line-height: 16px;
  background: var(--color-raised); color: var(--color-primary);
  border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--shadow-2);
}
.vc-call-icon { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--color-sunken); }
.vc-call-body { display: flex; flex-direction: column; min-width: 0; }
.vc-call-name { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--color-primary); overflow-wrap: anywhere; }
/* A read's result is a line or two; a longer one is cut here and kept whole in the element's title. */
.vc-call-line { color: var(--color-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.vc-call-state { margin-left: auto; padding-left: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--color-muted); }
.vc-call[data-status="running"] .vc-call-icon { color: var(--color-accent); }
.vc-call[data-status="done"] .vc-call-icon { color: var(--color-success); background: var(--color-success-soft); }
.vc-call[data-status="done"] .vc-call-state { color: var(--color-success); }
.vc-call[data-status="failed"] .vc-call-icon { color: var(--color-danger); background: var(--color-danger-soft); }
.vc-call[data-status="failed"] .vc-call-state { color: var(--color-danger); }
.vc-spin { animation: vc-spin 900ms linear infinite; }
@keyframes vc-spin { to { transform: rotate(360deg); } }
.vc-more { justify-content: center; font-weight: 600; color: var(--color-secondary); }


/* What went wrong, in plain words, or a fact the operator needs before asking */
.vc-notice {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; width: 280px; padding: 7px 10px 7px 7px; font-size: 12.5px; line-height: 17px;
  color: var(--color-primary); border-radius: 12px; box-shadow: var(--shadow-2);
  background: color-mix(in srgb, var(--color-danger-soft) 70%, var(--color-raised)); border: 1px solid color-mix(in srgb, var(--color-danger) 40%, transparent);
}
.vc-notice-icon { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 7px; color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 14%, transparent); }
.vc-notice-text { flex: 1; min-width: 0; overflow-wrap: anywhere; user-select: text; }
.vc-notice[data-tone="note"] { background: var(--color-raised); border-color: var(--color-border); }
.vc-notice[data-tone="note"] .vc-notice-icon { color: var(--color-secondary); background: var(--color-sunken); }
.vc-notice .vc-act { height: 26px; margin-left: auto; }

/* The delegation: a call of its own, in the delegation's teal */
.vc .vc-call.vc-deleg {
  flex-direction: column; align-items: stretch; gap: 4px; width: 280px; padding: 9px 11px; border-radius: 14px;
  background: var(--color-info-soft); border: 1px solid color-mix(in srgb, var(--color-info) 45%, transparent); box-shadow: var(--shadow-2);
  font-family: var(--font-sans); font-size: 12.5px;
}
.vc-deleg-head { display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--vc-teal-ink); }
.vc-deleg-head .vc-call-icon { width: 20px; height: 20px; border-radius: 6px; background: color-mix(in srgb, var(--color-info) 18%, transparent); color: var(--vc-teal-ink); }
.vc-deleg[data-stage="refused"] .vc-call-icon, .vc-deleg[data-stage="failed"] .vc-call-icon, .vc-deleg[data-stage="unknown"] .vc-call-icon { color: var(--color-danger); background: var(--color-danger-soft); }
.vc-deleg-title { min-width: 0; overflow-wrap: anywhere; }
.vc-deleg-engine { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
.vc-deleg .vc-call-name { font-size: 10.5px; color: var(--color-secondary); }
/* The whole frozen text the operator confirms: wrapped in full, and scrolled when it is longer than the lane. */
.vc-instruction, .vc-answer, .vc-deleg-note {
  margin: 0; font-size: 13px; line-height: 18px; color: var(--color-primary); overflow-wrap: anywhere; user-select: text;
  max-height: 162px; overflow-y: auto; overscroll-behavior: contain;
}
.vc-deleg-wait { font-size: 11.5px; line-height: 15px; color: var(--color-secondary); }
.vc-instruction { padding: 6px 8px; border-radius: 8px; background: var(--color-raised); border: 1px solid color-mix(in srgb, var(--color-info) 25%, transparent); }
/* The orchestrator's answer: the delegation's teal, filled where the request is outlined. */
.vc .vc-call.vc-reply { background: color-mix(in srgb, var(--color-info) 14%, var(--color-raised)); border-style: solid; }
.vc-reply .vc-answer { font-weight: 500; }
.vc-acts { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.vc-act {
  display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--color-border); background: var(--color-raised); color: var(--color-primary); font: 600 12.5px/1 var(--font-sans); white-space: nowrap;
  transition: transform 120ms ease-out, opacity 150ms ease-out;
}
/* The fill is the delegation's teal a step deeper, and the label takes the surface colour (white on the light
   theme, near-black on the dark one), so Send reads at 4.5:1 or better in both. */
.vc-act[data-primary] { background: var(--vc-teal-fill); border-color: var(--vc-teal-fill); color: var(--color-raised); }
.vc-act:active { transform: scale(0.96); }
.vc-act:disabled { opacity: 0.55; cursor: default; }
.vc-track { display: flex; align-items: center; gap: 6px; height: 18px; }
.vc-end { display: grid; place-items: center; width: 18px; height: 18px; flex: none; border-radius: 50%; background: var(--color-raised); }
.vc-end[data-done] { box-shadow: 0 0 0 1.5px var(--color-info); }
.vc-rail { position: relative; flex: 1; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--color-info) 30%, transparent); }
.vc-pellet { position: absolute; left: 0; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-info); }

.vc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; padding: 0; }

@media (prefers-reduced-motion: reduce) {
  .vc, .vc * { animation: none !important; transition: none !important; }
}
`;
