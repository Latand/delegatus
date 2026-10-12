/** Spans removed by the privacy gate's visible HTML/Markdown projections. */
export function* privacyMarkupSpans(text: string, punctuation = false): Generator<{ start: number; end: number }> {
  let pattern = punctuation ? /[<\[\]*_`~]/g : /</g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    if (match[0] === "<") {
      const closing = text.indexOf(">", start + 1);
      if (closing < 0) {
        // No later opening can close either. Preserve the unmatched suffix,
        // while still removing email projection punctuation within it.
        if (!punctuation) return;
        pattern = /[\[\]*_`~]/g;
        pattern.lastIndex = start + 1;
        continue;
      }
      pattern.lastIndex = closing + 1;
      yield { start, end: closing + 1 };
    } else {
      yield { start, end: start + 1 };
    }
  }
}

export function stripPrivacyHtml(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const span of privacyMarkupSpans(text)) {
    parts.push(text.slice(cursor, span.start));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
