"use client";

import { useLocale } from "@/lib/i18n";

import { contextTokenBand, contextTokensTitle, formatContextTokens, type ContextTokens } from "../contextTokens";

/* The four bands of docs/design/tool-call-tokens.md §7, spelled out so Tailwind
   sees every class: quiet like the duration, then amber, orange, and a
   semibold red for the calls that took the most context. */
const BAND_CLASS = [
  "text-muted",
  "text-warning",
  "text-caution font-medium",
  "text-danger font-semibold",
] as const;

/** The number of context tokens a tool call added, printed right after its
    duration (`352ms · 12.4k`). `lead` adds the muted dot that joins it to a
    duration on the same row; the hover title says what the number is. */
export function ContextTokensCaption({
  value,
  scope = "call",
  lead = false,
}: {
  value: ContextTokens | undefined;
  scope?: "call" | "calls";
  lead?: boolean;
}) {
  const { locale } = useLocale();
  if (!value) return null;
  const band = contextTokenBand(value.n);
  return (
    <span
      data-context-tokens
      data-context-band={band}
      data-context-basis={value.basis}
      title={contextTokensTitle(value, scope, locale)}
      className="shrink-0 whitespace-nowrap text-caption tabular-nums"
    >
      {lead ? <span className="mx-1 text-muted" aria-hidden>·</span> : null}
      <span className={BAND_CLASS[band]}>{formatContextTokens(value)}</span>
    </span>
  );
}
