"use client";

import { Columns2, CornerDownRight, Film, GalleryHorizontalEnd, ImageOff, Loader2, RotateCw, SquareSplitHorizontal, TriangleAlert, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { Check, ChevronLeft, ChevronRight, CircleCheck, X } from "@/components/icons";
import { Z } from "@/components/layers";
import { MicButtonView } from "@/components/MicButton";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useModalLayer } from "@/components/modalLayer";
import { useDictation } from "@/hooks/useDictation";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { usePrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { PrototypeDeliveryState, PrototypeMediaView, PrototypeRoundView } from "@/lib/prototypeReview/types";

import { markPrototypeReviewSeen } from "./prototypeReviewStore";

type Variant = PrototypeRoundView["variants"][number];
type Frame = Variant["frames"][number];
type PairMode = "side" | "slider";

/** One thing the stage shows: a picture, an original with its change, or a video. */
interface Slide {
  key: string;
  variant: Variant;
  /** Its place among its variant's slides, from 0. */
  at: number;
  of: number;
  caption: string;
  frame?: Frame;
  video?: PrototypeMediaView;
}

interface Draft { chosen: number[]; comment: string }
const EMPTY_DRAFT: Draft = { chosen: [], comment: "" };

/** A moment as the product writes one: day, month and a 24-hour clock, no seconds. */
const when = (at: string, locale: string) => new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
/** A day as the product writes one: day, month name and year. A closing abbreviation point is dropped so a sentence ending on the date keeps one point, not two. */
const whenDate = (at: string, locale: string) => new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(at)).replace(/\.$/, "");

const variantLabel = (variant: Variant) => `${variant.number} · ${variant.name}`;
const slideLabel = (slide: Slide) => (slide.caption ? `${variantLabel(slide.variant)} — ${slide.caption}` : variantLabel(slide.variant));

function slidesOf(round: PrototypeRoundView): Slide[] {
  return round.variants.flatMap((variant) => {
    const of = variant.frames.length + variant.videos.length;
    return [
      ...variant.frames.map((frame, at): Slide => ({ key: `${variant.number}:f${at}`, variant, at, of, caption: frame.caption, frame })),
      ...variant.videos.map((video, at): Slide => ({ key: `${variant.number}:v${at}`, variant, at: variant.frames.length + at, of, caption: video.caption, video: video.media })),
    ];
  });
}

const shown = (media: PrototypeMediaView | undefined, broken: ReadonlySet<string>): media is PrototypeMediaView & { url: string } =>
  Boolean(media?.available && media.url && !broken.has(media.id));

/** The pictures the full-screen viewer steps through: the frames of one
    variant, in the order the review draws them, counted as the review counts
    them. A pair is one picture whose original the viewer swaps in place. */
function galleryOf(t: TFunction, round: PrototypeRoundView, slides: readonly Slide[], broken: ReadonlySet<string>): GalleryImage[] {
  return slides.flatMap((slide): GalleryImage[] => {
    if (!slide.frame) return [];
    const label = slideLabel(slide);
    const named = (side?: "original" | "changed") => (side ? `${label} · ${t(`proto.pair.${side}`)}` : label);
    const { image, original } = slide.frame;
    const place = `${slide.at + 1} / ${slide.of}`;
    const changed = shown(image, broken);
    const before = shown(original, broken);
    if (changed && before) return [{ src: image.url, alt: named("changed"), caption: named("changed"), detail: round.title, place, before: { src: original.url, alt: named("original"), caption: named("original") } }];
    if (changed) return [{ src: image.url, alt: named(original ? "changed" : undefined), caption: named(original ? "changed" : undefined), detail: round.title, place }];
    if (before) return [{ src: original.url, alt: named("original"), caption: named("original"), detail: round.title, place }];
    return [];
  });
}

const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(element.tagName) || element.isContentEditable));
};

const TOOL = "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-control border border-border bg-canvas px-1.5 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 aria-pressed:border-accent/50 aria-pressed:bg-accent-soft aria-pressed:text-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11";
const SECONDARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 [@media(pointer:coarse)]:h-11";
const PRIMARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3.5 text-ui font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-45 [@media(pointer:coarse)]:h-11";

/** The desktop dialog's place in the modal stack: Tab stays inside and focus
    returns to the button that opened it. Unmounted while the full-screen
    viewer is up, which is drawn outside the dialog and owns the keys then. */
function DialogLayer({ containerRef, onClose }: { containerRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  useModalLayer({ containerRef, onClose });
  return null;
}

interface PairPicture { url: string; alt: string; onError: () => void }

/** An original over its change, cut by a slider. The frame, the two names and
    the slider's track are as wide as the changed picture is drawn, so the
    track's ends are the picture's edges: at one end the original covers the
    whole change, at the other none of it. A press on the frame opens it full
    screen. On the phone (`fill`) the frame takes the stage's whole width and
    its own height, and the names and the track keep the sheet's inset. */
function SliderPair({ original, changed, labels, tagClass, split, onSplit, onOpen, fill = false }: {
  original: PairPicture;
  changed: PairPicture;
  labels: { original: string; changed: string; slider: string; open: string };
  tagClass: string;
  split: number;
  onSplit: (value: number) => void;
  onOpen: () => void;
  fill?: boolean;
}) {
  const room = useRef<HTMLDivElement>(null);
  const names = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState<{ width: number; height: number } | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = room.current;
    if (!element) return;
    /* The picture gets what the stage leaves after the names, the track and the two gaps between them. */
    const measure = () => setSpace({
      width: element.clientWidth,
      height: Math.max(0, element.clientHeight - (names.current?.offsetHeight ?? 0) - (track.current?.offsetHeight ?? 0) - 12),
    });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const scale = space && natural ? (fill ? space.width / natural.width : Math.min(space.width / natural.width, space.height / natural.height)) : 0;
  const size = space && natural ? { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) } : space && fill ? { width: space.width, height: 0 } : space;
  const inset = fill ? "px-4" : "";
  return (
    <div data-prototype-pair="slider" className={fill ? "py-2" : "absolute inset-0 p-3"}>
      <div ref={room} className={`flex w-full flex-col items-center ${fill ? "" : "h-full justify-center"}`}>
        <div ref={names} className={`flex shrink-0 items-center justify-between gap-2 ${inset}`} style={{ width: size?.width }}>
          <span data-prototype-pair-label="original" className={tagClass}>{labels.original}</span>
          <span data-prototype-pair-label="changed" className={tagClass}>{labels.changed}</span>
        </div>
        <button type="button" data-prototype-pair-frame="" aria-label={labels.open} className="relative mt-1 block shrink-0 cursor-zoom-in overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" style={size ? { width: size.width, height: size.height } : undefined} onClick={onOpen}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a fenced local copy */}
          <img src={changed.url} alt={changed.alt} draggable={false} className="absolute inset-0 h-full w-full object-contain" onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={changed.onError} />
          {/* eslint-disable-next-line @next/next/no-img-element -- a fenced local copy */}
          <img src={original.url} alt={original.alt} draggable={false} className="absolute inset-0 h-full w-full bg-sunken object-contain" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} onError={original.onError} />
          <span aria-hidden className="absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-accent" style={{ left: `${split}%` }} />
        </button>
        <div ref={track} className={`mt-2 shrink-0 ${inset}`} style={{ width: size?.width }}>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            data-prototype-split=""
            aria-label={labels.slider}
            className="block h-6 w-full accent-[var(--color-accent)] [@media(pointer:coarse)]:h-11"
            onChange={(event) => onSplit(Number(event.target.value))}
          />
        </div>
      </div>
    </div>
  );
}

export interface PrototypeReviewProps {
  taskId: string;
  /** The round asked for; the waiting one, then the newest, when it is gone. */
  reviewId: string | null;
  taskTitle: string;
  onClose: () => void;
}

/**
 * A task's prototype review: its variants with their pictures, pairs and
 * videos, the choice of one or several, the comment with the composer's
 * microphone, and the saved decision of this round and the earlier ones. A
 * dialog over the board on the desktop, a sheet on the phone.
 */
export function PrototypeReview({ taskId, reviewId, taskTitle, onClose }: PrototypeReviewProps) {
  const { t, locale } = useLocale();
  const phone = useIsMobile();
  const review = usePrototypeReview(taskId, true);
  const { data } = review;
  const [picked, setPicked] = useState<string | null>(null);
  const [active, setActive] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pairMode, setPairMode] = useState<PairMode | null>(null);
  const [split, setSplit] = useState(50);
  /* The picture opened full screen, the press's own side of a pair, and the variant's pictures the viewer steps through. */
  const [viewer, setViewer] = useState<{ src: string; image: GalleryImage; gallery: GalleryImage[] } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [guard, setGuard] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  /* Superseded rounds the operator chose to decide anyway. */
  const [reopened, setReopened] = useState<ReadonlySet<string>>(() => new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const strip = useRef<HTMLDivElement>(null);

  const rounds = data?.rounds ?? [];
  const round = rounds.find((entry) => entry.id === picked)
    ?? rounds.find((entry) => entry.id === reviewId)
    ?? rounds.find((entry) => entry.id === data?.waitingReviewId)
    ?? rounds.at(-1)
    ?? null;
  const roundId = round?.id ?? null;
  const slides = useMemo(() => (round ? slidesOf(round) : []), [round]);
  /* A decided round opens on what was chosen: its first chosen variant. */
  const opening = round?.decision ? Math.max(0, slides.findIndex((entry) => round.decision!.chosen.includes(entry.variant.number))) : 0;
  const index = Math.min(roundId ? active[roundId] ?? opening : 0, Math.max(0, slides.length - 1));
  const slide = slides[index] ?? null;
  const variant = slide?.variant ?? round?.variants[0] ?? null;
  const elsewhere = data?.unavailable === "another-installation";
  /* The later decided round that retired this one: the operator already answered there. */
  const successor = round && !round.decision && round.supersededBy ? rounds.find((entry) => entry.id === round.supersededBy) ?? null : null;
  const open = Boolean(round && !round.decision && !elsewhere && (!successor || reopened.has(round.id)));
  const draft = (roundId && drafts[roundId]) || EMPTY_DRAFT;
  /* Two pictures side by side are each half a phone wide, too small to read: the phone compares on one frame. */
  const mode: PairMode = phone ? "slider" : pairMode ?? "side";

  useEffect(() => {
    if (round && !round.decision) markPrototypeReviewSeen(round.id);
  }, [round]);

  const setDraft = useCallback((change: (held: Draft) => Draft, target: string | null = roundId) => {
    if (!target) return;
    setDrafts((held) => ({ ...held, [target]: change(held[target] ?? EMPTY_DRAFT) }));
  }, [roundId]);
  const toggle = useCallback((number: number) => {
    setDraft((held) => ({ ...held, chosen: held.chosen.includes(number) ? held.chosen.filter((own) => own !== number) : [...held.chosen, number].sort((a, b) => a - b) }));
  }, [setDraft]);
  const show = useCallback((next: number) => {
    if (!roundId || next < 0 || next >= slides.length) return;
    setActive((held) => ({ ...held, [roundId]: next }));
  }, [roundId, slides.length]);

  /* The composer's dictation, as the composer wires it: a spoken segment is
     appended to what is typed, and the transcript in flight overlays the
     field until it lands. Speech belongs to the round it was started in: the
     press on the microphone pins that round on the stage, and every word that
     comes back, live or after the recording, is written into its comment. */
  const speechRound = useRef<string | null>(null);
  const insertSpoken = useCallback((spoken: string) => {
    setDraft((held) => ({ ...held, comment: held.comment ? `${held.comment.trimEnd()} ${spoken}` : spoken }), speechRound.current ?? roundId);
    setVoiceError(null);
    requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
      element.scrollTop = element.scrollHeight;
    });
  }, [setDraft, roundId]);
  const dictation = useDictation({ onError: setVoiceError, onUnclaimedText: insertSpoken, onLiveCommit: insertSpoken });
  const startSpeech = dictation.start;
  const startDictation = useCallback(() => {
    speechRound.current = roundId;
    if (roundId) setPicked(roundId);
    return startSpeech();
  }, [roundId, startSpeech]);
  const recording = dictation.phase === "rec";
  /* From the press to the last word landing, no other round can be opened. */
  const speaking = dictation.phase !== "idle" || Boolean(dictation.liveText);
  const comment = dictation.liveText ? (draft.comment ? `${draft.comment.trimEnd()} ` : "") + dictation.liveText : draft.comment;

  /* Closing with a comment that was never saved asks first. Speech counts from
     the tap on the microphone to the last word landing in the field: while it
     is transcribed the field may be empty, and closing then would unmount the
     review before the answer has anywhere to go. */
  const unsaved = rounds.some((entry) => !entry.decision && (drafts[entry.id]?.comment.trim() ?? "") !== "") || Boolean(dictation.liveText) || dictation.phase !== "idle";
  const requestClose = useCallback(() => {
    if (guard) setGuard(false);
    else if (unsaved) setGuard(true);
    else onClose();
  }, [guard, unsaved, onClose]);
  useOverlayEscape(requestClose, viewer === null);

  /* Arrows step through the round's pictures and digits toggle a variant,
     claimed in the window's capture phase so the board behind never moves on
     the same press. A text field and a playing video keep their keys. */
  useEffect(() => {
    if (viewer || guard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        show(index + (event.key === "ArrowRight" ? 1 : -1));
        return;
      }
      if (!open || !/^[1-9]$/.test(event.key)) return;
      const number = Number(event.key);
      if (!round?.variants.some((entry) => entry.number === number)) return;
      event.preventDefault();
      event.stopPropagation();
      toggle(number);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [viewer, guard, index, open, round, show, toggle]);

  /* The shown picture's thumbnail stays in view as the arrows walk on. */
  /* Only the strip moves: bringing a thumbnail into view must never scroll the
     sheet that holds the strip. */
  useEffect(() => {
    const row = strip.current;
    const thumb = row?.querySelector<HTMLElement>("[aria-current='true']");
    if (!row || !thumb) return;
    const own = row.getBoundingClientRect();
    const box = thumb.getBoundingClientRect();
    if (box.left < own.left + 16) row.scrollLeft -= own.left + 16 - box.left;
    else if (box.right > own.right - 16) row.scrollLeft += box.right - (own.right - 16);
  }, [slide?.key]);

  /* On the phone the shown variant's chip is brought into its row at a chip's
     start, 16 px in from the edge, so the row never shows a chip cut through
     its words on the left: the furthest such start that keeps the chip whole
     on the left, the nearest one that shows it whole on the right. */
  const chipRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = chipRow.current;
    const chip = row?.querySelector<HTMLElement>("[aria-pressed='true']");
    if (!row || !chip) return;
    const inset = 16;
    const own = row.getBoundingClientRect();
    const place = (element: Element) => row.scrollLeft + element.getBoundingClientRect().left - own.left;
    const left = place(chip);
    const right = left + chip.getBoundingClientRect().width;
    const limit = Math.min(row.scrollWidth - row.clientWidth, left - inset);
    const starts = [...row.children].map((element) => Math.max(0, place(element) - inset)).filter((start) => start <= limit).sort((a, b) => a - b);
    row.scrollLeft = starts.find((start) => right - start <= row.clientWidth - inset) ?? starts.at(-1) ?? 0;
  }, [variant?.number, roundId]);

  const zoom = (media: PrototypeMediaView | undefined, of: Slide) => {
    if (!round || !media?.url) return;
    const gallery = galleryOf(t, round, slides.filter((entry) => entry.variant === of.variant), broken);
    const image = gallery.find((entry) => entry.src === media.url || entry.before?.src === media.url);
    if (image) setViewer({ src: media.url, image, gallery });
  };
  /* The stage follows the viewer, so closing it leaves the operator on the picture they stepped to. */
  const follow = (image: GalleryImage) => {
    const at = slides.findIndex((entry) => entry.frame && (entry.frame.image.url === image.src || entry.frame.original?.url === image.src));
    if (at >= 0) show(at);
  };
  const markBroken = (id: string) => setBroken((held) => (held.has(id) ? held : new Set([...held, id])));

  /* A decision cannot be changed once saved, so nothing saves while speech is
     still being recorded or transcribed: the comment would go without it. The
     button and the shortcut both come through here. */
  const savable = Boolean(round) && draft.chosen.length > 0 && !review.saving && dictation.phase === "idle";
  /* A held key repeats before the first request has redrawn anything. */
  const saveInFlight = useRef(false);
  const save = async () => {
    if (!round || !savable || saveInFlight.current) return;
    saveInFlight.current = true;
    try {
      const saved = await review.save({ reviewId: round.id, chosen: draft.chosen, comment: draft.comment });
      if (saved) setDrafts((held) => Object.fromEntries(Object.entries(held).filter(([id]) => id !== round.id)));
    } finally {
      saveInFlight.current = false;
    }
  };

  const title = t("proto.title");
  const variantSlides = variant ? slides.filter((entry) => entry.variant === variant) : [];
  const firstOf = (target: Variant) => slides.findIndex((entry) => entry.variant === target);

  const banners = (
    <>
      {review.error ? (
        <p role="alert" data-prototype-error="" className="m-0 flex items-start gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2 text-label font-semibold text-danger">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {review.error}
        </p>
      ) : null}
      {elsewhere ? (
        <p role="status" data-prototype-elsewhere="" className="m-0 border-b border-border bg-sunken px-4 py-2 text-label text-secondary">{t("proto.elsewhere")}</p>
      ) : round?.mediaRemovedAt ? (
        <p role="status" data-prototype-retired="" className="m-0 border-b border-border bg-sunken px-4 py-2 text-label text-secondary">
          {t("proto.retired", { date: whenDate(round.mediaRemovedAt, locale) })}
        </p>
      ) : null}
      {data?.historyTruncated ? <p role="status" className="m-0 border-b border-border bg-sunken px-4 py-2 text-label text-secondary">{t("proto.truncated")}</p> : null}
    </>
  );

  const roundNumber = (id: string) => rounds.findIndex((entry) => entry.id === id) + 1;
  const supersededWords = (id: string) => t("proto.round.superseded", { n: roundNumber(id) });
  const roundTabs = rounds.length > 1 ? (
    <div role="group" aria-label={t("proto.rounds")} data-prototype-rounds={rounds.length} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {rounds.map((entry, at) => (
        <button
          key={entry.id}
          type="button"
          data-prototype-round={entry.id}
          aria-pressed={entry.id === roundId}
          disabled={speaking && entry.id !== roundId}
          title={speaking && entry.id !== roundId ? t("proto.round.speaking") : [entry.title, when(entry.createdAt, locale), ...(!entry.decision && entry.supersededBy ? [supersededWords(entry.supersededBy)] : [])].join(" · ")}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-canvas px-2.5 text-label font-semibold text-secondary enabled:hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-accent/50 aria-pressed:bg-accent-soft aria-pressed:text-accent [@media(pointer:coarse)]:h-9"
          onClick={() => { if (!speaking) setPicked(entry.id); }}
        >
          {t("proto.round", { n: at + 1 })}
          {entry.decision ? <Check className="h-3 w-3" aria-label={t("proto.round.decided")} />
            /* A later decision retired this round: it stays readable, and waits for nothing. */
            : entry.supersededBy ? <CornerDownRight data-prototype-superseded={entry.supersededBy} className="h-3 w-3 text-muted" role="img" aria-label={supersededWords(entry.supersededBy)} />
            : <span className="h-1.5 w-1.5 rounded-full bg-accent" role="img" aria-label={t("proto.round.waiting")} />}
        </button>
      ))}
    </div>
  ) : null;

  /* A variant in the list: its number is the choice (a check once chosen), the
     rest of the row shows it on the stage. The accent belongs to the choice
     alone: a chosen row is tinted, and the row on the stage is only framed. */
  const variantRow = (entry: Variant) => {
    const chosen = round?.decision ? round.decision.chosen.includes(entry.number) : draft.chosen.includes(entry.number);
    const current = entry === variant;
    return (
      <li key={entry.number} data-prototype-variant={entry.number} data-chosen={chosen ? "1" : "0"} className={`flex min-w-0 items-start gap-2 rounded-control border p-1.5 ${chosen ? `bg-accent-soft ${current ? "border-accent/60" : "border-accent/25"}` : current ? "border-strong bg-sunken" : "border-transparent hover:bg-sunken"}`}>
        <button
          type="button"
          role="checkbox"
          aria-checked={chosen}
          disabled={!open}
          data-prototype-choose={entry.number}
          aria-label={t(chosen ? "proto.unchoose" : "proto.choose", { variant: variantLabel(entry) })}
          title={open ? t("proto.chooseHint", { n: entry.number }) : undefined}
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-control border text-label font-bold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default ${chosen ? "border-accent bg-accent text-white" : "border-border bg-card text-secondary enabled:hover:border-accent/60 enabled:hover:text-accent"}`}
          onClick={() => toggle(entry.number)}
        >
          {chosen ? <Check className="h-3.5 w-3.5" aria-hidden /> : entry.number}
        </button>
        <button
          type="button"
          aria-current={current ? "true" : undefined}
          data-prototype-show={entry.number}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => show(firstOf(entry))}
        >
          <span className="w-full min-w-0 break-words text-ui font-semibold text-primary">{chosen ? `${entry.number} · ${entry.name}` : entry.name}</span>
          {entry.description ? <span className="w-full whitespace-pre-line break-words text-label text-secondary">{entry.description}</span> : null}
        </button>
      </li>
    );
  };

  /* The phone has no room for the list beside the stage: the variants are a
     row of chips, and the shown one's words and its choice stand under it.
     As in the list, a chosen chip is tinted and the shown one only framed.
     The row keeps its 16 px inset when it scrolls a chip into view. */
  const variantChips = round ? (
    <div ref={chipRow} role="group" aria-label={t("proto.variants")} data-prototype-chips="" className="-mx-4 flex scroll-px-4 gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {round.variants.map((entry) => {
        const chosen = round.decision ? round.decision.chosen.includes(entry.number) : draft.chosen.includes(entry.number);
        return (
          <button
            key={entry.number}
            type="button"
            data-prototype-variant={entry.number}
            data-chosen={chosen ? "1" : "0"}
            aria-pressed={entry === variant}
            className={`inline-flex h-11 max-w-[70vw] shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${chosen ? `bg-accent-soft text-accent ${entry === variant ? "border-accent/60" : "border-accent/25"}` : entry === variant ? "border-strong bg-sunken text-primary" : "border-border bg-card text-secondary"}`}
            onClick={() => show(firstOf(entry))}
          >
            <span className={`grid h-5 min-w-5 place-items-center rounded-sm px-1 text-caption font-bold tabular-nums ${chosen ? "bg-accent text-white" : "bg-sunken text-secondary"}`}>
              {chosen ? <Check className="h-3 w-3" aria-hidden /> : entry.number}
            </span>
            <span className="truncate">{chosen ? `${entry.number} · ${entry.name}` : entry.name}</span>
          </button>
        );
      })}
    </div>
  ) : null;
  const variantWords = variant ? (
    <div className="flex items-start gap-2 px-4">
      <p className="m-0 min-w-0 flex-1 whitespace-pre-line break-words text-label text-secondary">{variant.description}</p>
      {open ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={draft.chosen.includes(variant.number)}
          data-prototype-choose={variant.number}
          className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${draft.chosen.includes(variant.number) ? "border-accent bg-accent text-white" : "border-border bg-card text-primary"}`}
          onClick={() => toggle(variant.number)}
        >
          {draft.chosen.includes(variant.number) ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
          {t(draft.chosen.includes(variant.number) ? "proto.chosenOne" : "proto.chooseOne")}
        </button>
      ) : null}
    </div>
  ) : null;

  const gone = (
    <div data-prototype-gone="" className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center text-muted">
      <ImageOff className="h-5 w-5" aria-hidden />
      <span className="text-label font-semibold">{t(elsewhere ? "proto.goneElsewhere" : "proto.gone")}</span>
    </div>
  );
  /* On the desktop a picture is fitted into the stage; on the phone it takes
     the stage's whole width and its own height, and the sheet scrolls. */
  const picture = (media: PrototypeMediaView | undefined, alt: string, of: Slide) => (shown(media, broken) ? (
    <button
      type="button"
      data-prototype-zoom={media.id}
      aria-label={t("proto.zoomAria", { name: alt })}
      className={`${phone ? "block w-full" : "absolute inset-0 flex items-center justify-center"} cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
      onClick={() => zoom(media, of)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a fenced local copy; next/image cannot serve it */}
      <img src={media.url} alt={alt} draggable={false} decoding="async" className={phone ? "block h-auto w-full" : "max-h-full max-w-full object-contain"} onError={() => markBroken(media.id)} />
    </button>
  ) : <div className={phone ? "h-[32vh]" : "absolute inset-0"}>{gone}</div>);

  const pairTag = "shrink-0 text-caption font-semibold uppercase tracking-wide text-muted";
  const stageBody = !slide ? (
    <div className="absolute inset-0 flex items-center justify-center text-label text-muted">{t("proto.noMedia")}</div>
  ) : slide.video ? (
    shown(slide.video, broken) ? (
      <div className={phone ? "" : "absolute inset-0 flex items-center justify-center p-3"}>
        <video key={slide.video.url} data-prototype-video={slide.video.id} src={slide.video.url} controls playsInline preload="metadata" aria-label={slideLabel(slide)} className={phone ? "block h-auto w-full bg-black" : "max-h-full max-w-full rounded-sm bg-black"} onError={() => markBroken(slide.video!.id)} />
      </div>
    ) : <div className={phone ? "h-[32vh]" : "absolute inset-0"}>{gone}</div>
  ) : slide.frame?.original && mode === "slider" && shown(slide.frame.original, broken) && shown(slide.frame.image, broken) ? (
    <SliderPair
      key={slide.key}
      original={{ url: slide.frame.original.url, alt: `${slideLabel(slide)} · ${t("proto.pair.original")}`, onError: () => markBroken(slide.frame!.original!.id) }}
      changed={{ url: slide.frame.image.url, alt: `${slideLabel(slide)} · ${t("proto.pair.changed")}`, onError: () => markBroken(slide.frame!.image.id) }}
      labels={{ original: t("proto.pair.original"), changed: t("proto.pair.changed"), slider: t("proto.pair.sliderAria"), open: t("proto.zoomAria", { name: `${slideLabel(slide)} · ${t("proto.pair.changed")}` }) }}
      tagClass={pairTag}
      split={split}
      onSplit={setSplit}
      onOpen={() => zoom(slide.frame!.image, slide)}
      fill={phone}
    />
  ) : slide.frame?.original && phone ? (
    /* A pair with one side unreadable: the side that is left, at the stage's width. */
    picture(shown(slide.frame.image, broken) ? slide.frame.image : slide.frame.original, `${slideLabel(slide)} · ${t(`proto.pair.${shown(slide.frame.image, broken) ? "changed" : "original"}`)}`, slide)
  ) : slide.frame?.original ? (
    <div data-prototype-pair="side" className="absolute inset-0 grid grid-cols-2 gap-2 p-3">
      {(["original", "changed"] as const).map((side) => (
        <figure key={side} data-prototype-pair-side={side} className="m-0 flex min-h-0 min-w-0 flex-col gap-1">
          <figcaption className={pairTag}>{t(`proto.pair.${side}`)}</figcaption>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm border border-border bg-card">
            {picture(side === "original" ? slide.frame!.original : slide.frame!.image, `${slideLabel(slide)} · ${t(`proto.pair.${side}`)}`, slide)}
          </div>
        </figure>
      ))}
    </div>
  ) : phone ? picture(slide.frame?.image, slideLabel(slide), slide) : (
    <div className="absolute inset-3">{picture(slide.frame?.image, slideLabel(slide), slide)}</div>
  );

  const stage = round ? (
    <section data-prototype-stage={slide?.key ?? ""} aria-label={slide ? slideLabel(slide) : title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
        {slide ? (
          /* One run of text that wraps inside the stage: the longest name and
             the longest caption the schema admits are both read in full. */
          <p data-prototype-caption="" className="m-0 min-w-0 flex-1 basis-56 text-ui [overflow-wrap:anywhere]">
            <span data-prototype-caption-number="" className="mr-1.5 inline-grid h-5 min-w-5 place-items-center rounded-sm bg-sunken px-1 align-middle text-caption font-bold tabular-nums text-secondary">{slide.variant.number}</span>
            <span data-prototype-caption-name="" className="font-semibold text-primary">{slide.variant.name}</span>
            {slide.caption ? <><span aria-hidden className="text-muted">{" — "}</span><span data-prototype-caption-text="" className="text-secondary">{slide.caption}</span></> : null}
          </p>
        ) : <span className="flex-1" />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {slide?.frame?.original && !phone ? (
            <span role="group" aria-label={t("proto.pair.mode")} className="flex items-center gap-1">
              <button type="button" className={TOOL} data-prototype-pair-mode="side" aria-pressed={mode === "side"} aria-label={t("proto.pair.side")} title={t("proto.pair.side")} onClick={() => setPairMode("side")}>
                <Columns2 className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button type="button" className={TOOL} data-prototype-pair-mode="slider" aria-pressed={mode === "slider"} aria-label={t("proto.pair.slider")} title={t("proto.pair.slider")} onClick={() => setPairMode("slider")}>
                <SquareSplitHorizontal className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
          {slide?.frame && shown(slide.frame.image, broken) ? (
            <button type="button" className={TOOL} data-prototype-fullsize="" aria-label={t("proto.fullSize")} title={t("proto.fullSize")} onClick={() => zoom(slide.frame!.image, slide)}>
              <ZoomIn className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          <button type="button" className={TOOL} data-prototype-step="previous" disabled={index <= 0} aria-label={t("lightbox.previous")} onClick={() => show(index - 1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <span data-prototype-position="" className="min-w-[3.25rem] text-center text-label font-semibold tabular-nums text-secondary">{slide ? `${slide.at + 1} / ${slide.of}` : "0 / 0"}</span>
          <button type="button" className={TOOL} data-prototype-step="next" disabled={index >= slides.length - 1} aria-label={t("lightbox.next")} onClick={() => show(index + 1)}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>
      <div data-prototype-canvas="" className={`relative bg-sunken ${phone ? "min-h-24 shrink-0" : "min-h-0 flex-1"}`}>{stageBody}</div>
      {variantSlides.length > 1 ? (
        <div ref={strip} data-prototype-strip={variantSlides.length} className="flex shrink-0 gap-1.5 overflow-x-auto px-4 py-2">
          {variantSlides.map((entry) => {
            const at = slides.indexOf(entry);
            const thumb = entry.frame?.image;
            return (
              <button
                key={entry.key}
                type="button"
                data-prototype-thumb={entry.key}
                aria-current={at === index ? "true" : undefined}
                aria-label={slideLabel(entry)}
                title={slideLabel(entry)}
                className="relative h-12 w-[72px] shrink-0 overflow-hidden rounded-sm border border-border bg-sunken text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 aria-[current=true]:border-accent aria-[current=true]:ring-1 aria-[current=true]:ring-accent"
                onClick={() => show(at)}
              >
                {entry.video ? (
                  <Film className="m-auto h-4 w-4" aria-hidden />
                ) : shown(thumb, broken) ? (
                  /* eslint-disable-next-line @next/next/no-img-element -- a fenced local copy */
                  <img src={thumb.url} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover object-top" onError={() => markBroken(thumb.id)} />
                ) : (
                  <ImageOff className="m-auto h-4 w-4" aria-hidden />
                )}
                {entry.frame?.original ? <SquareSplitHorizontal className="absolute bottom-0.5 right-0.5 h-3 w-3 rounded-[2px] bg-card/90 text-secondary" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  ) : null;

  const chosenChips = (numbers: readonly number[]) => (round?.variants ?? []).filter((entry) => numbers.includes(entry.number)).map((entry) => (
    <span key={entry.number} data-prototype-chosen={entry.number} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-label font-semibold text-accent">
      <span className="tabular-nums">{entry.number}</span>
      <span className="min-w-0 truncate">{entry.name}</span>
    </span>
  ));

  const delivery = (state: PrototypeDeliveryState, retryable: boolean) => {
    const tone = state === "sent" ? "text-success" : state === "pending" ? "text-muted" : "text-warning";
    return (
      <p role="status" data-prototype-delivery={state} className={`m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-label font-semibold ${tone}`}>
        {/* The mark stays on the first line of its words, which wrap inside themselves; only the retry moves to a line of its own. */}
        <span data-prototype-delivery-said="" className="flex min-w-0 items-start gap-2">
          <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
            {state === "sent" ? <CircleCheck className="h-3.5 w-3.5" /> : state === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <TriangleAlert className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0">{t(`proto.delivery.${state}`)}</span>
        </span>
        {retryable && state !== "pending" && state !== "sent" && !elsewhere ? (
          <button type="button" className={SECONDARY} data-prototype-retry="" disabled={review.saving} onClick={() => void review.retry(round!.id)}>
            {review.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
            {t(state === "no-orchestrator" ? "proto.delivery.sendNow" : "proto.delivery.retry")}
          </button>
        ) : null}
      </p>
    );
  };

  /* A superseded round says so where a waiting round asks for a choice: the
     operator answered in the round that retired it. Its choice stays closed
     until the operator opts to decide this round anyway. */
  const supersededLine = successor ? (
    <div data-prototype-superseded-line={successor.id} className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
      {/* The mark stays on the first line; a wrapped link starts under the sentence, and only the button moves to a line of its own. */}
      <span data-prototype-superseded-said="" className="flex min-w-0 items-start gap-2 text-label font-semibold">
        <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
          <CornerDownRight className="h-3.5 w-3.5 text-muted" />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-secondary">
            {t("proto.supersededLine", { n: roundNumber(successor.id), date: successor.decision ? whenDate(successor.decision.at, locale) : "" })}
          </span>
          <button type="button" data-prototype-open-round={successor.id} disabled={speaking} className="rounded-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50" onClick={() => setPicked(successor.id)}>
            {t("proto.openRound", { n: roundNumber(successor.id) })}
          </button>
        </span>
      </span>
      {open || elsewhere ? null : (
        <button type="button" data-prototype-decide-anyway="" className={`${SECONDARY} ml-auto`} onClick={() => setReopened((held) => new Set([...held, round!.id]))}>
          {t("proto.decideAnyway")}
        </button>
      )}
    </div>
  ) : null;

  const footer = !round ? null : round.decision ? (
    <div data-prototype-decision={round.id} className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>
        {chosenChips(round.decision.chosen)}
        <time dateTime={round.decision.at} className="ml-auto shrink-0 text-caption tabular-nums text-muted">{when(round.decision.at, locale)}</time>
      </div>
      {round.decision.comment ? (
        <p data-prototype-comment="" className="m-0 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-border bg-canvas px-2.5 py-1.5 text-ui text-primary">{round.decision.comment}</p>
      ) : (
        <p className="m-0 text-label text-muted">{t("proto.noComment")}</p>
      )}
      {delivery(round.decision.delivery.state, round.decision.delivery.retryable)}
    </div>
  ) : elsewhere ? supersededLine : successor && !open ? (
    <div className="flex min-w-0 flex-1 flex-col">{supersededLine}</div>
  ) : (
    <div data-prototype-decide={round.id} className="flex min-w-0 flex-1 flex-col gap-2">
      {supersededLine}
      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>
        {draft.chosen.length ? chosenChips(draft.chosen) : <span className="text-label text-muted">{t(phone ? "proto.chooseFirstPhone" : "proto.chooseFirst")}</span>}
      </div>
      <div className={`flex gap-2 ${phone ? "flex-col" : "items-end"}`}>
        <div className={`flex min-w-0 flex-1 rounded-control border border-border bg-canvas focus-within:border-accent/60 ${recording ? "flex-col gap-1.5 p-2" : "items-end gap-1 py-1 pl-2.5 pr-1"}`}>
          <textarea
            ref={field}
            rows={2}
            value={comment}
            readOnly={Boolean(dictation.liveText)}
            data-prototype-comment-field=""
            aria-label={t("proto.comment")}
            placeholder={t("proto.commentPlaceholder")}
            className={`max-h-32 min-h-[2.75rem] resize-none bg-transparent text-body text-primary outline-none placeholder:text-muted [field-sizing:content] ${recording ? "w-full" : "min-w-0 flex-1 self-center"}`}
            onChange={(event) => setDraft((held) => ({ ...held, comment: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <span className={recording ? "self-end" : "shrink-0"}>
            <MicButtonView {...dictation} start={startDictation} busy={review.saving} onText={insertSpoken} anchored />
          </span>
        </div>
        <button type="button" className={PRIMARY} data-prototype-save="" disabled={!savable} onClick={() => void save()}>
          {review.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {t("proto.save")}
        </button>
      </div>
      {voiceError ? <p role="alert" className="m-0 text-label font-semibold text-danger">{voiceError}</p> : null}
    </div>
  );

  const guardDialog = guard ? (
    <div className={`${phone ? `fixed ${Z.overlay}` : "absolute z-[2]"} inset-0 flex items-center justify-center bg-black/40 p-4`} onClick={(event) => { if (event.target === event.currentTarget) setGuard(false); }}>
      <div role="alertdialog" aria-modal="true" aria-label={t("proto.guard.title")} data-prototype-guard="" className="flex w-full max-w-[360px] flex-col gap-3 rounded-surface border border-border bg-raised p-4 shadow-2">
        <div>
          <p className="m-0 text-body font-semibold text-primary">{t("proto.guard.title")}</p>
          <p className="m-0 mt-1 text-label text-secondary">{t("proto.guard.body")}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" autoFocus className={SECONDARY} data-prototype-guard-keep="" onClick={() => setGuard(false)}>{t("proto.guard.keep")}</button>
          <button type="button" className={`${SECONDARY} text-danger hover:border-danger/50 hover:text-danger`} data-prototype-guard-discard="" onClick={onClose}>{t("proto.guard.discard")}</button>
        </div>
      </div>
    </div>
  ) : null;

  const waitingBody = review.loading ? (
    <p role="status" className="m-0 flex items-center gap-2 px-4 py-6 text-label font-semibold text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("common.loadingCap")}
    </p>
  ) : !round ? (
    <p data-prototype-empty="" className="m-0 px-4 py-6 text-center text-ui text-muted">{review.error ? t("proto.failed") : t("proto.empty")}</p>
  ) : null;

  const lightbox = viewer ? (
    <ImageGalleryProvider value={() => viewer.gallery}>
      <Lightbox src={viewer.src} alt={viewer.image.alt} caption={viewer.image.caption} detail={viewer.image.detail} onShow={follow} onClose={() => setViewer(null)} />
    </ImageGalleryProvider>
  ) : null;

  if (phone) {
    return (
      <>
        <MobileSheet name="prototype-review" title={title} full onClose={requestClose} footer={footer}>
          <div data-prototype-review={taskId} data-prototype-round-shown={roundId ?? ""} className="relative flex flex-col gap-2 pb-1">
            {banners}
            {/* The round, its task and the variants' chips stay whole at the top
                while the body scrolls under them, so a choice or the field never
                leaves them cut. */}
            <div data-prototype-context="" className="sticky top-0 z-[2] flex flex-col gap-1.5 bg-raised px-4 py-1">
              <p data-prototype-context-line="" className="m-0 text-label text-muted"><span className="font-semibold text-secondary">{round?.title ?? ""}</span>{round ? " · " : ""}{taskTitle}</p>
              {roundTabs}
              {waitingBody ? null : variantChips}
            </div>
            {waitingBody ?? (
              <>
                {variantWords}
                {stage}
              </>
            )}
          </div>
          {guardDialog}
        </MobileSheet>
        {lightbox}
      </>
    );
  }

  return createPortal(
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-6`}
      data-prototype-review={taskId}
      data-prototype-round-shown={roundId ?? ""}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("proto.dialogAria", { title: taskTitle })} tabIndex={-1} className="relative flex h-[min(88vh,960px)] w-[min(1240px,calc(100vw-48px))] min-h-0 flex-col overflow-hidden rounded-surface border border-border bg-card shadow-2 outline-none">
        {viewer ? null : <DialogLayer containerRef={dialog} onClose={requestClose} />}
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <GalleryHorizontalEnd className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-body font-bold text-primary">{round?.title ?? title}</h2>
            <p className="m-0 truncate text-label text-muted">{title} · {taskTitle}</p>
          </div>
          {roundTabs}
          <button
            type="button"
            data-prototype-close=""
            aria-label={t("common.close")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={requestClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        {banners}
        {waitingBody ? <div className="min-h-0 flex-1">{waitingBody}</div> : (
          <div className="flex min-h-0 flex-1">
            <aside aria-label={t("proto.variants")} className="flex w-[264px] shrink-0 flex-col border-r border-border">
              <p className="m-0 flex shrink-0 items-baseline gap-1.5 px-3 pb-1 pt-2.5 text-label font-semibold text-secondary">
                {t("proto.variants")} <span className="text-caption tabular-nums text-muted">{round?.variants.length ?? 0}</span>
              </p>
              <ul data-prototype-variants="" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-1.5">
                {round?.variants.map(variantRow)}
              </ul>
            </aside>
            {stage}
          </div>
        )}
        {footer ? <footer className="flex shrink-0 border-t border-border px-4 py-3">{footer}</footer> : null}
        {guardDialog}
      </div>
      {lightbox}
    </div>,
    document.body,
  );
}
