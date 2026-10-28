"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { browserZone, clockText } from "@/components/activity/format";
import { OutputPreview } from "@/components/feed/cards/OutputPreview";
import { ChevronRight } from "@/components/icons";
import { StageGlyph } from "@/components/kanban/StageGlyph";
import { TooltipBubble } from "@/components/TooltipBubble";
import { humanizeDuration } from "@/components/turnDuration";
import { useNowSeconds } from "@/hooks/useNowSeconds";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

type Setup = NonNullable<PipelineStageAttempt["setup"]>;

/* A failure's tail is read without a click; wrapped in a narrow stage pane,
   eight long lines would push the conversation below out of view. */
const SETUP_TAIL_CHARS = 480;

/*
 * The project setup that ran before a Builder attempt: one line, a dot in the
 * outcome's tone and the outcome in words. A failure opens on its command and
 * the end of its output; a pass stays one closed line. When the setup started
 * and how long it took is the dot's popover, so the line says it once.
 */
export function StageSetupResult({ setup, worktreeDir, fit = false }: {
  setup: PipelineStageAttempt["setup"];
  worktreeDir: string | null;
  /** In a host of fixed height (a stage pane): the result takes at most half
      of it, and an open failure scrolls its output, held at the end, where
      the failing command says why. */
  fit?: boolean;
}) {
  const { t } = useLocale();
  if (!setup) return null;
  const failed = setup.state === "failed";
  const words = failed && setup.code !== null ? t("projectSetup.failedExit", { code: setup.code }) : t(`projectSetup.${setup.state}`);
  const dir = relativeDir(setup.cwd, worktreeDir);
  const stderr = setup.stderr.trim() ? setup.stderr : "";
  const stdout = setup.stdout.trim() ? setup.stdout : "";
  const both = Boolean(stderr && stdout);
  return (
    /* `reader-host` keeps the board's button reset off the output's own controls, as in a conversation. */
    <div data-stage-setup={setup.state} className={`reader-host flex min-w-0 items-start gap-2 text-label leading-4 ${fit ? "min-h-0 max-h-1/2" : "shrink-0"}`}>
      <SetupDot setup={setup} />
      {/* A bounded host bounds the details' content too, so only the output
          below the summary scrolls. */}
      <details className="group flex min-h-0 min-w-0 flex-1 flex-col self-stretch [&::details-content]:flex [&::details-content]:min-h-0 [&::details-content]:flex-col" open={failed || undefined}>
        <summary className="flex min-h-6 shrink-0 cursor-pointer list-none items-center gap-1 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <span className={`min-w-0 break-words font-semibold ${failed ? "text-danger" : "text-secondary"}`}>{words}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        </summary>
        <SetupBody fit={fit}>
          <code className="block break-words [overflow-wrap:anywhere] font-mono text-[12px] text-primary" data-stage-setup-command>
            $ {setup.command.map(shellWord).join(" ")}
          </code>
          {dir ? <p className="mt-0.5 break-words [overflow-wrap:anywhere] text-muted">{t("projectSetup.inDir", { dir })}</p> : null}
          {stderr ? <OutputPreview output={stderr} truncated={false} tone="err" heading={both ? t("tools.stderr") : undefined}
            copyLabel={t("tools.copyStderr")} previewLines={8} previewChars={SETUP_TAIL_CHARS} from="end" holdControl /> : null}
          {stdout ? <OutputPreview output={stdout} truncated={false} heading={both ? t("tools.stdout") : undefined}
            previewLines={8} previewChars={SETUP_TAIL_CHARS} from="end" holdControl /> : null}
          {!stderr && !stdout && setup.state !== "running" ? <p className="mt-1 text-muted">{t("projectSetup.noOutput")}</p> : null}
        </SetupBody>
      </details>
    </div>
  );
}

/* The details' content below the summary. In a bounded host it scrolls when
   the output is taller than the room, held at its end by a reversed column as
   the room changes; the scroller then gives up the part of the line its top
   edge would cut, so every line in view is whole. */
function SetupBody({ fit, children }: { fit: boolean; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = body.current, inner = content.current;
    if (!fit || !scroller || !inner) return;
    const details = scroller.closest("details"), host = scroller.closest("[data-stage-setup]")?.parentElement;
    const align = () => {
      scroller.style.maxHeight = "";
      for (let pass = 0; pass < 3 && scroller.scrollHeight > scroller.clientHeight + 1; pass++) {
        const cut = lineCutAt(scroller);
        if (cut <= 0) break;
        scroller.style.maxHeight = `${Math.max(0, scroller.clientHeight - cut)}px`;
      }
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(inner);
    if (host) observer?.observe(host);
    details?.addEventListener("toggle", align);
    return () => { observer?.disconnect(); details?.removeEventListener("toggle", align); };
  }, [fit]);
  return (
    /* The scroller reaches 4 px past the text on its left so a focus ring on the output's controls is not cut. */
    <div ref={body} className={fit ? "-ml-1 flex min-h-0 min-w-0 flex-col-reverse overflow-y-auto pl-1" : "min-w-0"} data-stage-setup-body="">
      <div ref={content} className="min-w-0 pb-1">{children}</div>
    </div>
  );
}

/** How far below the scroller's top edge what it cuts reaches: a line of
    words, or the end of a box whose words all sit above the edge; 0 when
    nothing is cut. */
function lineCutAt(scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top;
  const range = document.createRange();
  const lines = (within: Element) => {
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      range.selectNodeContents(walker.currentNode);
      rects.push(...range.getClientRects());
    }
    return rects;
  };
  let cut = 0;
  for (const rect of lines(scroller)) if (rect.top < top - 0.5 && rect.bottom > top + 0.5) cut = Math.max(cut, Math.ceil(rect.bottom - top));
  for (const element of scroller.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    if (box.top < top - 0.5 && box.bottom > top + 0.5 && !lines(element).some((rect) => rect.bottom > top + 0.5)) cut = Math.max(cut, Math.ceil(box.bottom - top));
  }
  return cut;
}

/* While setup runs, its popover counts on a one-second clock; a finished
   setup's words never change, so it takes no clock. */
function SetupDot({ setup }: { setup: Setup }) {
  return setup.completedAt ? <SetupDotWords setup={setup} endMs={Date.parse(setup.completedAt)} /> : <LiveSetupDot setup={setup} />;
}

function LiveSetupDot({ setup }: { setup: Setup }) {
  return <SetupDotWords setup={setup} endMs={useNowSeconds(1000) * 1000} />;
}

/* The dot opens its one-line popover by hover, focus or tap, as a card's state
   dot does (CardStateDot). */
function SetupDotWords({ setup, endMs }: { setup: Setup; endMs: number }) {
  const { t, locale } = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const [open, setOpen] = useState(false);
  const started = Date.parse(setup.startedAt);
  const time = Number.isFinite(started) ? clockText(started, locale, browserZone()) : "";
  const duration = humanizeDuration(Math.max(0, (endMs - started) / 1000), locale);
  const words = t(setup.completedAt ? "projectSetup.took" : "projectSetup.soFar", { time, duration });
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  const place = useCallback((size: { width: number; height: number }) => setupPopPlace(anchor.current!, size), []);
  /* On a coarse pointer the dot's own column is the 44 px target. The dot keeps
     the host's content edge; the target extends around it into the host's
     12 px side padding and ends where the summary's target begins, so it
     takes no tap meant for the summary. It is square so a tap in its corners
     still lands. */
  return (
    <span className="flex min-h-6 shrink-0 items-center pointer-coarse:min-h-11">
      <span
        ref={ref}
        className="relative flex rounded-full after:absolute after:-inset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:-ml-3 pointer-coarse:-mr-1 pointer-coarse:size-11 pointer-coarse:rounded-control pointer-coarse:items-center pointer-coarse:pl-3 pointer-coarse:after:hidden"
        data-stage-setup-dot=""
        role="button"
        tabIndex={0}
        aria-label={`${t("projectSetup.title")}: ${words}`}
        aria-expanded={open}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false); }}
        onPointerDown={() => { pressed.current = true; }}
        onFocus={() => { if (!pressed.current) setOpen(true); }}
        onBlur={() => { pressed.current = false; setOpen(false); }}
        onClick={(event) => { event.stopPropagation(); pressed.current = false; setOpen((value) => !value); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
          else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }
        }}
      >
        <span ref={anchor} className="flex"><StageGlyph state={setup.state} model={null} fallback="tone" /></span>
        {open ? (
          <TooltipBubble anchorRef={anchor} place={place} className="card-state-pop">
            <span data-stage-setup-pop="">{words}</span>
          </TooltipBubble>
        ) : null}
      </span>
    </span>
  );
}

const POP_GAP = 6;
const POP_EDGE = 8;

/*
 * The popover goes where it covers no words, so the line keeps the host's own
 * spacing with no room held for it: beside the summary words, then above or
 * below the line at either end, then beside it past the host's edge, then a
 * row or more further up or down, nearest first. Beside the words it centres
 * on the line, else lines up with its foot or its head so it stays out of the
 * neighbours' rows. When every place covers words, the one covering the
 * fewest wins.
 */
function setupPopPlace(glyph: Element, size: { width: number; height: number }): { left: number; top: number } {
  const host = glyph.closest("[data-stage-setup]")!;
  const box = host.getBoundingClientRect(), dot = glyph.getBoundingClientRect();
  const line = host.querySelector("summary")!.getBoundingClientRect();
  const end = host.querySelector("summary > :last-child")!.getBoundingClientRect().right + POP_GAP;
  const beside = [line.top + line.height / 2 - size.height / 2, line.bottom - size.height, line.top];
  const above = dot.top - POP_GAP - size.height, below = dot.bottom + POP_GAP;
  const around = (step: number) => [above - step, below + step].flatMap((top) => [{ left: dot.left, top }, { left: box.right - size.width, top }]);
  const places = [
    ...beside.map((top) => ({ left: end, top, within: true })),
    ...around(0),
    ...beside.map((top) => ({ left: end, top })),
    ...[8, 16, 24, 32, 40, 48].flatMap(around),
  ].filter((place) => (!("within" in place) || place.left + size.width <= box.right)
    && place.left >= POP_EDGE && place.top >= POP_EDGE
    && place.left + size.width <= window.innerWidth - POP_EDGE && place.top + size.height <= window.innerHeight - POP_EDGE);
  const under = (place: { left: number; top: number }, limit = Infinity) =>
    wordsUnder({ left: place.left, top: place.top, right: place.left + size.width, bottom: place.top + size.height }, limit);
  /* A place is passed over at its first word; words are counted only when none is free. */
  let best = places.find((place) => !under(place, 1)), fewest = Infinity;
  if (!best) for (const place of places) {
    const words = under(place, fewest);
    if (words < fewest) { best = place; fewest = words; }
  }
  return best ? { left: best.left, top: best.top } : { left: Math.max(POP_EDGE, dot.left), top: Math.max(POP_EDGE, above) };
}

/** How many sample points of `box`, at most 6 px apart and on its edges, fall
    on drawn words, counted up to `limit`. Hit testing skips the bubble itself
    (it takes no pointer) and anything a scroller hides. */
function wordsUnder(box: { left: number; top: number; right: number; bottom: number }, limit: number): number {
  const steps = (from: number, to: number) => {
    const values: number[] = [];
    for (let at = from; at < to; at += 6) values.push(at);
    return [...values, to];
  };
  const range = document.createRange();
  let count = 0;
  for (const y of steps(box.top + 1, box.bottom - 1)) for (const x of steps(box.left + 1, box.right - 1)) {
    hit: for (const element of document.elementsFromPoint(x, y)) for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) { count++; break hit; }
    }
    if (count >= limit) return count;
  }
  return count;
}

/** One argument as a shell reads it: quoted only when it has to be. */
export function shellWord(arg: string): string {
  if (arg && !/[\s'"\\$`!*?#&;|<>(){}[\]~]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The working directory against the lane's checkout; null when it is the checkout itself. */
export function relativeDir(cwd: string, root: string | null): string | null {
  const trim = (value: string) => value.replace(/[\\/]+$/, "");
  const dir = trim(cwd), base = root ? trim(root) : "";
  if (base && dir === base) return null;
  if (base && (dir.startsWith(base + "/") || dir.startsWith(base + "\\"))) return dir.slice(base.length + 1);
  return dir || null;
}

/** The lane's most recent project setup, across its stages' attempts. */
export function latestSetup(pipeline: Pipeline): PipelineStageAttempt["setup"] {
  let latest: PipelineStageAttempt["setup"];
  for (const run of pipeline.runs) for (const attempt of run.attempts)
    if (attempt.setup && (!latest || Date.parse(attempt.setup.startedAt) >= Date.parse(latest.startedAt))) latest = attempt.setup;
  return latest;
}
