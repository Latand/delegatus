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
 * Variants: 1 "comic" (bubbles with a tail, pill-shaped calls, a round shape
 * when collapsed), 2 "caption" (dark caption plates, terminal-style calls, a
 * capsule), 3 "lantern" (a lit halo, glass bubbles, call cards, a rounded tile).
 */
export const VOICE_COMPANION_CSS = `
.vc {
  --vc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --vc-ring: var(--color-border);
  --vc-teal-ink: color-mix(in srgb, var(--color-info) 66%, var(--color-primary));
  position: fixed; left: 0; top: 0; z-index: 40;
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

/* The character, its state and its controls */
.vc-block { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.vc-figure {
  position: relative; display: grid; place-items: center; padding: 0; border: 0; background: none; color: inherit;
  pointer-events: auto; cursor: grab; touch-action: none; border-radius: 50%;
  filter: drop-shadow(0 6px 10px rgb(20 20 30 / 0.16));
}
.vc[data-dragging] .vc-figure { cursor: grabbing; filter: drop-shadow(0 12px 18px rgb(20 20 30 / 0.24)); }
.vc-figure:focus-visible, .vc-btn:focus-visible, .vc-act:focus-visible, .vc-shape:focus-visible, .vc-talk:focus-visible,
.vc-instruction:focus-visible, .vc-answer:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vc-state {
  display: flex; flex-direction: column; align-items: center; gap: 0; pointer-events: none;
  font-size: 11px; line-height: 14px; color: var(--color-secondary); text-align: center; max-width: 100%;
  padding: 2px 8px; border-radius: 10px; border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-raised) 94%, transparent);
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

/* The state ring under the character's feet (variant 1) or around its halo (variant 3) */
.vc[data-variant="1"] .vc-figure::after {
  content: ""; position: absolute; left: 14%; right: 14%; bottom: -3px; height: 6px; border-radius: 50%;
  background: var(--vc-ring); opacity: 0.55; transition: background-color 200ms ease-out;
}
.vc[data-variant="1"][data-phase="listening"] .vc-figure::after { animation: vc-hear 1300ms ease-in-out infinite; }
@keyframes vc-hear { 0%, 100% { transform: scaleX(1); opacity: 0.55; } 50% { transform: scaleX(1.15); opacity: 0.25; } }
.vc[data-variant="2"] .vc-figure { filter: none; }
.vc[data-variant="2"] .vc-figure::after {
  content: ""; position: absolute; left: 10%; right: 10%; bottom: -2px; height: 8px; border-radius: 50%;
  background: radial-gradient(closest-side, rgb(20 20 30 / 0.28), transparent); pointer-events: none;
}
.vc[data-variant="3"] .vc-figure { padding: 4px; filter: none; }
.vc[data-variant="3"] .vc-figure::before {
  content: ""; position: absolute; inset: -2px; border-radius: 50%; z-index: -1;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--color-warning) 30%, transparent), transparent 100%);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vc-ring) 55%, transparent);
  transition: box-shadow 200ms ease-out;
}
.vc[data-variant="3"][data-phase="listening"] .vc-figure::before { animation: vc-glow 1300ms ease-in-out infinite; }
@keyframes vc-glow { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

/* Collapsed: the small shape that stays */
.vc-shape {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 0;
  pointer-events: auto; cursor: grab; touch-action: none; color: var(--color-primary);
  background: var(--color-raised); border: 2px solid var(--vc-ring); box-shadow: var(--shadow-2);
  animation: vc-pop 200ms var(--vc-ease);
}
@keyframes vc-pop { from { opacity: 0.2; transform: scale(0.9); } to { opacity: 1; transform: none; } }
.vc[data-variant="1"] .vc-shape { border-radius: 50%; }
.vc[data-variant="2"] .vc-shape { border-radius: 999px; justify-content: flex-start; padding: 0 12px 0 6px; }
.vc[data-variant="3"] .vc-shape { border-radius: 16px; background: color-mix(in srgb, var(--color-warning) 12%, var(--color-raised)); }
.vc-shape-label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
.vc[data-phase="offline"] .vc-shape { border-style: dashed; }
.vc-flag {
  position: absolute; top: -3px; right: -3px; width: 13px; height: 13px; border-radius: 50%;
  background: var(--color-info); border: 2px solid var(--color-raised); animation: vc-flag 1600ms ease-in-out infinite;
}
@keyframes vc-flag { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
.vc-badge {
  position: absolute; top: -6px; left: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  display: grid; place-items: center; font: 700 11px/1 var(--font-sans); color: var(--color-raised); background: var(--color-primary);
  pointer-events: none;
}

/* The lane: bubbles and calls, each its own element */
.vc-lane { position: absolute; pointer-events: none; }
.vc-stack { position: relative; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px; }
.vc-lane[data-direction="down"] .vc-stack { flex-direction: column-reverse; }
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
.vc-bubble[data-speaker="operator"] { font-size: 13px; line-height: 18px; font-weight: 400; }
.vc-who { font-weight: 700; margin-right: 6px; }
.vc-cut { display: block; margin-top: 2px; font-size: 11px; line-height: 14px; font-style: italic; font-weight: 400; opacity: 0.8; }

/* Variant 1: comic bubbles with a tail toward the character */
.vc[data-variant="1"] .vc-bubble[data-speaker="companion"] {
  background: var(--color-raised); border: 1px solid var(--color-border); border-radius: 18px; box-shadow: var(--shadow-1);
}
.vc[data-variant="1"] .vc-bubble[data-speaker="companion"][data-newest]::after {
  content: ""; position: absolute; bottom: 7px; width: 10px; height: 10px; background: var(--color-raised);
  border: 1px solid var(--color-border); border-width: 0 1px 1px 0;
}
.vc[data-variant="1"] .vc-lane[data-side="left"] .vc-bubble[data-newest]::after { right: -6px; transform: rotate(-45deg); }
.vc[data-variant="1"] .vc-lane[data-side="right"] .vc-bubble[data-newest]::after { left: -6px; transform: rotate(135deg); }
.vc[data-variant="1"] .vc-bubble[data-speaker="operator"] { background: var(--color-sunken); color: var(--color-secondary); border-radius: 16px; }

/* Variant 2: caption plates */
.vc[data-variant="2"] .vc-bubble[data-speaker="companion"] {
  background: var(--color-primary); color: var(--color-raised); border-radius: 8px; box-shadow: var(--shadow-1);
}
.vc[data-variant="2"] .vc-bubble[data-speaker="operator"] {
  background: color-mix(in srgb, var(--color-primary) 72%, var(--color-canvas)); color: var(--color-raised); border-radius: 8px;
}

/* Variant 3: glass bubbles lit by the lantern */
.vc[data-variant="3"] .vc-bubble[data-speaker="companion"] {
  background: color-mix(in srgb, var(--color-raised) 92%, transparent); border-radius: 14px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-warning) 34%, transparent), 0 6px 18px color-mix(in srgb, var(--color-warning) 16%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.vc[data-variant="3"] .vc-bubble[data-speaker="operator"] {
  background: color-mix(in srgb, var(--color-sunken) 94%, transparent); color: var(--color-secondary); border-radius: 14px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}

/* Calls: what is being called, running, done or failed */
.vc-call {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 10px; font-size: 12px; line-height: 16px;
  background: var(--color-raised); color: var(--color-primary);
}
.vc-call-icon { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 50%; }
.vc-call-body { display: flex; flex-direction: column; min-width: 0; }
.vc-call-name { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--color-primary); overflow-wrap: anywhere; }
.vc-call-line { color: var(--color-secondary); overflow-wrap: anywhere; }
.vc-call-state { margin-left: auto; padding-left: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--color-muted); }
.vc-call[data-status="running"] .vc-call-icon { color: var(--color-accent); }
.vc-call[data-status="done"] .vc-call-icon { color: var(--color-success); background: var(--color-success-soft); }
.vc-call[data-status="done"] .vc-call-state { color: var(--color-success); }
.vc-call[data-status="failed"] .vc-call-icon { color: var(--color-danger); background: var(--color-danger-soft); }
.vc-call[data-status="failed"] .vc-call-state { color: var(--color-danger); }
.vc-spin { animation: vc-spin 900ms linear infinite; }
@keyframes vc-spin { to { transform: rotate(360deg); } }
.vc-more { justify-content: center; font-weight: 600; color: var(--color-secondary); }

.vc[data-variant="1"] .vc-call { border: 1.5px dashed var(--color-border); border-radius: 999px; padding: 4px 12px 4px 5px; box-shadow: var(--shadow-1); }
.vc[data-variant="2"] .vc-call {
  border-radius: 6px; background: var(--color-sunken); border-left: 3px solid var(--color-muted);
}
.vc[data-variant="2"] .vc-call:not(.vc-deleg) { font-family: var(--font-mono); font-size: 11.5px; }
.vc[data-variant="2"] .vc-call[data-status="running"] { border-left-color: var(--color-accent); }
.vc[data-variant="2"] .vc-call[data-status="done"] { border-left-color: var(--color-success); }
.vc[data-variant="2"] .vc-call[data-status="failed"] { border-left-color: var(--color-danger); }
.vc[data-variant="2"] .vc-call-icon { border-radius: 4px; }
.vc[data-variant="3"] .vc-call { border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--shadow-2); padding: 6px 10px 6px 6px; }
.vc[data-variant="3"] .vc-call-icon { width: 26px; height: 26px; border-radius: 8px; background: var(--color-sunken); }

/* The delegation: a call of its own, in the delegation's teal */
.vc .vc-call.vc-deleg {
  flex-direction: column; align-items: stretch; gap: 4px; width: 280px; padding: 9px 11px; border-radius: 14px;
  background: var(--color-info-soft); border: 1px solid color-mix(in srgb, var(--color-info) 45%, transparent); box-shadow: var(--shadow-2);
  font-family: var(--font-sans); font-size: 12.5px;
}
.vc[data-variant="1"] .vc-call.vc-deleg { border-style: dashed; border-width: 1.5px; }
.vc[data-variant="2"] .vc-call.vc-deleg { border-radius: 6px; border-width: 0 0 0 3px; border-left-color: var(--color-info); }
.vc[data-variant="3"] .vc-call.vc-deleg { border-radius: 14px; }
.vc-deleg-head { display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--vc-teal-ink); }
.vc-deleg-head .vc-call-icon { width: 20px; height: 20px; background: color-mix(in srgb, var(--color-info) 18%, transparent); color: var(--vc-teal-ink); }
.vc-deleg[data-stage="refused"] .vc-call-icon, .vc-deleg[data-stage="failed"] .vc-call-icon, .vc-deleg[data-stage="unknown"] .vc-call-icon { color: var(--color-danger); background: var(--color-danger-soft); }
.vc-deleg-title { min-width: 0; overflow-wrap: anywhere; }
.vc-deleg-engine { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
.vc-deleg .vc-call-name { font-size: 10.5px; color: var(--color-secondary); }
/* The whole frozen text the operator confirms: wrapped in full, and scrolled when it is longer than the lane. */
.vc-instruction, .vc-answer, .vc-deleg-note {
  margin: 0; font-size: 13px; line-height: 18px; color: var(--color-primary); overflow-wrap: anywhere; user-select: text;
  max-height: 162px; overflow-y: auto; overscroll-behavior: contain;
}
.vc-instruction { padding: 6px 8px; border-radius: 8px; background: var(--color-raised); border: 1px solid color-mix(in srgb, var(--color-info) 25%, transparent); }
.vc-answer .vc-who { color: var(--vc-teal-ink); }
.vc-acts { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.vc-act {
  display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--color-border); background: var(--color-raised); color: var(--color-primary); font: 600 12.5px/1 var(--font-sans); white-space: nowrap;
  transition: transform 120ms ease-out, opacity 150ms ease-out;
}
.vc-act[data-primary] { background: var(--color-info); border-color: var(--color-info); color: #fff; }
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
