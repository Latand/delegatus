import { LAYER } from "./layers";

/**
 * The look of a sound caption: the voice Delegatus popup's bubble, tokens only.
 *
 * The bubble is `.vc-bubble[data-speaker="companion"]` in
 * `voiceCompanion/voiceCompanionStyles.ts` (surface, border, radius, shadow and
 * blur) with its `.vc-who` weight and `--vc-ease`. It is not an exported
 * component and its sheet is scoped to the companion's lane, so the values are
 * repeated here rather than the file edited. There is no tail: no character
 * points at the toast.
 */
export const SOUND_CAPTION_CSS = `
.sc-column {
  position: fixed; z-index: ${LAYER.toast}; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  pointer-events: none; font-size: 15px; line-height: normal;
}
.sc-toast {
  display: block; box-sizing: border-box; max-width: 300px; margin: 0; padding: 8px 12px; text-align: left;
  font: inherit; color: var(--color-primary); overflow-wrap: anywhere; pointer-events: auto;
  background: color-mix(in srgb, var(--color-raised) 92%, transparent); border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
  box-shadow: 0 6px 18px color-mix(in srgb, var(--color-warning) 16%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  animation: sc-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
button.sc-toast { cursor: pointer; }
.sc-toast:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.sc-toast[data-leaving] { pointer-events: none; animation: sc-out 140ms linear both; }
.sc-toast[data-folded] { position: fixed; top: 0; left: -10000px; visibility: hidden; pointer-events: none; animation: none; }
@media (max-width: 1099px) {
  .sc-toast { max-width: 240px; }
}
.sc-line { display: block; font-size: 14px; line-height: 20px; font-weight: 600; text-wrap: pretty; }
.sc-who { font-weight: 700; }
.sc-subject { display: block; margin-top: 2px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--color-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes sc-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes sc-out { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .sc-toast { animation-name: sc-fade-in; }
  .sc-toast[data-leaving] { animation-name: sc-out; }
}
@keyframes sc-fade-in { from { opacity: 0; } to { opacity: 1; } }
`;
