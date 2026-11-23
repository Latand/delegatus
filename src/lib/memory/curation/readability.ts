/** Advisory evidence for the curator; technical notation can be intentional. */
export function readabilityHint(text: string): { needsRewrite: true; signals: string[] } | undefined {
  // Ignore code spans, URLs and file paths before looking for prose shorthand.
  const prose = text.replace(/`[^`]*`|https?:\/\/\S+|(?:[\w.-]+\/)+[\w.-]+\.[\w.-]+/gu, " ");
  const signals: string[] = [];
  if (/\p{L}[\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_-]+){2,}/u.test(prose)) signals.push("slash-list");
  if (/(?:→|⇒|->|=>).*?(?:→|⇒|->|=>)/u.test(prose)) signals.push("arrow-chain");
  if ((prose.match(/;/gu)?.length ?? 0) >= 3) signals.push("fragment-chain");
  return signals.length ? { needsRewrite: true, signals } : undefined;
}
