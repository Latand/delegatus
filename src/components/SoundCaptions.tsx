"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  holdSoundCaptions,
  removeSoundCaption,
  soundCaptionsSnapshot,
  subscribeSoundCaptions,
  type CaptionTarget,
  type CaptionWhat,
  type CueCaption,
  type SoundCaptionItem,
} from "@/lib/audio/captions";
import type { EventSoundId } from "@/lib/audio/synth";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { PipelineStage } from "@/lib/pipelines/types";

import { stageDisplayName } from "./pipelines/pipelineModel";
import { placeStack, readObstacles, WIDE_WINDOW } from "./soundCaptionPlacement";
import { SOUND_CAPTION_CSS } from "./soundCaptionStyles";

/**
 * The stack of sound captions (docs/design/sound-captions.md §4–§5): a short
 * toast for each event sound that plays, on the right of the desktop view where
 * «Потрібні ви» shows. Fixed to the viewport at the toast layer, so an opened
 * task, a scroll or a view switch leaves it where it is. It stands on the first
 * place under the question toast that covers no line of text and no control
 * (`soundCaptionPlacement.ts`), folding its oldest toasts where none holds all.
 */

/** A caption's line 1 for one event, by what it announced. */
const LINE_KEY: Record<Exclude<CaptionWhat, "step" | "merged">, MessageKey> = {
  "lane-done": "soundCaption.laneDone",
  "merge-blocked": "soundCaption.mergeBlocked",
  decision: "soundCaption.decision",
  question: "soundCaption.question",
  plan: "soundCaption.plan",
  permission: "soundCaption.permission",
  "lane-decision": "soundCaption.laneDecision",
  prototype: "soundCaption.prototype",
  update: "soundCaption.update",
  attention: "soundCaption.attention",
  delivery: "soundCaption.delivery",
  launch: "soundCaption.launch",
  memory: "soundCaption.memory",
  released: "done.deploy.succeeded",
  "deploy-failed": "done.deploy.failed",
  "deploy-rolled-back": "done.deploy.rolledBack",
  limit: "soundCaption.limit",
  reply: "soundCaption.reply",
  launched: "soundCaption.launched",
};

/** What a request that carried no caption says: the most generic line of its sound's class. */
const GENERIC_KEY: Record<EventSoundId, MessageKey> = {
  step: "soundCaption.stepGeneric",
  landed: "soundCaption.laneDone",
  "your-move": "soundCaption.question",
  fault: "soundCaption.faultGeneric",
  reply: "soundCaption.reply",
  launched: "soundCaption.launched",
  released: "done.deploy.succeeded",
};

/** One play standing for several events says how many, for the four sounds that coalesce into a count. */
const BATCH_KEY: Partial<Record<EventSoundId, MessageKey>> = {
  step: "soundCaption.batch.step",
  landed: "soundCaption.batch.landed",
  "your-move": "soundCaption.batch.yourMove",
  fault: "soundCaption.batch.fault",
};

export interface CaptionText {
  /** Line 1, the whole sentence. */
  headline: string;
  /** The stage name inside the headline, set in the bubble's heavier weight. */
  emphasis: string | null;
  /** Line 2, who or what it is about; null when nothing names it. */
  subject: string | null;
  /** Where a click goes (the first caption's), when there is one. */
  target: CaptionTarget | null;
}

function lineOf(t: TFunction, caption: CueCaption): { headline: string; emphasis: string | null } {
  if (caption.what === "step") {
    if (!caption.stage) return { headline: t("soundCaption.stepGeneric"), emphasis: null };
    const stage = stageDisplayName(t, caption.stage as PipelineStage);
    return { headline: t("soundCaption.step", { stage }), emphasis: stage };
  }
  if (caption.what === "merged") {
    return { headline: caption.pr ? t("soundCaption.mergedPr", { pr: caption.pr }) : t("soundCaption.merged"), emphasis: null };
  }
  return { headline: t(LINE_KEY[caption.what]), emphasis: null };
}

/** The conversation a target names, through a needs-you entry's own follow-up. */
export function captionTargetConversation(target: CaptionTarget | null): { path?: string; conversationId?: string } | null {
  if (!target) return null;
  if (target.kind === "conversation") return target;
  if (target.kind === "needs-you") return captionTargetConversation(target.then);
  return null;
}

/** Everything one toast says, in the operator's language. Pure, so the tests read it without a DOM. */
export function captionText(t: TFunction, item: SoundCaptionItem, titleOf: (conversationId: string) => string | null): CaptionText {
  const first = item.captions[0] ?? null;
  const batchKey = item.n > 1 ? BATCH_KEY[item.sound] : undefined;
  const line = batchKey
    ? { headline: t(batchKey, { count: item.n }), emphasis: null }
    : first ? lineOf(t, first) : { headline: t(GENERIC_KEY[item.sound]), emphasis: null };
  const conversationId = captionTargetConversation(first?.target ?? null)?.conversationId;
  const own = first?.subject ?? (conversationId ? titleOf(conversationId) : null);
  const more = item.n > 1 && own ? t("done.group.more", { count: item.n - 1 }) : null;
  return { ...line, subject: own && more ? `${own} · ${more}` : own, target: first?.target ?? null };
}

/** How long a removed toast fades out before it leaves the layout, ms. */
const LEAVE_MS = 140;
/** The column's first line: 8 px under the bar row's 48 px. */
const DEFAULT_TOP = 56;
const GAP = 8;
const EMPTY: readonly SoundCaptionItem[] = [];

/**
 * Where the column starts: 8 px under the lowest of the island, the question
 * toast and an open agent window's header that is on screen, never above the
 * bar row. The toasts therefore never cover the controls they sit beside.
 */
function measureTop(): number {
  let bottom = DEFAULT_TOP - GAP;
  for (const selector of ["[data-attention-island]", "[data-attention-toast]", ".kb .agent-window .aw-head"]) {
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) bottom = Math.max(bottom, rect.bottom);
    }
  }
  return Math.ceil(bottom + GAP);
}

export interface SoundCaptionsProps {
  /** A phone-class window: nothing mounts, so the phone gets no element and no listener. */
  mobile: boolean;
  /** The column's right edge, px from the viewport: the question toast's own. */
  right: number;
  /** The floating needs-you panel hangs in the same spot: draw nothing, the countdown runs on. */
  hidden: boolean;
  /** A conversation the question toast already shows: its caption would say the same twice. */
  suppressPath: string | null;
  /** A conversation's title, for a caption that names it only by id. */
  titleOf(conversationId: string): string | null;
  onOpen(target: CaptionTarget): void;
}

export function SoundCaptions({ mobile, ...props }: SoundCaptionsProps) {
  return mobile ? null : <SoundCaptionStack {...props} />;
}

function SoundCaptionStack({ right, hidden, suppressPath, titleOf, onOpen }: Omit<SoundCaptionsProps, "mobile">) {
  const { t } = useLocale();
  const items = useSyncExternalStore(subscribeSoundCaptions, soundCaptionsSnapshot, () => EMPTY);
  const shown = hidden ? EMPTY : items.filter((item) => {
    const path = captionTargetConversation(item.captions[0]?.target ?? null)?.path;
    return !(suppressPath && path === suppressPath);
  });

  /* A toast that left fades for 140 ms where it stood, so the rest do not jump. */
  const [leaving, setLeaving] = useState<readonly SoundCaptionItem[]>(EMPTY);
  const previous = useRef<readonly SoundCaptionItem[]>(EMPTY);
  useEffect(() => {
    const gone = hidden ? [] : previous.current.filter((item) => !shown.includes(item));
    previous.current = shown;
    if (!gone.length) return;
    setLeaving((current) => [...current, ...gone]);
    /* Not cancelled by the next render: that render is the one this removal causes. */
    window.setTimeout(() => setLeaving((current) => current.filter((item) => !gone.includes(item))), LEAVE_MS);
    /* Every render: `shown` is rebuilt each time and `previous` is the diff base. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /*
   * Where the column stands: the first free place from the bottom of the question toast down. Reading the page's
   * text is the costly part, so it runs when the toasts, their sizes, the window or the first line change, and
   * never while a held stack sits still under a feed that scrolls.
   */
  const [place, setPlace] = useState({ top: DEFAULT_TOP, fold: 0, free: true });
  const live = shown.length > 0;
  const column = useRef<HTMLDivElement | null>(null);
  const placedFor = useRef("");
  const settle = useCallback(() => {
    const element = column.current;
    if (!element) return;
    const minTop = measureTop();
    const sizes = shown.map((item) => {
      const toast = element.querySelector<HTMLElement>(`[data-caption-id="${item.id}"]`);
      return { width: toast?.offsetWidth ?? 0, height: toast?.offsetHeight ?? 0 };
    });
    const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
    const key = JSON.stringify([shown.map((item) => item.id), sizes, right, viewport, minTop]);
    if (key === placedFor.current) return;
    placedFor.current = key;
    const next = placeStack({ viewport, right, minTop, toasts: sizes, obstacles: readObstacles(element, right), keep: viewport.width >= WIDE_WINDOW ? 2 : 1 });
    setPlace((current) => (current.top === next.top && current.fold === next.fold && current.free === next.free ? current : next));
  }, [shown, right]);
  const settleRef = useRef(settle);
  useLayoutEffect(() => {
    settleRef.current = settle;
    if (live) settle();
    else placedFor.current = "";
  });
  useEffect(() => {
    if (!live) return;
    /* The question toast and an agent window arrive on their own clock. */
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        settleRef.current();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [live]);

  /*
   * A toast removed while it holds the focus (clicked away, or evicted by a
   * fifth push) is taken out during the commit, where React dispatches no
   * blur: release the focus hold whenever the column no longer holds the
   * focus. Releasing an unset hold is a no-op.
   */
  useLayoutEffect(() => {
    if (!column.current?.contains(document.activeElement)) holdSoundCaptions(false, "focus");
  });

  /*
   * The same for the pointer: a toast removed under it sends no pointerout, so
   * React never sees the pointer leave the column. Any move that lands outside
   * the column releases the pointer hold.
   */
  useEffect(() => {
    if (!live) return;
    const onMove = (event: PointerEvent) => {
      if (!column.current?.contains(event.target as Node | null)) holdSoundCaptions(false, "pointer");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [live]);

  /* A toast removed under the pointer or the focus cannot report leaving. */
  useEffect(() => {
    if (live) return;
    holdSoundCaptions(false, "pointer");
    holdSoundCaptions(false, "focus");
  }, [live]);
  useEffect(() => () => {
    holdSoundCaptions(false, "pointer");
    holdSoundCaptions(false, "focus");
  }, []);

  if (hidden || (!live && !leaving.length)) return null;
  /* The oldest `fold` toasts stay in the DOM, out of the column, so their sizes can be read and they leave on their own clock. */
  const folded = new Set(shown.slice(0, Math.min(place.fold, shown.length - 1)).map((item) => item.id));
  const rows = [...shown.map((item) => ({ item, leaving: false })), ...leaving.filter((item) => !shown.includes(item)).map((item) => ({ item, leaving: true }))]
    .sort((a, b) => a.item.id - b.item.id);

  return (
    <>
      <style>{SOUND_CAPTION_CSS}</style>
      <div
        ref={column}
        className="sc-column"
        data-sound-captions=""
        data-placement={place.free ? "free" : "covers"}
        aria-live="polite"
        style={{ top: place.top, right }}
        onPointerEnter={() => holdSoundCaptions(true, "pointer")}
        onPointerLeave={() => holdSoundCaptions(false, "pointer")}
        onFocus={() => holdSoundCaptions(true, "focus")}
        onBlur={() => holdSoundCaptions(false, "focus")}
      >
        {rows.map(({ item, leaving: gone }) => {
          const text = captionText(t, item, titleOf);
          const body = (
            <>
              <span className="sc-line">
                {text.emphasis && text.headline.includes(text.emphasis) ? (
                  <>
                    {text.headline.slice(0, text.headline.indexOf(text.emphasis))}
                    <span className="sc-who">{text.emphasis}</span>
                    {text.headline.slice(text.headline.indexOf(text.emphasis) + text.emphasis.length)}
                  </>
                ) : text.headline}
              </span>
              {text.subject ? <span className="sc-subject" title={text.subject}>{text.subject}</span> : null}
            </>
          );
          const common = { className: "sc-toast", "data-sound-caption": item.sound, "data-caption-what": item.captions[0]?.what ?? "generic", "data-caption-id": item.id, ...(gone ? { "data-leaving": "" } : {}), ...(folded.has(item.id) ? { "data-folded": "" } : {}) };
          if (!text.target || gone) return <div key={item.id} {...common} aria-hidden={gone || undefined}>{body}</div>;
          const target = text.target;
          return (
            <button
              key={item.id}
              type="button"
              {...common}
              aria-label={t("soundCaption.openAria", { label: [text.headline, text.subject].filter(Boolean).join(" · ") })}
              onClick={() => {
                onOpen(target);
                removeSoundCaption(item.id);
              }}
            >
              {body}
            </button>
          );
        })}
      </div>
    </>
  );
}
