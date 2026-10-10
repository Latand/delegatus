/*
 * How the mandate card reads one delivered mandate (#1166).
 *
 * WHICH row is a mandate is delivery evidence, not text: the seat records the
 * identity of the delivery that created it, and the provenance seam projects
 * that fact onto exactly that row. This module only reads the text of a row
 * already known to be one, and answers the two things the card shows: how long
 * the whole delivery is, and which part of it is the rotation handoff.
 *
 * Pure and render-time only: no transcript byte changes, and nothing here is
 * stored.
 */

/** The headings a rotation handoff is composed under (`seatCommand.ts`), and
    the compact history variant. Matched at the start of a line, so the same
    words quoted inside a mandate never split it. */
const HANDOFF_HEADINGS = ["## Handoff from your predecessor", "## Rotation history"] as const;

/** Any top-level markdown heading — where one section of the delivery ends and
    the next begins. */
const SECTION_HEADING = /^#{1,2} /;

/** The one directive delivery appends WITHOUT a heading
    (`ORCHESTRATOR_PROTOTYPE_DIRECTIVE` in `prompt.ts`, #2658). It is the
    mandate's, and it lands right after a bespoke rotation's handoff, so it
    closes the handoff the way a heading does. */
const DELIVERED_PARAGRAPH = "Prototype review: ";

export interface MandateMessage {
  /** Lines of the WHOLE delivered message, sections included — the size the
      card is standing in for. */
  lines: number;
  /** The mandate proper, without the rotation handoff. */
  mandate: string;
  /** The rotation handoff, when this delivery carried one — without its
      opening heading, which the card's own section label already says. */
  handoff: string | null;
}

/**
 * Where the rotation handoff starts and ends, or null when there is none.
 *
 * A handoff runs from its own heading to the next OTHER section's, not to the
 * end of the delivery: a rotation composes the handoff after the mandate, and
 * delivery then appends the initial-status directive to any mandate that does
 * not already carry it — so on a bespoke rotation the final section of the
 * message belongs to the mandate, on the far side of the handoff.
 *
 * Handoffs that stack — each rotation appends one to the mandate it inherited —
 * are consecutive sections of the same lineage, and stay one disclosure.
 */
function handoffSpan(text: string): { start: number; end: number } | null {
  let offset = 0;
  let start = -1;
  for (const line of text.split("\n")) {
    const isHandoff = HANDOFF_HEADINGS.some((heading) => line.startsWith(heading));
    if (start < 0) {
      if (isHandoff) start = offset;
    } else if (!isHandoff && (SECTION_HEADING.test(line) || line.startsWith(DELIVERED_PARAGRAPH))) {
      return { start, end: offset };
    }
    offset += line.length + 1;
  }
  return start < 0 ? null : { start, end: text.length };
}

export function mandateMessage(text: string): MandateMessage {
  const lines = text.split("\n").length;
  const span = handoffSpan(text);
  if (!span) return { lines, mandate: text.trim(), handoff: null };
  /* Whatever the handoff interrupted is one mandate again. */
  const mandate = [text.slice(0, span.start).trim(), text.slice(span.end).trim()].filter(Boolean).join("\n\n");
  /* The span opens on its heading by construction. Under the card's «Rotation
     handoff» label it said the same thing a second time, so the body starts
     with the handoff's own words; a stacked handoff's later headings stay, as
     the separators between rotations. */
  const body = text.slice(span.start, span.end);
  const heading = body.indexOf("\n");
  return { lines, mandate, handoff: heading < 0 ? "" : body.slice(heading + 1).trim() };
}
