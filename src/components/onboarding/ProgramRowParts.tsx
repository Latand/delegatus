"use client";

import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";

import { EngineMark } from "@/components/EngineMark";
import { CopyButton } from "@/components/feed/CopyButton";
import { DOT_CLASS, StatusDot, type DotTone } from "@/components/settings/StatusDot";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";

/**
 * What a program's row is built from on the setup guide's Accounts step and
 * on its welcome (docs/design/onboarding-v2.md §3.1–§3.2): the mark, the name,
 * and one state line that its status dot leads. The command a not-installed
 * program shows and the step's one "Check again" live here too, because the
 * Antigravity body of the sidebar footer and of the phone's accounts screen
 * draws them as well.
 */

export type ProgramId = "claude" | "codex" | "antigravity" | "copilot";

export const PROGRAM_IDS: readonly ProgramId[] = ["claude", "codex", "antigravity", "copilot"];
export const PROGRAM_NAME: Record<ProgramId, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", copilot: "Copilot" };

/** What the last check learned of an installed program: where its command was found and the version it names. */
export type ProgramInstall = { path: string | null; version: string | null };
export type ProgramInstalls = Partial<Record<ProgramId, ProgramInstall>>;

/** Reads the `cliInstalls` block of `/api/accounts` and of its re-probe; anything else is no answer. */
export function programInstalls(value: unknown): ProgramInstalls {
  if (!value || typeof value !== "object") return {};
  const text = (field: unknown) => typeof field === "string" && field.trim() ? field.trim() : null;
  const installs: ProgramInstalls = {};
  for (const program of PROGRAM_IDS) {
    const entry = (value as Record<string, unknown>)[program];
    if (entry && typeof entry === "object") installs[program] = { path: text((entry as { path?: unknown }).path), version: text((entry as { version?: unknown }).version) };
  }
  return installs;
}

/** A state's words take the tone of the dot that leads them. */
export const TONE_INK: Record<DotTone, string> = { ok: "text-success", warn: "text-warning", off: "text-secondary" };

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[?::1\]?)$/i;
const noSubscription = () => () => {};

/**
 * Whether "this computer" is true: the browser runs on the computer that runs
 * Delegatus. The signal is the one the ChatGPT plan route reads for its
 * "browser on another device" state: the page was reached at a loopback
 * address. A phone is always another device.
 */
export function useOnHost(): boolean {
  const phone = useIsMobile();
  const loopback = useSyncExternalStore(noSubscription, () => LOOPBACK.test(window.location.hostname), () => false);
  return loopback && !phone;
}

const NARROW_QUERY = "(max-width: 767px)";
const narrowNow = () => window.matchMedia(NARROW_QUERY).matches;
const subscribeNarrow = (onChange: () => void) => {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * Whether the rows stand in a narrow card: a phone, and a window under 768 px,
 * where the step list leaves the list about 300 px. There a row's action
 * stands under its head, and a dot's words open in the row itself.
 */
export function useNarrowRows(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
}

/** The command a not-installed program shows: the sentence that says where to paste it, then the command and its copy control. */
export function InstallCommand({ engine, install, sentence }: { engine: string; install: { command: string; segments: readonly string[] }; sentence: string }) {
  const { t } = useLocale();
  const { command, segments } = install;
  return (
    <div data-onboarding-install={engine} className="flex min-w-0 flex-col gap-1.5">
      <p className="text-ui text-secondary">{sentence}</p>
      <div className="flex min-w-0 items-center gap-1">
        {/* Breaks only after the flags and after the slashes; the copied text is the whole command. */}
        <code data-onboarding-install-command="" className="min-w-0 rounded-[6px] bg-sunken px-2 py-1 font-mono text-ui text-primary">
          {segments.map((segment, index) => (
            <Fragment key={segment}>
              {index > 0 ? <wbr /> : null}
              <span className="whitespace-nowrap">{segment}</span>
            </Fragment>
          ))}
        </code>
        <CopyButton text={command} label={t("tools.copyCommand")} />
      </div>
    </div>
  );
}

export function RecheckButton({ onClick }: { onClick: () => void }) {
  const { t } = useLocale();
  return (
    <button type="button" data-onboarding-recheck="" onClick={onClick} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
      <RefreshCw className="h-3 w-3" aria-hidden />
      {t("onboarding.engines.recheck")}
    </button>
  );
}

/* The dot's own left edge stands under the name's. Its target reaches into the gap around it, and on a phone up over
   the name's line, so the state stays one line tall while the target holds 44 px. */
const DOT_HIT = "h-11 w-11 justify-center -ml-[18.5px] -mr-[10px] -mt-5 pt-5 sm:h-6 sm:w-6 sm:-ml-[8.5px] sm:-mr-[3px] sm:mt-0 sm:pt-0";

/**
 * The dot in a narrow card. Beside a program's name a 300 px card leaves a
 * popover some 130 px, which two short lines do not fit, so the dot's words
 * open in the row itself, in its `data-program-dot-note` place under the state
 * line, and cover nothing. A press toggles them; Escape and a press elsewhere
 * close them. They stand right under the line they belong to, so `shown` is
 * what that line leaves out; the label a screen reader hears keeps the whole
 * note.
 */
function InlineDot({ tone, note, shown, label }: { tone: DotTone; note: string; shown: string; label: string }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [place, setPlace] = useState<Element | null>(null);
  const open = place !== null;
  /* Words that open at the foot of the list come into view above the guide's footer. */
  useEffect(() => { place?.scrollIntoView?.({ block: "nearest" }); }, [place]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPlace(null);
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || place?.contains(target)) return;
      setPlace(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, place]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-settings-dot={tone}
        aria-label={`${label}: ${note}`}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setPlace(open ? null : trigger.current?.closest("[data-program-dot-row]")?.querySelector("[data-program-dot-note]") ?? null);
        }}
        className={`flex shrink-0 items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${DOT_HIT}`}
      >
        <span aria-hidden className={`block h-[7px] w-[7px] rounded-full ${DOT_CLASS[tone]}`} />
      </button>
      {place ? createPortal(<span role="status" data-settings-dot-popover="" data-program-dot-inline="" className="block break-words pb-0.5 pl-[12.5px] text-ui leading-snug text-secondary max-sm:pl-[15.5px]">{shown}</span>, place) : null}
    </>
  );
}

/** A dot whose line already says everything: it opens nothing, and keeps its place and its name for a screen reader. */
function PlainDot({ tone, note, label }: { tone: DotTone; note: string; label: string }) {
  return (
    <span role="img" data-settings-dot={tone} aria-label={`${label}: ${note}`} className={`flex shrink-0 items-center ${DOT_HIT}`}>
      <span aria-hidden className={`block h-[7px] w-[7px] rounded-full ${DOT_CLASS[tone]}`} />
    </span>
  );
}

/** Where a narrow card's dot opens its words: last in the block the dot belongs to. */
export function DotNotePlace() {
  return <span data-program-dot-note="" className="block empty:hidden" />;
}

/**
 * A status dot. In a card wide enough its popover finds its place as a
 * Settings row's does: beside the name in the nearest `data-program-dot-row`,
 * over no words. An open popover closes once its dot, or the popover itself,
 * leaves the scrolling body, so it never stands over the guide's header or
 * footer. In a narrow card the words open in the row (`InlineDot`), under the
 * line the dot leads: `inline` is what they say there when that line already
 * states part of the note, and null when it states all of it.
 */
export function RowDot({ tone, note, inline = note, label }: { tone: DotTone; note: string; inline?: string | null; label: string }) {
  const narrow = useNarrowRows();
  if (!narrow) return <FloatingDot tone={tone} note={note} label={label} />;
  return inline === null ? <PlainDot tone={tone} note={note} label={label} /> : <InlineDot tone={tone} note={note} shown={inline} label={label} />;
}

function FloatingDot({ tone, note, label }: { tone: DotTone; note: string; label: string }) {
  const slot = useRef<HTMLSpanElement | null>(null);
  const [round, setRound] = useState(0);
  const anchor = useCallback(() => slot.current?.closest<HTMLElement>("[data-program-dot-row]") ?? null, []);
  useEffect(() => {
    const body = slot.current?.closest<HTMLElement>("[data-onboarding-body]");
    if (!body) return;
    const onScroll = () => {
      const glyph = slot.current?.querySelector<HTMLElement>('[data-settings-dot][aria-expanded="true"]')?.firstElementChild;
      if (!glyph) return;
      const frame = body.getBoundingClientRect();
      const outside = (box: DOMRect) => box.top < frame.top || box.bottom > frame.bottom;
      /* A fresh StatusDot is a closed one. */
      if (outside(glyph.getBoundingClientRect()) || [...document.querySelectorAll("[data-settings-dot-popover]")].some((popover) => outside(popover.getBoundingClientRect()))) setRound((held) => held + 1);
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  return <span ref={slot} className="contents"><StatusDot key={round} tone={tone} note={note} label={label} hit={DOT_HIT} anchor={anchor} /></span>;
}

/** What a program's state reads as: its words, the tone they share with the dot, and what the dot's popover adds. */
export type ProgramStateWords = { words: string; tone: DotTone; note: string };

/** One state line: the dot leads its own words, and the words keep one line. */
export function StateLine({ label, state }: { label: string; state: ProgramStateWords }) {
  return (
    <span className="flex min-w-0 items-center">
      <RowDot tone={state.tone} note={state.note} label={label} />
      <span data-onboarding-engine-header="" className={`whitespace-nowrap text-ui ${TONE_INK[state.tone]}`}>{state.words}</span>
    </span>
  );
}

/** Copilot has no mark in `EngineMark`, whose fallback is a dot that reads as a second status; its slot stays empty so the names line up. */
export function ProgramMark({ program }: { program: ProgramId }) {
  return program === "copilot" ? <span aria-hidden data-program-mark-slot="" className="block h-[18px] w-[18px] shrink-0" /> : <EngineMark engine={program} size={18} />;
}

/** The head of a program's row: the mark, the name and, under it, the state line. A row still loading holds its place.
    The name and the state are the block the dot's popover is placed against, so it ends before an action that stands beside them. */
export function ProgramHead({ program, state, grow = "flex-[1_1_10rem] max-sm:flex-[1_0_auto] sm:shrink-0" }: { program: ProgramId; state: ProgramStateWords | null; grow?: string }) {
  return (
    <>
      <ProgramMark program={program} />
      <div data-program-dot-row="" className={`flex min-w-0 flex-col ${grow}`}>
        <span><span data-settings-row-label="" className="text-body font-semibold text-primary">{PROGRAM_NAME[program]}</span></span>
        {state ? <StateLine label={PROGRAM_NAME[program]} state={state} /> : <span aria-busy className="my-1 block h-4 w-28 animate-pulse rounded-[4px] bg-sunken motion-reduce:animate-none" />}
        <DotNotePlace />
      </div>
    </>
  );
}
