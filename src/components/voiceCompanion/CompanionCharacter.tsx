import { forwardRef, useId, useImperativeHandle, useRef } from "react";

/**
 * The Delegatus character with a face that moves (#2519): the mark's own
 * geometry (`public/brand/delegatus-mark.svg`, docs/design/delegatus-brand.md)
 * with eyes that blink and a mouth driven by the level of the audio being
 * played. The level is written straight to the mouth's transform, so a sample
 * per frame costs no render.
 */

export interface CharacterHandle {
  /** Played-audio level in [0, 1]; 0 closes the mouth. */
  setLevel(level: number): void;
}

const BODY = "M32 7C18 7 10 20 10 36C10 51 19 60 32 60C45 60 54 51 54 36C54 20 46 7 32 7Z";

export const CompanionCharacter = forwardRef<CharacterHandle, { size: number }>(function CompanionCharacter({ size }, ref) {
  const clip = useId();
  const open = useRef<SVGEllipseElement>(null);
  const rest = useRef<SVGPathElement>(null);
  const shown = useRef(0);
  useImperativeHandle(ref, () => ({
    setLevel(level) {
      /* Fast to open, slower to close: a mouth that snaps shut between
         syllables reads as a flicker. */
      const target = Math.min(1, Math.max(0, level));
      const next = level === 0 ? 0 : shown.current + (target - shown.current) * (target > shown.current ? 0.7 : 0.35);
      shown.current = next;
      if (open.current) open.current.style.transform = `scale(${0.74 + next * 0.26}, ${next})`;
      if (rest.current) rest.current.style.opacity = next > 0.08 ? "0" : "1";
    },
  }), []);
  return (
    <svg className="vc-char" width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <clipPath id={clip}><path d={BODY} /></clipPath>
      <g className="vc-char-body">
        <path fill="#E0392B" d={BODY} />
        <ellipse clipPath={`url(#${clip})`} cx="32" cy="54" rx="15" ry="11" fill="#F7DCC6" />
        <path fill="#7B6D68" d="M12 23C10 14 15 7 23 6C27 3 33 2 37 4C44 2 51 2 58 1C56 5 54 8 52 10C56 13 58 17 57 22C53 19 49 18 46 19C43 22 38 22 35 20C30 18 24 19 20 22C17 24 14 24 12 23Z" />
        <path fill="#ABA09B" d="M18.0 16.0Q34.4 12.1 50.0 6.0Q33.3 8.7 18.0 16.0Z" />
        <g fill="#FBEBDD" stroke="#231B1C" strokeWidth="3.6" strokeLinejoin="round">
          <rect x="13" y="25" width="16" height="11" rx="3" />
          <rect x="35" y="25" width="16" height="11" rx="3" />
        </g>
        <path d="M29 29.5H35" stroke="#231B1C" strokeWidth="3.2" />
        <g className="vc-char-eyes" fill="#231B1C">
          <circle cx="22" cy="31" r="2.3" />
          <circle cx="42" cy="31" r="2.3" />
        </g>
        <path ref={rest} className="vc-char-rest" d="M28.6 48.4Q32 51 35.4 48.4" fill="none" stroke="#231B1C" strokeWidth="1.9" strokeLinecap="round" />
        <ellipse ref={open} className="vc-char-open" cx="32" cy="49.4" rx="4.3" ry="3.6" fill="#231B1C" style={{ transform: "scale(0.74, 0)" }} />
      </g>
    </svg>
  );
});
