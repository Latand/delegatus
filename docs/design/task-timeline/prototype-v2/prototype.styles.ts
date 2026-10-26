/*
 * The prototype's own rules, from the product's tokens alone: no new colour,
 * font, pill or card shape. The «Summary» block and the timeline's result
 * lines reuse the card's type scale (label 11 px, ui 12 px, body 13 px), its
 * inks (primary, secondary, muted, accent for a link) and its surfaces
 * (card, well). The phone block takes the task screen's card frame.
 */
export const PROTOTYPE_CSS = `
/* ── the variant band over every frame ─────────────────────────────────── */
.proto-band { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 12px; border-bottom: 1px solid var(--border-default); background: var(--surface-sunken); font-size: var(--text-label); line-height: 16px; color: var(--color-primary); }
.proto-band-n { flex: none; padding: 1px 8px; border-radius: 999px; background: var(--color-accent-soft); color: var(--color-accent); font-weight: 700; }
.proto-band-name { min-width: 0; flex: 1; font-weight: 600; overflow-wrap: anywhere; }

/* ── the «Summary» block ────────────────────────────────────────────────── */
.tsum { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tsum-head { display: flex; align-items: baseline; gap: 8px; margin: 0; font-size: var(--text-label); font-weight: 700; line-height: 16px; color: var(--color-secondary); }
.tsum-by { margin-left: auto; font-weight: 400; color: var(--color-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tsum-lead { margin: 0; font-size: var(--text-ui); line-height: 17px; color: var(--color-primary); overflow-wrap: anywhere; }
.tsum-facts { margin: 0; font-size: var(--text-label); line-height: 16px; color: var(--color-muted); overflow-wrap: anywhere; }
.tsum-facts b { font-weight: 600; color: var(--color-secondary); }
.tsum-facts .num { font-variant-numeric: tabular-nums; }
/* Variant 2: labelled rows, the label in a column of its own. */
.tsum-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 10px; row-gap: 4px; margin: 0; font-size: var(--text-label); line-height: 16px; }
.tsum-rows dt { margin: 0; font-weight: 600; color: var(--color-muted); white-space: nowrap; }
.tsum-rows dd { margin: 0; color: var(--color-primary); overflow-wrap: anywhere; }
/* Variant 3: a panel on the well surface, the one the card's details use. */
.tsum-panel { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; background: var(--surface-well); }
.tsum-title { margin: 0; font-size: var(--text-ui); line-height: 17px; font-weight: 600; color: var(--color-primary); overflow-wrap: anywhere; }
.tsum-panel .tsum-lead { font-size: var(--text-label); line-height: 16px; color: var(--color-secondary); }

/* The phone: the task screen's card frame and its type. */
.tsum.phone { gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--surface-card); box-shadow: var(--shadow-1); }
.tsum.phone .tsum-head { font-size: var(--text-body); line-height: 18px; font-weight: 600; color: var(--color-primary); }
.tsum.phone .tsum-by { font-size: var(--text-label); }
.tsum.phone .tsum-lead { font-size: var(--text-body); line-height: 19px; }
.tsum.phone .tsum-facts { font-size: var(--text-ui); line-height: 17px; }
.tsum.phone .tsum-rows { font-size: var(--text-ui); line-height: 17px; row-gap: 6px; }
.tsum.phone.v3 { background: var(--surface-well); box-shadow: inset 0 0 0 1px var(--border-default); }
.tsum.phone .tsum-panel { padding: 0; background: none; }
.tsum.phone .tsum-title { font-size: var(--text-body); line-height: 18px; }
.tsum.phone .tsum-panel .tsum-lead { font-size: var(--text-ui); line-height: 17px; }

/* ── the timeline's result lines ────────────────────────────────────────── */
/* A stage's one-line result, under the entry's words; a reason names the
   entry it answers as a link, in the words the timeline itself uses. */
.tl-note { display: block; color: var(--color-muted); overflow-wrap: anywhere; }
.tl-note a { all: unset; cursor: pointer; color: var(--color-accent); border-radius: 3px; }
.tl-note a:hover { text-decoration: underline; text-underline-offset: 2px; }
.tl-note a:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
/* Variant 2: the result runs on in the entry's own line. */
.v2 .tl-note { display: inline; }
.v2 .tl-note::before { content: " · "; }
/* Variant 3: an entry that answers another carries a rule beside its words. */
.v3 .chronology-entry.answers .chronology-what { padding-left: 8px; box-shadow: inset 2px 0 0 var(--border-strong); }
.v3 .tl-note { color: var(--color-secondary); }
.v3 .tl-note .tl-why { color: var(--color-muted); }
/* The phone's timeline rows: the words start on the time's line and keep
   their 44 px target through padding a negative margin takes back. */
.chronology.phone .chronology-open { flex-direction: column; align-items: flex-start; justify-content: flex-start; min-height: 0; padding: 13px 0; margin: -13px 0; }
.chronology.phone .tl-note { font-size: var(--text-ui); line-height: 18px; }
`;
