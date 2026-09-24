"use client";

import { useState, type ReactNode } from "react";
import { useCollapsedTools } from "../toolDisclosure";

import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale } from "@/lib/i18n";

import { GlyphIcon, Loader2 } from "../../icons";
import { hhmm } from "../../utils";
import { ACTION_GUTTER, MESSAGE_ACTION } from "../actionStyles";
import { CopyButton } from "../CopyButton";
import { hasImageBlock, tr, type ToolEvent, type ToolOutputBlock } from "../parse";
import type { ArgChip } from "../tools";
import { formatDuration, isFollowUpCall, toolDurationMs } from "../toolBlocks";
import { DiffCard } from "./DiffCard";
import { ImageCard } from "./ImageCard";
import { OrchestrationCard } from "./OrchestrationCard";
import { OutputPreview } from "./OutputPreview";
import { StatusIcon } from "./shared";

function statusClass(status: ToolEvent["status"]): string {
  return status === "ok" ? "text-success" : status === "err" ? "text-danger" : "text-muted";
}

/* Mobile v2 (#1439, lane 4; README §5): every time on the phone is HH:MM.
   Seconds are what crowded the summary out of a 390 px tool line, and the
   prototype's headers, folds and rows never show them. The desktop keeps the
   shared `hhmm`. */
export function mobileClock(ts: unknown): string {
  if (typeof ts !== "string" && typeof ts !== "number") return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(getLocale() === "uk" ? "uk-UA" : "en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/* The calls whose running state IS the pending question. The question card
   under the feed already says it, so the phone renders no "running
   AskUserQuestion…" line above the card (prototype frame `chat-waiting`). */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
export function isPendingQuestionCall(event: ToolEvent): boolean {
  return event.status === "run" && QUESTION_TOOLS.has(event.tool);
}

export function ToolChips({ chips }: { chips: ArgChip[] }) {
  if (!chips.length) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((chip, i) => (
        <span key={i} data-tool-chip className="inline-block max-w-full [overflow-wrap:anywhere] rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-primary">
          {chip.label ? <span className="mr-1 text-muted">{chip.label}</span> : null}
          <span className="whitespace-pre-wrap">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}

/* The exit status shown in the readable block (issue #475): a real numeric code
   when the result reported one, else a plain ok/error verdict. Meaningless for a
   non-shell tool that carries no code, so those render no exit chip. */
function exitLabel(event: ToolEvent): string | null {
  if (event.exitCode !== undefined) return tr("tools.exitCode", { code: event.exitCode });
  if (event.status === "err") return event.statusLabel || tr("render.error");
  if (event.status === "ok" && event.family === "shell") return tr("tools.exitOk");
  return null;
}

/* The one trailing verdict a collapsed row carries (#1938). A failure names
   the exit code the result reported, so the danger reads as a small chip beside
   a quiet label instead of colouring and emboldening the whole line; a clean
   call shows nothing, because its exit code belongs to the expanded block's
   meta row and adds nothing to a line that already says the command ran. */
function RowStatusChip({ event }: { event: ToolEvent }) {
  if (event.status === "ok") return null;
  const label = (event.status === "err" ? exitLabel(event) : null) || event.statusLabel;
  if (!label) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-caption font-semibold ${statusClass(event.status)}`}>
      <StatusIcon status={event.status} className="h-3 w-3" />
      {label}
    </span>
  );
}

/* One quiet metadata row over the command: exit status, wall-clock span, and
   cwd — the auditable header a terminal client shows, folded into a
   single wrapping line so it never stacks into its own multi-row card. Renders
   nothing when a call carries none of them (a plain non-shell tool). */
function ToolMeta({ event }: { event: ToolEvent }) {
  const start = hhmm(event.ts);
  const end = event.endTs !== undefined ? hhmm(event.endTs) : "";
  const span = end && start ? tr("tools.ranAt", { start, end }) : "";
  const exit = exitLabel(event);
  if (!event.cwd && !span && !exit) return null;
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
      {exit ? (
        <span className={`inline-flex items-center gap-1 font-semibold ${statusClass(event.status)}`}>
          <StatusIcon status={event.status} className="h-3 w-3" />
          {exit}
        </span>
      ) : null}
      {span ? <span className="tabular-nums">{span}</span> : null}
      {event.cwd ? (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">
          <code className="min-w-0 break-all font-mono text-[11px] text-secondary" title={event.cwd}>
            {event.cwd}
          </code>
          <CopyButton text={event.cwd} label={tr("tools.copyCwd")} className="shrink-0 p-0.5" />
        </span>
      ) : null}
    </div>
  );
}

/* The full redacted command, the hero of the block: bare monospace on the
   shared sunken well (no nested card/border — those only stacked chrome the
   user did not open), wrapped instead of scrolled so a long line stays fully
   visible and never forces document-level horizontal overflow on 390px.

   The block is at least as tall as its copy control (#1978). A one-line
   command is ~20px, and on a coarse pointer the control is 44px pinned 6px
   down, so it hung 30px into the output below — over the output's own copy
   control, pinned 6px into that block. 50px is the inset plus the coarse
   size; the fine pointer's 22px control already fits beside one line. */
function CommandBlock({ command }: { command: string }) {
  return (
    <div className="group/cmd relative [@media(pointer:coarse)]:min-h-[50px]">
      <pre className={`max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] py-0.5 font-mono text-ui text-primary ${ACTION_GUTTER}`}>
        <span className="select-none text-muted">$ </span>
        {command}
      </pre>
      <CopyButton
        text={command}
        label={tr("tools.copyCommand")}
        className={`absolute right-[6px] top-[6px] ${MESSAGE_ACTION} group-hover/cmd:opacity-100`}
      />
    </div>
  );
}

/* The same rule for an output's copy control (#1978): pinned 6px down, or 20px
   under a stdout/stderr heading, a 44px coarse-pointer control overhung a
   one-line output by 14px, past its call's box and into the next call's
   header. The frame holds it; an empty output renders nothing and gets none. */
function OutputFrame({ output, heading, children }: { output: string; heading?: string; children: ReactNode }) {
  if (!output.trim()) return null;
  return <div className={heading ? "[@media(pointer:coarse)]:min-h-[64px]" : "[@media(pointer:coarse)]:min-h-[50px]"}>{children}</div>;
}

/* The expanded readable body of a tool call (issue #475): chips, the auditable
   command header, structured diff/orchestration, and separate stdout/stderr
   disclosures. Mounted lazily by {@link ToolLine} on first expand, so a long
   collapsed transcript keeps its DOM small (issue #9 §7/§8). */
export function ToolBody({ event }: { event: ToolEvent }) {
  const hasDiff = event.body?.type === "diff";
  /* An interactive follow-up with an empty result carries no useful output, so
     its apology chip stays suppressed. A collapsible empty poll also omits its
     source disclosure. Meaningful stdin keeps that bounded redacted provenance
     even when the result body is empty (issue #502). */
  const emptyFollowUp = isFollowUpCall(event) && !event.outputPreview.trim() && event.stderr === undefined && event.status !== "err";
  const showOutput = !emptyFollowUp && (!hasDiff || Boolean(event.outputPreview.trim()));
  return (
    <div className="mb-1 mt-1 rounded-surface bg-sunken px-2.5 py-2">
      <ToolChips chips={event.chips} />
      <ToolMeta event={event} />
      {event.command ? <CommandBlock command={event.command} /> : null}
      {event.orchestration ? <OrchestrationCard orchestration={event.orchestration} source={event.command} /> : null}
      {hasDiff && event.body?.type === "diff" ? <DiffCard body={event.body} /> : null}
      {showOutput ? (
        event.outputBlocks?.length ? (
          <ToolOutputBlocks
            blocks={event.outputBlocks}
            truncated={event.outputTruncated}
            lang={event.lang}
            heading={event.stderr !== undefined ? tr("tools.stdout") : undefined}
          />
        ) : (
          <OutputFrame output={event.outputPreview} heading={event.stderr !== undefined ? tr("tools.stdout") : undefined}>
            <OutputPreview
              output={event.outputPreview}
              truncated={event.outputTruncated}
              lang={event.lang}
              heading={event.stderr !== undefined ? tr("tools.stdout") : undefined}
            />
          </OutputFrame>
        )
      ) : null}
      {event.stderr !== undefined ? (
        <OutputFrame output={event.stderr} heading={tr("tools.stderr")}>
          <OutputPreview
            output={event.stderr}
            truncated={Boolean(event.stderrTruncated)}
            heading={tr("tools.stderr")}
            tone="err"
            copyLabel={tr("tools.copyStderr")}
            showAllLabel={tr("tools.showStderr")}
          />
        </OutputFrame>
      ) : null}
    </div>
  );
}

/* #1498: a result that carried pictures renders its text blocks in
   transcript order through the capped preview. The pictures themselves are
   drawn on the line, outside this body ({@link ToolImages}, #2075). A picture
   whose data did not survive falls back to the same text placeholder the
   flattened preview carries, so a broken frame degrades to a line rather than
   to a blank card. */
function ToolOutputBlocks({
  blocks,
  truncated,
  lang,
  heading,
}: {
  blocks: readonly ToolOutputBlock[];
  truncated: boolean;
  lang?: string | null;
  heading?: string;
}) {
  const lastText = blocks.reduce((last, block, index) => (block.type === "text" ? index : last), -1);
  let firstText = true;
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "image" && drawable(block)) return null;
        const text = block.type === "text" ? block.text : `[${tr("render.imageOutput")}]`;
        const node = (
          <OutputFrame key={index} output={text} heading={firstText ? heading : undefined}>
            <OutputPreview output={text} truncated={truncated && index === lastText} lang={lang} heading={firstText ? heading : undefined} />
          </OutputFrame>
        );
        firstText = false;
        return node;
      })}
    </>
  );
}

type ImageBlock = Extract<ToolOutputBlock, { type: "image" }>;
const drawable = (block: ImageBlock) => Boolean(block.data || block.path);

/** The pictures a tool call showed its agent, drawn under its line with the
    same card that draws an operator's attachment (#2075). They sit outside the
    line's disclosure, so they show while the line is closed: on the phone, in
    the dock's collapsed-tools mode, and before the operator opened anything.
    The inset lines them up with the summary text after the glyph. */
export function ToolImages({ event }: { event: ToolEvent }) {
  const images = (event.outputBlocks ?? []).filter((block): block is ImageBlock => block.type === "image" && drawable(block));
  if (!images.length) return null;
  return (
    <div data-tool-images className="flex min-w-0 max-w-full flex-wrap items-start gap-x-2 pl-[22px]">
      {images.map((image, index) => <ImageCard key={`${image.path ?? "inline"}:${index}`} {...image} at={index} inset />)}
    </div>
  );
}

/** A coalesced run of consecutive empty interactive polls rendered as one quiet
    counted row (issue #497). It keeps the shared
    session identity and the summed elapsed wall-time, so an operator still reads
    "how long the command was polled" without scrolling past every tick. */
export function PollRow({ events, session, elapsedMs }: { events: ToolEvent[]; session?: string; elapsedMs?: number }) {
  const count = events.length;
  const elapsed = typeof elapsedMs === "number" && elapsedMs > 0 ? formatDuration(elapsedMs) : "";
  const detail = [tr("tools.pollRun", { count }), session ? `→ ${session}` : "", elapsed].filter(Boolean).join(" · ");
  return (
    <div data-tool-row="poll" className="flex items-center gap-2 rounded-control py-0.5 text-ui text-muted/80">
      <span className="shrink-0 select-none text-muted" aria-hidden>↳</span>
      <GlyphIcon name="clock" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate tabular-nums text-caption">{detail}</span>
    </div>
  );
}

/** One tool call rendered as an always-open readable block inside an expanded
    aggregate group (issue #475). Unlike {@link ToolLine} it is not a `<details>`:
    the quiet header (ordinal, glyph, summary, non-ok status) and the full
    command/output body are both shown at once, so an operator sees every command
    and its owned output the moment the aggregate opens — no nested disclosure to
    click, matching Claude's live UPDATE cards. An error keeps its danger edge.
    `index` prefixes the ordinal; `nested` marks a wait/stdin follow-up rendered
    under its parent exec while keeping its own state. */
export function ToolBlockRow({ event, index, nested = false }: { event: ToolEvent; index?: number; nested?: boolean }) {
  const isErr = event.status === "err";
  const durationMs = toolDurationMs(event);
  const duration = durationMs === undefined ? "" : formatDuration(durationMs);
  return (
    <div className="min-w-0">
      <div
        data-tool-row={isErr ? "failed" : "done"}
        className={`flex items-center gap-2 rounded-control py-0.5 text-ui ${
          isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1" : nested ? "text-muted/90" : "text-muted"
        }`}
      >
        {index !== undefined ? (
          <span className="shrink-0 tabular-nums text-caption font-semibold text-muted">{index}.</span>
        ) : null}
        {nested ? <span className="shrink-0 select-none text-muted" aria-hidden>↳</span> : null}
        <GlyphIcon name={event.icon} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-secondary" title={event.summary}>
          {event.summary}
        </span>
        <RowStatusChip event={event} />
        {duration ? <span className="shrink-0 text-caption tabular-nums text-muted">{duration}</span> : null}
      </div>
      <ToolImages event={event} />
      <ToolBody event={event} />
    </div>
  );
}

/** One normalized tool event rendered as a quiet ToolLine (design doc §3.4):
    a borderless, tile-less single row — glyph + summary + (non-ok status) +
    duration + time — that reads as chrome between messages. The body mounts only after the
    first expand into a sunken readable block (issue #475), keeping a long
    transcript's collapsed DOM small (issue #9 §7/§8) — the same lazy contract
    holds when the line renders inside a cmd-group. An error is never quiet: it
    carries a danger left edge and danger text, always visible.

    On a coarse pointer the summary inflates to a 44px tap target (rule 8 /
    #145–#146) while the visual line stays dense on desktop; `showTime` is off
    for a grouped child, whose time range already lives in the group header.
    `index` prefixes an ordinal in a numbered group block; `nested` marks a
    wait/stdin follow-up rendered under its parent exec. */
export function ToolLine({
  event,
  showTime = true,
  className = "",
  index,
  nested = false,
  children,
}: {
  event: ToolEvent;
  showTime?: boolean;
  className?: string;
  index?: number;
  nested?: boolean;
  children?: ReactNode;
}) {
  const collapsed = useCollapsedTools();
  const [manualOpen, setManualOpen] = useState(false);
  const [mounted, setMounted] = useState(event.open);
  const isMobile = useIsMobile();
  /* Mobile v2 (#1439, lane 4; README §2.6): on the phone a tool line is one
     quiet closed line whatever the parser decided — an edit's diff (#90) or a
     failure's output opens by default only on the desktop. The operator's tap
     is what opens it, and the body is mounted only while it is open, so a
     phone transcript never carries a diff it did not ask for. */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const open = collapsed ? manualOpen : isMobile ? phoneOpen : event.open;
  const time = isMobile ? mobileClock(event.ts) : hhmm(event.ts);
  const durationMs = toolDurationMs(event);
  const duration = durationMs === undefined ? "" : formatDuration(durationMs);
  const isErr = event.status === "err";
  const running = event.status === "run";
  const pictured = hasImageBlock(event);
  const line = (
    <details
      className={`group/tool ${pictured ? "" : className}`}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (collapsed) setManualOpen(next);
        if (isMobile) setPhoneOpen(next);
        if (next) setMounted(true);
      }}
    >
      {/* Mobile v2 (#1439, lane 4): one quiet 44 px line, the running tool
          says so in words with its spinner first; the padding is its gap. */}
      <summary
        data-mobile-tool-line={isMobile ? (running ? "running" : isErr ? "failed" : "done") : undefined}
        data-tool-row={running ? "running" : isErr ? "failed" : "done"}
        className={`flex cursor-pointer list-none items-center gap-2 rounded-control py-0.5 text-ui hover:bg-sunken [@media(pointer:coarse)]:min-h-11 [&::-webkit-details-marker]:hidden ${isMobile ? "min-h-11 gap-1.5 " : ""}${
          isErr ? "border-l-2 border-danger bg-danger-soft pl-2 pr-1" : nested ? "text-muted/90" : "text-muted"
        }`}
      >
        {index !== undefined ? (
          <span className="shrink-0 tabular-nums text-caption font-semibold text-muted">{index}.</span>
        ) : null}
        {nested ? <span className="shrink-0 select-none text-muted" aria-hidden>↳</span> : null}
        {isMobile && running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <GlyphIcon name={event.icon} className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-secondary" title={event.summary}>
          {isMobile && running ? tr("mobile2.feed.running", { summary: event.summary }) : event.summary}
        </span>
        {/* On the phone a running line already said "running …" with its
            spinner, so the status chip (a second spinner, "executing…") stays
            off it; the duration is the trailing word. */}
        {isMobile && running ? null : <RowStatusChip event={event} />}
        {duration ? <span className="shrink-0 text-caption tabular-nums text-muted">{duration}</span> : null}
        {showTime && time ? <span className="shrink-0 text-caption tabular-nums text-muted">{time}</span> : null}
      </summary>
      {(collapsed ? manualOpen : isMobile ? phoneOpen : mounted) ? <><ToolBody event={event} />{children}</> : null}
    </details>
  );
  if (!pictured) return line;
  return (
    <div className={`min-w-0 ${className}`}>
      {line}
      <ToolImages event={event} />
    </div>
  );
}

/** A standalone tool event in the feed: a {@link ToolLine} at the feed's shared
    chrome indent (`ml-9`). On the phone there is no avatar column to line up
    with (mobile v2, #1439), so the line runs edge to edge. */
export function ToolCard({ event }: { event: ToolEvent }) {
  const isMobile = useIsMobile();
  if (isMobile && isPendingQuestionCall(event)) return null;
  return <ToolLine event={event} className={isMobile ? "" : "ml-9"} />;
}

/** One 36 px list item inside the phone's sunken run block (mobile v2, §4.2):
    glyph or spinner, the command clipped to one line, then exit · time ·
    duration in tabular caption type. A failure is the danger glyph and its exit
    code in the trailing meta, never a coloured wall: the label keeps the same
    quiet type as every other row, and what the tool said is one tap away in the
    block's readable body (#1938). Renders no control of its own: the block
    around it is the target. `min-h-9` rather than a fixed height, so no
    rendering of a row can paint outside its own box. */
export function MobileRunRow({ event }: { event: ToolEvent }) {
  const isErr = event.status === "err";
  const running = event.status === "run";
  const time = mobileClock(event.ts);
  const durationMs = toolDurationMs(event);
  const duration = durationMs === undefined ? "" : formatDuration(durationMs);
  const exit = exitLabel(event);
  const meta = [isErr ? exit : "", time, duration].filter(Boolean).join(" · ");
  return (
    <span
      data-mobile-run-row={running ? "running" : isErr ? "failed" : "done"}
      data-tool-row={running ? "running" : isErr ? "failed" : "done"}
      className="flex min-h-9 items-center gap-1.5 text-ui text-secondary"
    >
      {running ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : isErr ? (
        <StatusIcon status="err" className="h-3.5 w-3.5 shrink-0 text-danger" />
      ) : (
        <GlyphIcon name={event.icon} className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate" title={event.summary}>
        {running ? tr("mobile2.feed.running", { summary: event.summary }) : event.summary}
      </span>
      {meta ? <span className={`shrink-0 text-caption tabular-nums ${isErr ? "text-danger" : "text-muted"}`}>{meta}</span> : null}
    </span>
  );
}
