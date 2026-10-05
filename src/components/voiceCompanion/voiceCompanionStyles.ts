/*
 * The voice companion's stylesheet (#2519). It lives beside the component and
 * is rendered by it, so the prototype adds nothing to the product's global
 * stylesheet. Every colour is a product token; the emblem's own colours stay
 * inside the character. Teal (`--color-info`) is the delegation's colour here
 * and on the delegated row in the orchestrator's conversation.
 *
 * Motion is transform and opacity only. Sizes are fixed per variant, so the
 * window never changes the rectangle it was placed in while it talks.
 */
export const VOICE_COMPANION_CSS = `
.vc {
  --vc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --vc-perch: color-mix(in srgb, #F7DCC6 34%, var(--color-raised));
  --vc-ring: var(--color-border);
  --vc-teal-ink: color-mix(in srgb, var(--color-info) 66%, var(--color-primary));
  position: fixed; left: 0; top: 0; z-index: 40;
  box-sizing: border-box;
  color: var(--color-primary);
  font-family: var(--font-sans);
  background: var(--color-raised);
  border: 1px solid var(--color-border);
  border-radius: 18px;
  box-shadow: var(--shadow-2);
  overflow: hidden;
  touch-action: none;
  user-select: none;
  cursor: grab;
  transition: transform 260ms var(--vc-ease);
  will-change: transform;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .vc { --vc-perch: color-mix(in srgb, #F7DCC6 9%, var(--color-raised)); } }
[data-theme="dark"] .vc { --vc-perch: color-mix(in srgb, #F7DCC6 9%, var(--color-raised)); }
.vc[data-dragging] { transition: none; cursor: grabbing; box-shadow: var(--shadow-2), 0 0 0 2px color-mix(in srgb, var(--color-accent) 40%, transparent); }
.vc[data-phase="listening"] { --vc-ring: var(--color-accent); }
.vc[data-phase="speaking"] { --vc-ring: var(--color-primary); }
.vc[data-phase="thinking"] { --vc-ring: var(--color-muted); }
.vc[data-delegating] { --vc-ring: var(--color-info); }
.vc[data-layout="dock"] {
  left: 0; right: 0; top: auto; bottom: 0; width: auto !important;
  border-radius: 18px 18px 0 0; border-width: 1px 0 0;
  box-shadow: 0 -6px 24px rgb(20 20 30 / 0.10);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transition: none;
}
.vc-pop { animation: vc-pop 200ms var(--vc-ease); transform-origin: 100% 100%; }
@keyframes vc-pop { from { opacity: 0.2; transform: scale(0.94); } to { opacity: 1; transform: none; } }

/* The character and its perch */
.vc-perch { position: relative; display: grid; place-items: center; flex: none; background: var(--vc-perch); }
.vc-perch::after {
  content: ""; position: absolute; inset: 5px; border-radius: inherit; pointer-events: none;
  border: 2px solid var(--vc-ring); opacity: 0.9; transition: border-color 200ms ease-out;
}
.vc[data-phase="offline"] .vc-perch::after { border-style: dashed; opacity: 0.55; }
.vc[data-phase="listening"] .vc-perch::after { animation: vc-hear 1300ms ease-in-out infinite; }
@keyframes vc-hear { 0%, 100% { transform: scale(1); opacity: 0.9; } 50% { transform: scale(1.035); opacity: 0.45; } }
.vc-char { display: block; overflow: visible; }
.vc-char-body { transform-box: fill-box; transform-origin: 50% 100%; animation: vc-breathe 3800ms ease-in-out infinite; }
@keyframes vc-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.018, 1.026); } }
.vc[data-phase="listening"] .vc-char { transform: rotate(-5deg); }
.vc-char { transition: transform 260ms var(--vc-ease); }
.vc-char-eyes { transform-box: fill-box; transform-origin: center; animation: vc-blink 4600ms infinite; }
@keyframes vc-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
.vc[data-phase="thinking"] .vc-char-eyes { animation: none; transform: translate(1px, -1.1px); }
.vc[data-phase="offline"] .vc-char { filter: saturate(0.55); opacity: 0.8; }
.vc-char-open { transform-box: fill-box; transform-origin: center; }
.vc-char-rest { transition: opacity 90ms linear; }

/* Status and controls */
.vc-status { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.vc-name { font-size: 13px; font-weight: 700; letter-spacing: 0.01em; }
.vc-phase { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
.vc-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vc-ring); }
.vc[data-phase="idle"] .vc-dot { background: var(--color-success); }
.vc-sim { font-size: 11px; color: var(--color-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-controls { display: flex; align-items: center; gap: 2px; }
.vc-btn {
  display: inline-grid; place-items: center; width: 32px; height: 32px; flex: none;
  border: 0; border-radius: 9px; background: transparent; color: var(--color-secondary); cursor: pointer;
  transition: background-color 150ms ease-out, color 150ms ease-out, transform 120ms ease-out;
}
.vc-btn:hover { background: var(--color-sunken); color: var(--color-primary); }
.vc-btn:active { transform: scale(0.95); }
.vc-btn:focus-visible, .vc-act:focus-visible, .vc-shape:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.vc-btn[data-grip] { cursor: grab; }
.vc-btn[data-on] { color: var(--color-danger); }
.vc-talk {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 0; border-radius: 999px;
  background: var(--color-primary); color: var(--color-raised); font: 600 12.5px/1 var(--font-sans); cursor: pointer;
  transition: transform 120ms ease-out, opacity 150ms ease-out;
}
.vc-talk:active { transform: scale(0.96); }
.vc-talk:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
@media (pointer: coarse) { .vc-btn { width: 44px; height: 44px; } .vc-talk { height: 44px; padding: 0 16px; } }

/* Captions: the lines rise from the bottom edge */
.vc-body { position: relative; min-width: 0; overflow: hidden; }
.vc-captions {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 16px 12px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px); mask-image: linear-gradient(to bottom, transparent 0, #000 28px);
  transform: translate3d(0, calc(var(--vc-shift, 0px) * -1), 0);
  transition: transform 320ms var(--vc-ease);
}
.vc-lines { display: flex; flex-direction: column; gap: 8px; will-change: transform; }
.vc-line { margin: 0; overflow-wrap: anywhere; animation: vc-line-in 280ms ease-out; }
@keyframes vc-line-in { from { opacity: 0.2; } to { opacity: 1; } }
.vc-line[data-speaker="companion"] { font-size: 15px; line-height: 1.45; font-weight: 500; color: var(--color-primary); }
.vc-line[data-speaker="operator"] { font-size: 12.5px; line-height: 1.4; color: var(--color-secondary); }
.vc-line[data-speaker="orchestrator"] {
  font-size: 13px; line-height: 1.45; color: var(--color-primary); padding: 7px 10px; border-radius: 10px;
  background: var(--color-info-soft); border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent);
}
.vc-line[data-old] { opacity: 0.7; transition: opacity 320ms ease-out; }
.vc-who { font-weight: 700; margin-right: 6px; }
.vc-line[data-speaker="orchestrator"] .vc-who { color: var(--vc-teal-ink); }
.vc-cut { margin-left: 6px; font-size: 11px; font-style: italic; color: var(--color-muted); }
.vc-empty { margin: 0; font-size: 13px; line-height: 1.45; color: var(--color-muted); }

/* Delegation: the proposal, then the hand-off track */
.vc-deleg {
  position: absolute; left: 0; right: 0; bottom: 0; box-sizing: border-box; padding: 10px 14px 12px;
  background: var(--color-info-soft); border-top: 1px solid color-mix(in srgb, var(--color-info) 32%, transparent);
  transform: translate3d(0, 101%, 0); opacity: 0.2; visibility: hidden;
  transition: transform 320ms var(--vc-ease), opacity 240ms ease-out, visibility 0s linear 320ms;
}
.vc-deleg[data-open] { transform: none; opacity: 1; visibility: visible; transition-delay: 0s; }
.vc-deleg[data-stage="offline"] { background: transparent; border-top-color: transparent; padding-left: 16px; }
.vc-deleg-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--vc-teal-ink); }
.vc-deleg-head > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-deleg[data-stage="awaiting-confirmation"] .vc-deleg-head { align-items: flex-start; }
.vc-deleg[data-stage="awaiting-confirmation"] .vc-deleg-head > span:first-child { white-space: normal; }
.vc-deleg-engine { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-weight: 600; color: var(--color-secondary); white-space: nowrap; }
.vc-instruction {
  margin: 4px 0 8px; font-size: 13px; line-height: 1.4; color: var(--color-primary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.vc-acts { display: flex; gap: 8px; }
.vc-act {
  height: 32px; padding: 0 14px; border-radius: 9px; border: 1px solid var(--color-border); background: var(--color-raised);
  color: var(--color-primary); font: 600 12.5px/1 var(--font-sans); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex: 1 1 0; min-width: 0; white-space: nowrap;
  transition: transform 120ms ease-out, background-color 150ms ease-out;
}
.vc-act:active { transform: scale(0.96); }
.vc-act:disabled { opacity: 0.5; cursor: default; }
.vc-act[data-primary] { border-color: transparent; background: var(--vc-teal-ink); color: var(--color-raised); }
@media (pointer: coarse) { .vc-act { height: 44px; padding: 0 10px; } }
.vc-track { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.vc-rail { position: relative; flex: 1; height: 14px; }
.vc-rail::before { content: ""; position: absolute; left: 0; right: 0; top: 6px; border-top: 2px dotted color-mix(in srgb, var(--color-info) 55%, transparent); }
.vc-pellet {
  position: absolute; left: 0; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--color-info);
  opacity: 0; will-change: transform;
}
.vc-end { display: inline-grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 7px; background: var(--color-raised); border: 1px solid color-mix(in srgb, var(--color-info) 30%, transparent); }
.vc-end[data-done] { color: var(--color-success); }
.vc-stage-text { font-size: 12px; font-weight: 600; color: var(--color-secondary); margin-top: 4px; }
.vc-deleg[data-stage="cancelled"], .vc-deleg[data-stage="refused"], .vc-deleg[data-stage="failed"] { background: var(--color-sunken); border-top-color: var(--color-border); }

/* The printed variant number, for comparison captures */
.vc-badge {
  position: absolute; left: 8px; top: 8px; z-index: 2; min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box;
  display: grid; place-items: center; border-radius: 6px; background: var(--color-primary); color: var(--color-raised);
  font: 700 12px/1 var(--font-sans); font-variant-numeric: tabular-nums; pointer-events: none;
}
.vc[data-collapsed] { overflow: visible; }
.vc[data-collapsed] .vc-badge { left: -5px; top: -5px; min-width: 18px; height: 18px; font-size: 11px; }
.vc[data-collapsed][data-layout="dock"] .vc-badge { left: auto; right: 12px; top: 21px; }
.vc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Variant 1: character card */
.vc[data-variant="1"][data-layout="float"]:not([data-collapsed]) { display: flex; flex-direction: column; }
.vc[data-variant="1"][data-layout="float"] .vc-top {
  display: grid; grid-template-columns: 76px minmax(0, 1fr); grid-template-areas: "perch controls" "perch status";
  column-gap: 12px; align-items: start; padding: 10px 8px 12px 14px;
}
.vc[data-variant="1"][data-layout="float"] .vc-top .vc-perch { grid-area: perch; align-self: center; }
.vc[data-variant="1"][data-layout="float"] .vc-status { grid-area: status; }
.vc[data-variant="1"][data-layout="float"] .vc-controls { grid-area: controls; justify-self: end; }
.vc[data-variant="1"] .vc-perch { width: 76px; height: 76px; border-radius: 50%; }
.vc[data-variant="1"] .vc-body { flex: 1; border-top: 1px solid var(--color-border); }

/* Variant 2: caption rail */
.vc[data-variant="2"][data-layout="float"]:not([data-collapsed]) { display: grid; grid-template-columns: 112px minmax(0, 1fr); padding-right: 40px; }
.vc[data-variant="2"] .vc-top { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 10px 6px; background: var(--vc-perch); }
.vc[data-variant="2"] .vc-perch { width: 72px; height: 72px; border-radius: 50%; background: var(--color-raised); }
.vc[data-variant="2"] .vc-name, .vc[data-variant="2"] .vc-sim { display: none; }
.vc[data-variant="2"] .vc-status { align-items: center; }
/* The rail's controls stand in their own column, so no line passes under them. */
.vc[data-variant="2"][data-layout="float"] .vc-controls { position: absolute; right: 4px; top: 0; bottom: 0; z-index: 2; flex-direction: column; justify-content: center; }
.vc[data-variant="2"][data-layout="float"] .vc-body { border-right: 1px solid var(--color-border); }
@media (pointer: coarse) { .vc[data-variant="2"][data-layout="float"]:not([data-collapsed]) { padding-right: 52px; } }

/* Variant 3: lantern */
.vc[data-variant="3"] { border-radius: 26px; }
.vc[data-variant="3"][data-layout="float"]:not([data-collapsed]) { display: flex; flex-direction: column; }
.vc[data-variant="3"] .vc-top { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 12px 10px; background: radial-gradient(120% 90% at 50% 38%, var(--vc-perch) 0 46%, transparent 78%); }
.vc[data-variant="3"] .vc-perch { width: 112px; height: 112px; border-radius: 30px; background: transparent; }
.vc[data-variant="3"] .vc-name { display: none; }
.vc[data-variant="3"] .vc-status { align-items: center; text-align: center; }
.vc[data-variant="3"] .vc-controls { position: absolute; right: 8px; top: 8px; flex-direction: column; }
.vc[data-variant="3"] .vc-body { flex: 1; background: var(--color-sunken); border-top: 1px solid var(--color-border); }
.vc[data-variant="3"] .vc-line[data-speaker="companion"] { font-size: 14px; }

/* Docked: one row, whatever the variant */
.vc[data-layout="dock"]:not([data-collapsed]) { display: grid; grid-template-columns: 104px minmax(0, 1fr); padding-right: 40px; }
@media (pointer: coarse) { .vc[data-layout="dock"]:not([data-collapsed]) { padding-right: 50px; } }
.vc[data-layout="dock"] .vc-top { position: static; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 10px 6px; background: var(--vc-perch); }
.vc[data-layout="dock"] .vc-perch { width: 72px; height: 72px; background: var(--color-raised); }
.vc[data-layout="dock"][data-variant="3"] .vc-perch { border-radius: 22px; }
.vc[data-layout="dock"] .vc-name, .vc[data-layout="dock"] .vc-sim { display: none; }
.vc[data-layout="dock"] .vc-status { align-items: center; }
.vc[data-layout="dock"]:not([data-collapsed]) .vc-controls { position: absolute; left: auto; right: 3px; top: 0; bottom: 0; z-index: 2; flex-direction: column; justify-content: center; }
.vc[data-layout="dock"] .vc-body { background: transparent; border-top: 0; border-right: 1px solid var(--color-border); }

/* Collapsed shapes */
.vc[data-collapsed] { cursor: grab; }
.vc-shape { all: unset; box-sizing: border-box; display: flex; align-items: center; width: 100%; height: 100%; cursor: pointer; position: relative; }
.vc[data-collapsed] .vc-perch { background: var(--vc-perch); }
.vc[data-collapsed][data-variant="1"] { border-radius: 50%; }
.vc[data-collapsed][data-variant="1"] .vc-perch { width: 100%; height: 100%; border-radius: 50%; }
.vc[data-collapsed][data-variant="2"] { border-radius: 999px; }
.vc[data-collapsed][data-variant="2"] .vc-shape { gap: 8px; padding: 0 14px 0 4px; }
.vc[data-collapsed][data-variant="2"] .vc-perch { width: 44px; height: 44px; border-radius: 50%; }
.vc[data-collapsed][data-variant="2"] .vc-perch::after { inset: 2px; }
.vc[data-collapsed][data-variant="3"] { border-radius: 20px; }
.vc[data-collapsed][data-variant="3"] .vc-perch { width: 100%; height: 100%; border-radius: 20px; }
.vc[data-collapsed][data-variant="3"] .vc-perch::after { inset: 4px; border-radius: 16px; }
.vc-flag {
  position: absolute; right: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; box-sizing: border-box;
  background: var(--color-info); border: 2px solid var(--color-raised); animation: vc-flag 1400ms ease-in-out infinite;
}
@keyframes vc-flag { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.22); } }
.vc[data-collapsed][data-layout="dock"] { display: flex; align-items: center; gap: 10px; padding-left: 10px; padding-right: 10px; }
.vc[data-collapsed][data-layout="dock"] .vc-shape { width: auto; height: auto; flex: none; }
.vc[data-collapsed][data-layout="dock"] .vc-perch { width: 44px; height: 44px; border-radius: 50%; }
.vc[data-collapsed][data-layout="dock"][data-variant="3"] .vc-perch { border-radius: 14px; }
.vc[data-collapsed][data-layout="dock"] .vc-perch::after { inset: 2px; }
.vc-strip { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; pointer-events: none; }
.vc-strip-line { font-size: 12.5px; color: var(--color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

@media (prefers-reduced-motion: reduce) {
  .vc, .vc-captions, .vc-deleg, .vc-char, .vc-line[data-old], .vc-btn, .vc-act, .vc-talk { transition: none; }
  .vc-pop, .vc-line, .vc-char-body, .vc-char-eyes, .vc-flag, .vc[data-phase="listening"] .vc-perch::after { animation: none; }
}
`;
