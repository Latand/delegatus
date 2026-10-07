"use client";

import { Hourglass } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";

import { SeatTickDot } from "./SeatTickBody";
import {
  SEAT_TICK_DRAG_SPRING,
  SEAT_TICK_DRAG_THRESHOLD,
  SEAT_TICK_END_GIVE,
  SEAT_TICK_FLICK_WINDOW_MS,
  SEAT_TICK_KEY_COMMIT_MS,
  SEAT_TICK_LAST_STOP,
  SEAT_TICK_SETTLE_SPRING,
  seatTickColour,
  seatTickPlace,
  seatTickReleaseStop,
  seatTickShortWord,
  seatTickSpringStep,
  seatTickStep,
  seatTickStopChange,
  seatTickStopValue,
  seatTickStopWord,
  type SeatTickMotion,
} from "./seatTickStops";
import { seatTickLocalTime, type SeatTickReading } from "./seatTickView";
import type { SeatTickSettingsRead } from "./useSeatTickSettings";

/*
 * The seat tick as a switch with four stops (docs/design/seat-tick-slider.md,
 * variant 4 «Перемикач»): off, every 4 h, the default hour, every 10 min. The
 * thumb carries the schedule's word and slides along a pill that tints with
 * the activity colour; the health dot sits outside the pill and keeps its own
 * meaning.
 *
 * One control, two actions. A press that moves is a drag: the thumb follows
 * the pointer and the release writes the nearest stop through the settings
 * route. A press that does not move is a click, and opens the same settings
 * the chip opened. The whole control is the handle, so the drag is relative to
 * where it was pressed.
 *
 * The thumb's place is drawn from two custom properties this component writes
 * on its own root, frame by frame, from a spring: `--tick-pos` (in stops) and
 * `--tick` (the colour there). They are not in the rendered style, so a
 * re-render never snaps a thumb that is still travelling.
 */

/** The thumb's travel between the first stop and the last, and the thumb's
    width for a word of up to six characters. Fixed, so a step is the same
    number of pixels whatever the word is. */
const GEOMETRY = {
  desktop: { travel: 60, thumb: 46, inset: 2, perChar: 6 },
  mobile: { travel: 60, thumb: 56, inset: 3, perChar: 7 },
} as const;

/** The travel as drawn: a host that gave up the word also shortens the pill
    (`globals.css`), and the drag follows the pill that is on screen. */
function travelOf(root: HTMLElement, fallback: number): number {
  const drawn = Number.parseFloat(window.getComputedStyle(root).getPropertyValue("--tick-travel"));
  return Number.isFinite(drawn) && drawn > 0 ? drawn : fallback;
}

const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Gesture {
  id: number;
  startX: number;
  /** Pixels per stop while this press lasts. */
  stepPx: number;
  from: number;
  dragging: boolean;
  position: number;
  samples: Array<{ x: number; at: number }>;
}

/** Drives `--tick-pos` and `--tick` toward `target`. While `held` the spring
    is the light one that trails the pointer; otherwise the one that settles. */
function useThumbMotion(rootRef: RefObject<HTMLElement | null>, target: number, held: boolean): void {
  const motion = useRef<SeatTickMotion | null>(null);
  const frame = useRef<number | null>(null);
  const aim = useRef({ target, held });

  const paint = useCallback(() => {
    const root = rootRef.current;
    if (!root || !motion.current) return;
    root.style.setProperty("--tick-pos", Math.min(SEAT_TICK_LAST_STOP + SEAT_TICK_END_GIVE, Math.max(-SEAT_TICK_END_GIVE, motion.current.x)).toFixed(4));
    root.style.setProperty("--tick", seatTickColour(motion.current.x));
  }, [rootRef]);

  useLayoutEffect(() => {
    aim.current = { target, held };
    /* The first reading, and every reading for someone who asked for less
       motion, is drawn where it is: no travel, no spring. */
    if (!motion.current || reducedMotion() || typeof window.requestAnimationFrame !== "function") {
      motion.current = { x: target, v: 0 };
      paint();
      return;
    }
    if (frame.current !== null) return;
    let last = performance.now();
    const tick = (now: number) => {
      const current = motion.current!;
      const next = seatTickSpringStep(current, aim.current.target, aim.current.held ? SEAT_TICK_DRAG_SPRING : SEAT_TICK_SETTLE_SPRING, (now - last) / 1000);
      last = now;
      motion.current = next;
      paint();
      frame.current = next.v === 0 && next.x === aim.current.target ? null : window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
  }, [target, held, paint]);

  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
}

export function SeatTickSwitch({ read, reading, now, surface, open, onOpen, onRefused, anchorRef, className = "" }: {
  read: SeatTickSettingsRead;
  reading: SeatTickReading;
  /** The instant `reading` was taken at, for the expiry's wall-clock time. */
  now: number;
  surface: "desktop" | "mobile";
  /** The settings this control opens are showing. */
  open: boolean;
  /** A press that did not move, or Enter with no step pending. */
  onOpen: () => void;
  /** A move the route refused: the settings are where its reason is shown. */
  onRefused?: () => void;
  anchorRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const { t, locale } = useLocale();
  const ownRef = useRef<HTMLDivElement>(null);
  const rootRef = anchorRef ?? ownRef;
  const answer = read.answer;
  const place = answer ? seatTickPlace(answer) : null;
  const defaultMinutes = answer?.defaultWakeIntervalMinutes ?? 60;
  const geometry = GEOMETRY[surface];

  const gesture = useRef<Gesture | null>(null);
  /* A drag's release is followed by a click on the same element; that click
     is the drag's, not a request for the settings. */
  const swallowClick = useRef(false);
  const [dragAt, setDragAt] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /* A move released while a write is in flight waits for it, and only the
     latest one is kept: once the write settles it is measured against the
     record that came back, so a move back to where that write landed sends
     nothing. `waiting` is that move, drawn where it was released. */
  const queued = useRef<number | null>(null);
  const writing = useRef(false);
  const [waiting, setWaiting] = useState<number | null>(null);
  const latest = useRef({ read, onRefused, locale });
  useLayoutEffect(() => {
    latest.current = { read, onRefused, locale };
  });

  const drain = async () => {
    writing.current = true;
    try {
      while (queued.current !== null) {
        const { read: settings, locale: language } = latest.current;
        const held = await settings.saveAfter((record) => {
          const stop = queued.current;
          queued.current = null;
          setWaiting(null);
          /* The stop already set is not a move, so it writes nothing, an expiry included. */
          if (stop === null || stop === seatTickPlace(record).stop) return null;
          return seatTickStopChange(stop, record.settings.reason, language === "uk" ? "uk" : "en");
        });
        /* Only the route refuses here; its reason is in the settings, and a
           move made behind the refused one is not sent over it. */
        if (held === false) {
          queued.current = null;
          setWaiting(null);
          latest.current.onRefused?.();
          return;
        }
      }
    } finally {
      writing.current = false;
    }
  };

  const commit = (stop: number) => {
    if (!answer || !place) return;
    queued.current = stop;
    setWaiting(stop);
    if (!writing.current) void drain();
  };

  const dropPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (event.button !== 0 || !place) return;
    dropPending();
    const stepPx = travelOf(event.currentTarget, geometry.travel) / SEAT_TICK_LAST_STOP;
    const from = waiting ?? place.position;
    gesture.current = { id: event.pointerId, startX: event.clientX, stepPx, from, dragging: false, position: from, samples: [] };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* A pointer that is already gone cannot be captured; the gesture ends on its own. */
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = gesture.current;
    if (!held || held.id !== event.pointerId) return;
    const dx = event.clientX - held.startX;
    if (!held.dragging && Math.abs(dx) <= (event.pointerType === "mouse" ? SEAT_TICK_DRAG_THRESHOLD.mouse : SEAT_TICK_DRAG_THRESHOLD.touch)) return;
    held.dragging = true;
    const at = event.timeStamp;
    held.samples.push({ x: event.clientX, at });
    while (held.samples.length > 2 && at - held.samples[0]!.at > SEAT_TICK_FLICK_WINDOW_MS) held.samples.shift();
    held.position = Math.min(SEAT_TICK_LAST_STOP, Math.max(0, held.from + dx / held.stepPx));
    setDragAt(held.position);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const held = gesture.current;
    if (!held || held.id !== event.pointerId) return;
    gesture.current = null;
    setDragAt(null);
    if (!held.dragging) return;
    swallowClick.current = true;
    if (cancelled) return;
    const recent = held.samples.filter((sample) => event.timeStamp - sample.at <= SEAT_TICK_FLICK_WINDOW_MS);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const speed = first && last && last !== first ? (last.x - first.x) / Math.max(1, last.at - first.at) : 0;
    commit(seatTickReleaseStop(held.position, speed, held.stepPx));
  };

  const onClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    onOpen();
  };

  const step = (stop: number) => {
    if (!place) return;
    if (timer.current) clearTimeout(timer.current);
    setPending(stop);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPending(null);
      commit(stop);
    }, SEAT_TICK_KEY_COMMIT_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = pending ?? waiting ?? place?.position ?? null;
    if (event.key === "Escape") {
      const dragging = gesture.current?.dragging ?? false;
      if (dragging || pending !== null) {
        /* Ours to answer: it puts the thumb back and writes nothing, and must
           not also close a sheet the control sits in. */
        event.preventDefault();
        event.stopPropagation();
        swallowClick.current = dragging;
        gesture.current = null;
        setDragAt(null);
        dropPending();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (pending === null) return onOpen();
      dropPending();
      return commit(pending);
    }
    if (from === null) return;
    const to = event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? seatTickStep(from, 1)
      : event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? seatTickStep(from, -1)
        : event.key === "Home" ? 0
          : event.key === "End" ? SEAT_TICK_LAST_STOP
            : null;
    if (to === null) return;
    event.preventDefault();
    step(to);
  };

  /* What is shown: the stop a drag or an arrow is heading for, else the record. */
  const preview = dragAt !== null ? Math.round(dragAt) : pending ?? waiting;
  const target = dragAt ?? pending ?? waiting ?? place?.position ?? 2;
  useThumbMotion(rootRef, target, dragAt !== null);

  const until = preview === null && answer?.effective.until ? seatTickLocalTime(answer.effective.until, now, locale) : null;
  const preset = preview !== null || !place || place.stop !== null;
  const off = preview !== null ? preview === 0 : answer ? !answer.effective.enabled : false;
  const word = preview !== null
    ? seatTickStopWord(preview, defaultMinutes, t)
    : !answer || !place ? reading.chip
      : place.stop !== null ? seatTickStopWord(place.stop, defaultMinutes, t)
        : seatTickShortWord(answer.effective.wakeIntervalMinutes, t);

  const value = preview !== null
    ? seatTickStopValue(preview, defaultMinutes, t)
    : !answer || !place ? reading.summary
      : place.stop !== null ? seatTickStopValue(place.stop, defaultMinutes, t)
        : t("seatTick.switch.value.custom", { interval: seatTickShortWord(answer.effective.wakeIntervalMinutes, t) });
  const valueText = preview !== null || !answer
    ? value
    : t("seatTick.switch.valueText", { value: until ? t("seatTick.switch.value.until", { value, time: until }) : value, summary: reading.summary });

  const phone = surface === "mobile";
  const thumb = geometry.thumb + Math.max(0, word.length - 6) * geometry.perChar;
  const dragging = dragAt !== null;
  return (
    <div
      ref={rootRef}
      role="slider"
      tabIndex={0}
      aria-label={t("seatTick.switch.aria")}
      aria-valuemin={0}
      aria-valuemax={SEAT_TICK_LAST_STOP}
      aria-valuenow={Math.round(target * 100) / 100}
      aria-valuetext={valueText}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={read.saving || undefined}
      title={`${reading.line}\n${t("seatTick.switch.hint")}`}
      data-seat-tick-chip={reading.state}
      data-seat-tick-switch={dragging ? "dragging" : pending !== null ? "pending" : waiting !== null ? "queued" : "rest"}
      data-seat-tick-surface={surface}
      data-seat-tick-stop={place ? place.stop ?? "custom" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{ "--tick-thumb": `${thumb}px`, "--tick-inset": `${geometry.inset}px`, "--tick-travel": `${geometry.travel}px`, touchAction: "pan-y" } as CSSProperties}
      className={`seat-tick-switch group/tick inline-flex shrink-0 select-none items-center outline-none gap-1.5 ${dragging ? "cursor-grabbing" : "cursor-grab"} ${className}`}
    >
      <span
        data-seat-tick-track
        className={`seat-tick-track relative inline-block shrink-0 rounded-full border border-border transition-colors group-hover/tick:border-[color-mix(in_oklch,var(--tick)_55%,transparent)] group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-accent/40 ${phone ? "h-9" : "h-6"}`}
      >
        {[0, 1, 2, 3].map((stop) => (
          <span
            key={stop}
            aria-hidden
            className="seat-tick-notch absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-strong"
            style={{ "--tick-notch": stop } as CSSProperties}
          />
        ))}
        <span
          data-seat-tick-thumb={preset ? "preset" : "custom"}
          className={`seat-tick-thumb absolute inline-flex items-center justify-center rounded-full border bg-card font-semibold shadow-1 ${phone ? "top-[3px] h-7 text-ui" : "top-[2px] h-[18px] text-caption"}`}
          style={{
            borderColor: off ? "var(--border-strong)" : preset ? "var(--tick)" : "transparent",
            outlineStyle: preset ? undefined : "dashed",
            outlineWidth: preset ? undefined : "1.5px",
            outlineColor: preset ? undefined : "var(--tick)",
            outlineOffset: preset ? undefined : "-1.5px",
            color: off ? "var(--color-muted)" : "color-mix(in oklch, var(--tick) 60%, var(--color-primary))",
            boxShadow: dragging ? "0 0 0 4px color-mix(in oklch, var(--tick) 22%, transparent)" : undefined,
          }}
        >
          <span data-seat-tick-face className="whitespace-nowrap tabular-nums">{word}</span>
        </span>
      </span>
      {until ? <Hourglass data-seat-tick-until aria-hidden className={`${phone ? "h-3.5 w-3.5" : "h-3 w-3"} shrink-0 text-secondary`} /> : null}
      <SeatTickDot tone={reading.tone} />
    </div>
  );
}
