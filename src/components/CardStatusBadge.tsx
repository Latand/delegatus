"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import { BOARD_CLOCK_MS, useNowSeconds } from "@/hooks/useNowSeconds";

import { cardStatus, type CardStatus } from "./cardStatus";
import { TooltipBubble } from "./TooltipBubble";
import { humanizeDuration } from "./turnDuration";

/** Existing attention and delivery badges; running activity uses a compact dot. */
const TONE: Record<CardStatus["kind"], string> = {
  "needs-you": "card-status-attention border-warning/50 bg-warning-soft text-warning",
  held: "border-accent/45 bg-accent-soft text-accent",
  running: "border-success/45 bg-success-soft text-success",
  queued: "border-border bg-canvas text-muted",
};

/** The status word (uppercased by the badge) and its detail, per kind. */
export function cardStatusText(t: TFunction, status: CardStatus): { word: string; detail: string | null } {
  if (status.kind === "needs-you") return { word: t("cardStatus.needsYou"), detail: null };
  if (status.kind === "held") return { word: t("cardStatus.held"), detail: `×${status.count}` };
  if (status.kind === "running") {
    if (status.activity?.state === "checking") return { word: t("cardStatus.checking"), detail: status.activity.check };
    if (status.activity?.state === "idle") return { word: t("cardStatus.idle"), detail: t("cardStatus.idleMinutes", { n: Math.floor((status.activity.idleForMs ?? 0) / 60_000) }) };
    return {
      word: t("cardStatus.running"),
      detail: status.elapsedSeconds === null ? null : humanizeDuration(status.elapsedSeconds),
    };
  }
  return { word: t("cardStatus.queued"), detail: null };
}

/** Short operator text: no transcript identity or command arguments. */
export function activityDotText(t: TFunction, file: FileEntry, status: Extract<CardStatus, { kind: "running" }>, nowMs: number): string[] {
  const state = status.activity?.state ?? "working";
  const age = file.agentActivity?.lastRecordAt;
  const minutes = Math.floor((status.activity?.idleForMs ?? Math.max(0, nowMs - (age ?? nowMs))) / 60_000);
  if (state === "idle") {
    const last = age == null ? null : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(age);
    return [t("cardStatus.idle") + " " + t("cardStatus.idleMinutes", { n: minutes }), ...(last ? [t("cardStatus.lastAction", { time: last })] : [])];
  }
  if (state === "checking") {
    const check = status.activity?.check?.trim();
    // Background descriptions can contain arbitrary transcript text. Only a
    // short plain command name belongs in this two-line popover.
    const name = check && check.length <= 28 && /^[\p{L}\p{N} _.-]+$/u.test(check) && !/\d{5}|[a-f0-9]{8}/i.test(check) ? check : null;
    return [t("cardStatus.checking") + (nowMs > 0 ? " · " + t("cardStatus.idleMinutes", { n: minutes }) : ""), ...(name ? [name] : [])];
  }
  return [t("cardStatus.running")];
}

function ActivityDot({ file, status, nowMs }: { file: FileEntry; status: Extract<CardStatus, { kind: "running" }>; nowMs: number }) {
  const { t } = useLocale();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const open = hovered || focused || tapped;
  const state = status.activity?.state ?? "working";
  const lines = activityDotText(t, file, status, nowMs);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!anchorRef.current?.contains(event.target as Node)) { setTapped(false); setFocused(false); setHovered(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setTapped(false); setFocused(false); setHovered(false); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <>
    <span
      ref={anchorRef} role="button" tabIndex={0} aria-label={lines.join(" · ")} aria-expanded={open}
      data-card-status="running" data-agent-activity={state}
      style={{ width: 8, height: 8 }}
      className={`inline-block shrink-0 self-center relative pointer-events-auto rounded-full cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 before:absolute before:-inset-[12px] before:content-[''] ${state === "working" ? "bg-success" : state === "checking" ? "border-2 border-success bg-transparent" : "bg-danger"}`}
      onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setTapped(value => !value); setFocused(false); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setTapped(value => !value); setFocused(false); }
        if (event.key === "Escape") { setTapped(false); setFocused(false); setHovered(false); }
      }}
    />
    {open ? <TooltipBubble anchorRef={anchorRef} className="max-w-[calc(100vw-16px)] rounded-md border border-border bg-raised px-2 py-1 text-caption text-primary shadow-2">
      {lines.map((line, i) => <span key={i} className="block max-w-[220px] truncate leading-snug">{line}</span>)}
    </TooltipBubble> : null}
  </>;
}

export function CardStatusBadge({ file, fontClassName = "text-caption" }: {
  file: FileEntry;
  /** Overrides the caption-floor font for hosts that scale in em (far label). */
  fontClassName?: string;
}) {
  const { t } = useLocale();
  const nowMs = useNowSeconds(BOARD_CLOCK_MS) * 1000;
  const status = cardStatus(file, nowMs || undefined);
  if (!status) return null;
  if (status.kind === "running") return <ActivityDot file={file} status={status} nowMs={nowMs} />;
  const { word, detail } = cardStatusText(t, status);
  const label = detail ? `${word} ${detail}` : word;
  const tone = TONE[status.kind];
  return (
    <span
      data-card-status={status.kind}
      title={label}
      className={`inline-flex min-w-0 max-w-full overflow-hidden items-center gap-[0.35em] rounded-full border px-[0.6em] py-[0.15em] font-bold ${fontClassName} ${tone}`}
    >
      <span className="shrink-0 uppercase tracking-wide">{word}</span>
      {detail ? <span className="min-w-0 truncate tabular-nums opacity-90">{detail}</span> : null}
    </span>
  );
}
