"use client";

import { useState } from "react";

import { ChevronUp } from "../../icons";
import { ACTION_GUTTER, MESSAGE_ACTION } from "../actionStyles";
import { CopyButton } from "../CopyButton";
import { CodeBlock } from "../markdown";
import { tr } from "../parse";

/** Level-1 preview budget; "show all output" reveals the full capped string. */
const PREVIEW_LINES = 24;
const PREVIEW_CHARS = 4_096;

/**
 * Capped tool output with a lazy "show all" reveal, or — when the output is
 * absent — one compact dim chip that replaces the old apology paragraphs
 * (issue #9 §6). A `lang` hint upgrades the expanded body to highlighted code.
 */
export function OutputPreview({
  output,
  truncated,
  lang,
  copyLabel,
  heading,
  tone = "out",
  showAllLabel,
  previewLines = PREVIEW_LINES,
  previewChars = PREVIEW_CHARS,
  from = "start",
}: {
  output: string;
  truncated: boolean;
  lang?: string | null;
  copyLabel?: string;
  /** Small stream label above the block (e.g. "stdout"/"stderr", issue #475). */
  heading?: string;
  /** `err` tints the block and heading for the stderr stream. */
  tone?: "out" | "err";
  showAllLabel?: string;
  /** How many lines the collapsed preview keeps. */
  previewLines?: number;
  /** How many characters the collapsed preview keeps; wrapped lines count by length. */
  previewChars?: number;
  /** `end` keeps the last lines, where a failing command says why it failed. */
  from?: "start" | "end";
}) {
  const [all, setAll] = useState(false);
  const label = heading ? (
    <div className={`mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${tone === "err" ? "text-danger" : "text-muted"}`}>{heading}</div>
  ) : null;
  /* Absent output renders nothing at all: an "no output captured" apology row
     is pure noise the operator scrolls past (compact-feed pass). */
  if (!output.trim()) return null;
  const lines = (from === "end" ? output.trimEnd() : output).split("\n");
  const overflow = lines.length > previewLines || output.length > previewChars;
  const shown = all ? output
    : from === "end" ? lastChars(lines.slice(-previewLines).join("\n"), previewChars)
    : lines.slice(0, previewLines).join("\n").slice(0, previewChars);
  /* stderr keeps a thin danger left-edge so the failing stream stays scannable
     without wrapping the whole block in its own bordered card. */
  const edge = tone === "err" ? "border-l-2 border-danger/50 pl-2" : "";
  /* One block, one copy control (issue #698). The highlighted body is a
     `CodeBlock`, which brings its own control at the same top-right anchor — a
     second one here landed on top of it and left the lower one unreachable, and
     `MESSAGE_ACTION`'s opacity-70 made that collision permanent instead of
     hover-only. So the control is delegated with this block's label, and the
     block copies `output` rather than `shown`: they are the same string in this
     branch (`all` is true), but the full-output guarantee should not rest on
     the reader noticing that. */
  const embedded = all && lang ? lang : null;
  const copy = copyLabel ?? tr("tools.copyOutput");
  return (
    <div className="group/out relative mt-1.5">
      {label}
      {embedded ? (
        <CodeBlock code={output} lang={embedded} copyLabel={copy} />
      ) : (
        <pre className={`max-h-[420px] max-w-full overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12px] text-secondary ${ACTION_GUTTER} ${edge}`}>
          {shown}
        </pre>
      )}
      {embedded ? null : (
        <CopyButton
          text={output}
          label={copy}
          /* Issue #698: was `opacity-0` on desktop and a permanent 60% overlay
             on a coarse pointer, over an 8px gutter that a 44px button dwarfed. */
          className={`absolute right-[6px] ${MESSAGE_ACTION} group-hover/out:opacity-100 ${heading ? "top-5" : "top-[6px]"}`}
        />
      )}
      {overflow ? (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {all ? (
            <>
              {tr("common.collapse")} <ChevronUp className="h-3 w-3" aria-hidden />
            </>
          ) : (
            (showAllLabel ?? tr("tools.showOutput")) + (truncated ? " · " + tr("render.truncated") : "")
          )}
        </button>
      ) : truncated ? (
        <div className="mt-1 text-[11px] text-muted">{tr("render.truncated")}</div>
      ) : null}
    </div>
  );
}

/** The end of `text` within `chars`, from a whole line when one fits, else marked as cut. */
function lastChars(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const start = cut.indexOf("\n");
  return start >= 0 && start < cut.length - 1 ? cut.slice(start + 1) : `…${cut}`;
}
