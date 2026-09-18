/* The kanban board's line glyphs, drawn from the approved prototype's icon set
   (`prototypes/kanban-board/app.js` ICON): one stroke width, sized by CSS. */

export const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const ChevronDown = () => <svg {...svgProps} className="chev"><path d="m6 9 6 6 6-6" /></svg>;
export const ChevronRight = ({ flip = false }: { flip?: boolean }) => <svg {...svgProps} className={`chev${flip ? " flip" : ""}`}><path d="m9 6 6 6-6 6" /></svg>;
export const MoreGlyph = () => (
  <svg {...svgProps}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);
export const CloseGlyph = () => <svg {...svgProps}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const CollapseGlyph = () => <svg {...svgProps}><path d="m17 11-5-5-5 5" /><path d="m17 18-5-5-5 5" /></svg>;
export const ExpandGlyph = () => <svg {...svgProps}><path d="m7 6 5 5 5-5" /><path d="m7 13 5 5 5-5" /></svg>;
export const MaximizeGlyph = () => <svg {...svgProps}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>;
export const MinimizeGlyph = () => <svg {...svgProps}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>;
export const BranchGlyph = () => <svg {...svgProps}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-10 7" /></svg>;
