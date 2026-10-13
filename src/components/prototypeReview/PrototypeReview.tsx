"use client";

import { CornerDownRight, Film, GalleryHorizontalEnd, MessageCircleQuestionMark, ImageOff, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { Check, CircleCheck, X } from "@/components/icons";
import { Z } from "@/components/layers";
import { MicButtonView } from "@/components/MicButton";
import { MobileSheet } from "@/components/mobile/MobileSheet";
import { useModalLayer } from "@/components/modalLayer";
import { useDictation } from "@/hooks/useDictation";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useOverlayEscape } from "@/hooks/useOverlayEscape";
import { usePrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { PrototypeAnswer, PrototypeMediaView, PrototypeRoundView } from "@/lib/prototypeReview/types";

import { normalizePrototypeAnswers, recommendedAnswers } from "@/lib/prototypeReview/questions";

import { DecisionQuestions, selectPrototypeAnswer } from "./DecisionQuestions";
import { markPrototypeReviewSeen } from "./prototypeReviewStore";
import { PrototypeTelegramActions } from "./PrototypeTelegramActions";

type Variant = PrototypeRoundView["variants"][number];
type Frame = Variant["frames"][number];

/** One gallery tile: a picture, an original with its change, or a video. */
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

interface Draft { reject: boolean; chosen: number[]; comment: string; answers: PrototypeAnswer[] }
const initialDraft = (round: PrototypeRoundView | null): Draft => ({ reject: false, chosen: [], comment: "", answers: recommendedAnswers(round?.questions ?? []) });
/* A save the server refused after its review was closed or replaced: the
   choice and the exact words wait here, with the reason, for the task's
   review to open again. */
const refusedSaves = new Map<string, { drafts: Record<string, Draft>; error: string }>();
/* What a close would lose in the waiting rounds: answers changed from the recommended ones, and comments. */
const unsavedOf = (rounds: readonly PrototypeRoundView[], drafts: Record<string, Draft>) => ({
  answers: rounds.some((entry) => !entry.decision && Boolean(entry.questions?.length) && drafts[entry.id] !== undefined && JSON.stringify(drafts[entry.id]!.answers) !== JSON.stringify(recommendedAnswers(entry.questions!))),
  comment: rounds.some((entry) => !entry.decision && (drafts[entry.id]?.comment.trim() ?? "") !== ""),
});

/** A moment as the product writes one: day, month and a 24-hour clock, no seconds. */
const when = (at: string, locale: string) => new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
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

/** The pictures the full-screen viewer steps through: every frame of the
    round in tile order. A pair is one picture whose original the viewer swaps in place. */
function galleryOf(t: TFunction, round: PrototypeRoundView, slides: readonly Slide[], broken: ReadonlySet<string>): GalleryImage[] {
  return slides.flatMap((slide): GalleryImage[] => {
    if (!slide.frame) return [];
    const label = slideLabel(slide);
    const named = (side?: "original" | "changed") => (side ? `${label} · ${t(`proto.pair.${side}`)}` : label);
    const { image, original } = slide.frame;
    const frames = slides.filter(s => s.frame);
    const at = frames.indexOf(slide);
    const place = `${at + 1} / ${frames.length}`;
    const changed = shown(image, broken);
    const before = shown(original, broken);
    if (changed && before) return [{ src: image.url, alt: named("changed"), caption: named("changed"), detail: round.title, place, owner: null, at, before: { src: original.url, alt: named("original"), caption: named("original") } }];
    if (changed) return [{ src: image.url, alt: named(original ? "changed" : undefined), caption: named(original ? "changed" : undefined), detail: round.title, place, owner: null, at }];
    if (before) return [{ src: original.url, alt: named("original"), caption: named("original"), detail: round.title, place, owner: null, at }];
    return [];
  });
}

/** Every frame of a round, for a surface that shows its pictures without the
    review window (a seat's taskless round in the «Рішення» column). The viewer
    steps across the variants, so it counts the round's frames itself. */
export const roundGallery = (t: TFunction, round: PrototypeRoundView): GalleryImage[] =>
  galleryOf(t, round, slidesOf(round), new Set()).map(({ place: _place, ...image }) => image);

const typing = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(element.tagName) || element.isContentEditable));
};

const SECONDARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 [@media(pointer:coarse)]:h-11";
const PRIMARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3.5 text-ui font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-45 [@media(pointer:coarse)]:h-11";
const REJECT_PRIMARY = PRIMARY.replace("bg-accent", "bg-warning").replace("text-white", "text-canvas").replace("ring-accent", "ring-warning");

/** The desktop dialog's place in the modal stack: Tab stays inside and focus
    returns to the button that opened it. Unmounted while the full-screen
    viewer is up, which is drawn outside the dialog and owns the keys then. */
function DialogLayer({ containerRef, onClose }: { containerRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  useModalLayer({ containerRef, onClose });
  return null;
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => refusedSaves.get(taskId)?.drafts ?? {});
  const [refused, setRefused] = useState<string | null>(() => refusedSaves.get(taskId)?.error ?? null);
  useEffect(() => { refusedSaves.delete(taskId); }, [taskId]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [rejectAsked, setRejectAsked] = useState(false);
  /* The picture opened full screen and the round gallery it belongs to. */
  const [viewer, setViewer] = useState<{ src: string; image: GalleryImage; gallery: GalleryImage[] } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [guard, setGuard] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  /* Superseded rounds the operator chose to decide anyway. */
  const [reopened, setReopened] = useState<ReadonlySet<string>>(() => new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const viewerTile = useRef<string | null>(null);

  const rounds = useMemo(() => data?.rounds ?? [], [data?.rounds]);
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
  const variant = slides[index]?.variant ?? round?.variants[0] ?? null;
  const elsewhere = data?.unavailable === "another-installation";
  /* The later decided round that retired this one: the operator already answered there. */
  const successor = round && !round.decision && round.supersededBy ? rounds.find((entry) => entry.id === round.supersededBy) ?? null : null;
  const open = Boolean(round && !round.decision && !round.hidden && !elsewhere && (!successor || reopened.has(round.id)));
  const draft = (roundId && drafts[roundId]) || initialDraft(round);
  useEffect(() => {
    if (round && !round.decision) markPrototypeReviewSeen(round.id);
  }, [round]);

  const setDraft = useCallback((change: (held: Draft) => Draft, target: string | null = roundId) => {
    if (!target) return;
    setDrafts((held) => ({ ...held, [target]: change(held[target] ?? initialDraft(rounds.find(r => r.id === target) ?? null)) }));
  }, [roundId, rounds]);
  const toggle = useCallback((number: number) => {
    setDraft((held) => ({ ...held, reject: false, chosen: held.chosen.includes(number) ? held.chosen.filter((own) => own !== number) : [...held.chosen, number].sort((a, b) => a - b) }));
  }, [setDraft]);
  const show = useCallback((next: number) => {
    if (!roundId || next < 0 || next >= slides.length) return;
    setActive((held) => ({ ...held, [roundId]: next }));
    galleryRef.current?.querySelector<HTMLElement>(`[data-prototype-group="${slides[next]!.variant.number}"]`)?.scrollIntoView({ block: "start" });
  }, [roundId, slides]);

  /* The composer's dictation, as the composer wires it: a spoken segment is
     appended to what is typed, and the transcript in flight overlays the
     field until it lands. Speech belongs to the round it was started in: the
     press on the microphone pins that round on the stage, and every word that
     comes back, live or after the recording, is written into its comment. */
  const speechRound = useRef<string | null>(null);
  const insertSpoken = useCallback((spoken: string) => {
    setDraft((held) => ({ ...held, comment: held.comment ? `${held.comment.trimEnd()} ${spoken}` : spoken }), speechRound.current ?? roundId);
    setVoiceError(null);
    setRejectAsked(false);
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
  const lost = unsavedOf(rounds, drafts);
  const answersChanged = lost.answers;
  const unsaved = answersChanged || lost.comment || speaking;
  /* A save answers after the render that sent it: a close waiting for it reads the rounds, the drafts and the speech as they are then. */
  const latest = useRef({ rounds, drafts, speaking });
  useEffect(() => { latest.current = { rounds, drafts, speaking }; }, [rounds, drafts, speaking]);
  /* The guard names what is lost: changed answers, else the comment. */
  const guardKind = answersChanged ? "answers" : "comment";
  /* A held key repeats before the first request has redrawn anything. */
  const saveInFlight = useRef(false);
  /* A save in flight is no decision yet: the first close waits for the
     server's word and closes once the decision is written, or stays with the
     choice, the words and the reason when it is refused. */
  const closeOnSave = useRef(false);
  const requestClose = useCallback(() => {
    if (guard) setGuard(false);
    else if (saveInFlight.current && !closeOnSave.current) closeOnSave.current = true;
    else if (unsaved) setGuard(true);
    else onClose();
  }, [guard, unsaved, onClose]);
  useOverlayEscape(requestClose, viewer === null);

  /* Digits toggle a variant,
     claimed in the window's capture phase so the board behind never moves on
     the same press. A text field, a playing video and an open single-choice
     question keep their keys: the arrows move that question's answer. */
  useEffect(() => {
    if (viewer || guard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
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

  useEffect(() => {
    const gallery = galleryRef.current;
    if (!gallery || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<Element>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target); }
      const group = [...gallery.querySelectorAll<HTMLElement>("[data-prototype-group]")].find(g => visible.has(g));
      const at = slides.findIndex(of => of.variant.number === Number(group?.dataset.prototypeGroup));
      if (roundId && at >= 0) setActive(held => held[roundId] === at ? held : { ...held, [roundId]: at });
    }, { root: phone ? gallery.closest("[data-mobile2-sheet-body]") : gallery, threshold: 0 });
    gallery.querySelectorAll("[data-prototype-group]").forEach(group => observer.observe(group));
    return () => observer.disconnect();
  }, [roundId, slides, phone]);

  useEffect(() => {
    if (!phone) return;
    const context = contextRef.current;
    const gallery = galleryRef.current;
    if (!context || !gallery) return;
    const measure = () => gallery.style.setProperty("--prototype-context-height", `${context.offsetHeight + 8}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(context);
    return () => observer?.disconnect();
  }, [phone, roundId]);

  const zoom = (media: PrototypeMediaView | undefined, of: Slide) => {
    if (!round || !media?.url) return;
    const gallery = galleryOf(t, round, slides, broken);
    const at = slides.filter(slide => slide.frame).findIndex(slide => slide.key === of.key);
    const image = gallery.find((entry) => entry.at === at && (entry.src === media.url || entry.before?.src === media.url));
    if (image) { viewerTile.current = of.key; setViewer({ src: media.url, image, gallery }); }
  };
  /* Closing the viewer returns to the last picture it showed. */
  const follow = (image: GalleryImage) => {
    const frame = slides.filter(entry => entry.frame)[image.at ?? -1];
    if (frame) viewerTile.current = frame.key;
  };
  const markBroken = (id: string) => setBroken((held) => (held.has(id) ? held : new Set([...held, id])));

  /* A decision cannot be changed once saved, so nothing saves while speech is
     still being recorded or transcribed: the comment would go without it. The
     button and the shortcut both come through here. */
  const hasQuestions = Boolean(round?.questions?.length);
  const hasVariants = Boolean(round?.variants.length);
  let answersValid = !hasQuestions;
  if (hasQuestions) {
    try { normalizePrototypeAnswers(round!.questions!, draft.answers, draft.comment); answersValid = true; } catch { answersValid = false; }
  }
  const canSend = open && !review.saving && dictation.phase === "idle";
  const savable = Boolean(round) && (draft.reject || (hasQuestions ? answersValid : draft.chosen.length > 0)) && canSend;
  const save = async (skip = false) => {
    if (!round || !(skip ? hasQuestions && canSend : savable) || saveInFlight.current) return;
    if (draft.reject && !draft.comment.trim()) { setRejectAsked(true); field.current?.focus(); return; }
    if (draft.reject && hasQuestions && !skip && !answersValid) return;
    saveInFlight.current = true;
    setRefused(null);
    const sent = draft;
    try {
      const result = await review.save({ reviewId: round.id, chosen: draft.chosen, comment: draft.comment, ...(draft.reject ? { reject: true as const } : {}),
        ...(hasQuestions ? skip ? { skip: true as const } : { answers: draft.answers } : {}) });
      const closing = closeOnSave.current;
      closeOnSave.current = false;
      if (!mounted.current) {
        if (!result.ok) refusedSaves.set(taskId, { drafts: { ...drafts, [round.id]: sent }, error: result.error });
      } else if (result.ok) {
        setDrafts((held) => Object.fromEntries(Object.entries(held).filter(([id]) => id !== round.id)));
        /* The waited-for close leaves only this round's words behind: another
           round's unsaved words, answers or speech still ask first. */
        if (closing) {
          const now = latest.current;
          const left = unsavedOf(now.rounds, Object.fromEntries(Object.entries(now.drafts).filter(([id]) => id !== round.id)));
          if (left.answers || left.comment || now.speaking) setGuard(true);
          else onClose();
        }
      }
    } finally {
      saveInFlight.current = false;
    }
  };

  const title = t(hasQuestions && !hasVariants ? "proto.questions" : "proto.title");
  const firstOf = (target: Variant) => slides.findIndex((entry) => entry.variant === target);

  const banners = (
    <>
      {review.error ?? refused ? (
        <p role="alert" data-prototype-error="" className="m-0 flex items-start gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2 text-label font-semibold text-danger">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {review.error ?? refused}
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
  const gone = (
    <div data-prototype-gone="" className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center text-muted">
      <ImageOff className="h-5 w-5" aria-hidden />
      <span className="text-label font-semibold">{t(elsewhere ? "proto.goneElsewhere" : "proto.gone")}</span>
    </div>
  );
  const gallery = round ? (
    <div ref={galleryRef} data-prototype-gallery="" className={`min-w-0 ${phone ? "" : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden"}`}>
      {round.variants.map(entry => <section key={entry.number} data-prototype-group={entry.number} style={{ scrollMarginTop: phone ? "var(--prototype-context-height, 0px)" : undefined }} aria-label={variantLabel(entry)} className="border-b border-border p-4 last:border-0">
        {phone ? <div className="mb-2 flex items-start gap-2">
          <p className="m-0 min-w-0 flex-1 text-label text-secondary [overflow-wrap:anywhere]">{entry.description}</p>
          {open ? <button type="button" role="checkbox" aria-checked={draft.chosen.includes(entry.number)} data-prototype-choose={entry.number} className={SECONDARY} onClick={() => toggle(entry.number)}>{t(draft.chosen.includes(entry.number) ? "proto.chosenOne" : "proto.chooseOne")}</button> : null}
        </div> : null}
        <div data-prototype-grid="" className={`grid ${phone ? "grid-cols-2 gap-2" : "grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3"}`}>
          {slides.filter(of => of.variant === entry).map(of => {
            const media = of.video ?? (shown(of.frame?.image, broken) ? of.frame?.image : of.frame?.original);
            const metadata = [of.frame?.width && !of.caption.includes(String(of.frame.width)) ? of.frame.width : null, of.frame?.lang && !of.caption.includes(of.frame.lang) ? of.frame.lang : null].filter(Boolean).join(" · ");
            const content = <>
              <span data-prototype-tile-square="" className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-control border border-border bg-sunken">
                {shown(media, broken) ? of.video ? <video data-prototype-video={media.id} src={media.url} controls preload="metadata" playsInline aria-label={slideLabel(of)} className="h-full w-full object-contain" onError={() => markBroken(media.id)} /> : <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- fenced local media */}
                  <img src={media.url} alt={slideLabel(of)} loading="lazy" decoding="async" draggable={false} className="h-full w-full object-contain" onError={() => markBroken(media.id)} />
                  {of.frame?.original ? <span className="absolute bottom-1 right-1 rounded-sm bg-card p-1"><Film className="h-3 w-3" aria-label={t("proto.pair.mode")} /></span> : null}
                </> : gone}
              </span>
              <span className="mt-1 flex min-w-0 items-start gap-1 text-label">
                <span data-prototype-tile-number="" className="inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-sm bg-sunken text-caption font-bold">{entry.number}</span>
                <span data-prototype-tile-caption="" className="min-w-0 line-clamp-2 text-secondary [overflow-wrap:anywhere]">{of.caption}{metadata ? <span className="text-muted"> · {metadata}</span> : null}</span>
              </span>
            </>;
            return of.video ? <div key={of.key} data-prototype-tile={of.key} className="min-w-0">{content}</div> : <button key={of.key} type="button" data-prototype-tile={of.key} style={{ scrollMarginTop: phone ? "var(--prototype-context-height, 0px)" : undefined }} aria-label={t("proto.zoomAria", { name: slideLabel(of) })} className="min-w-0 self-start text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" onClick={() => zoom(media, of)}>{content}</button>;
          })}
        </div>
      </section>)}
    </div>
  ) : null;

  const chosenChips = (numbers: readonly number[]) => (round?.variants ?? []).filter((entry) => numbers.includes(entry.number)).map((entry) => (
    <span key={entry.number} data-prototype-chosen={entry.number} className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-label font-semibold text-accent">
      <span className="tabular-nums">{entry.number}</span>
      <span className="min-w-0 truncate">{entry.name}</span>
    </span>
  ));

  /* A decision this installation drives says quietly how its message goes:
     saved, on its way, delivered. It raises its voice only once the message
     has kept failing, and only then offers to send it again. A replicated
     decision carries no phase and reads as its state. */
  const delivery = ({ state, retryable, phase }: NonNullable<PrototypeRoundView["decision"]>["delivery"]) => {
    const tone = phase ? phase === "delivered" ? "text-success" : phase === "attention" ? "text-warning" : "text-muted"
      : state === "sent" ? "text-success" : state === "pending" ? "text-muted" : "text-warning";
    const mark = phase ? phase === "delivered" ? <CircleCheck className="h-3.5 w-3.5" /> : phase === "attention" ? <TriangleAlert className="h-3.5 w-3.5" />
      : phase === "delivering" ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Check className="h-3.5 w-3.5" />
      : state === "sent" ? <CircleCheck className="h-3.5 w-3.5" /> : state === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <TriangleAlert className="h-3.5 w-3.5" />;
    const offersRetry = phase ? phase === "attention" : retryable && state !== "pending" && state !== "sent";
    return (
      <p role="status" data-prototype-delivery={state} {...(phase ? { "data-prototype-delivery-phase": phase } : {})} className={`m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-label font-semibold ${tone}`}>
        {/* The mark stays on the first line of its words, which wrap inside themselves; only the retry moves to a line of its own. */}
        <span data-prototype-delivery-said="" className="flex min-w-0 items-start gap-2">
          <span aria-hidden className="flex h-[1lh] shrink-0 items-center">{mark}</span>
          <span className="min-w-0">{t(round?.decision?.rejected && (phase === "delivered" || state === "sent") ? "proto.saved.rejectedDelivered" : phase ? `proto.saved.${phase}` : `proto.delivery.${state}`, { n: rounds.length + 1 })}</span>
        </span>
        {offersRetry && !elsewhere ? (
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

  const selectAnswer = (questionId: string, option: number | "other") => {
    if (!open) return;
    setDraft(held => ({ ...held, answers: selectPrototypeAnswer(round!.questions!, held.answers, questionId, option) }));
  };
  const questionBlock = !hasQuestions ? null : (
    <section data-prototype-questions="" aria-label={t("proto.questions")} className={`flex min-h-0 min-w-0 flex-col gap-3 ${phone ? "px-4 py-2" : `overflow-y-auto p-4 ${hasVariants ? "w-[360px] shrink-0 border-l border-border" : "flex-1"}`}`}>
      {hasVariants ? <p data-prototype-questions-label="" className="m-0 text-label font-semibold text-secondary">{t("proto.questions")}</p> : null}
      {/* An answered or retired questionnaire no longer asks: the choices left
          unpicked fade and the "choose any" hint goes, so it reads as a record. */}
      <DecisionQuestions questions={round!.questions!} answers={round!.decision?.answers ?? draft.answers} open={open} onSelect={selectAnswer} />
    </section>
  );

  const decisionFooter = !round ? null : round.decision ? (
    <div data-prototype-decision={round.id} className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span {...(round.decision.skipped ? { "data-prototype-skipped": "" } : {})} className="text-label font-semibold text-secondary">{round.decision.rejected ? null : t(!hasQuestions ? "proto.chosen" : round.decision.skipped ? "proto.q.skipped" : "proto.q.answered")}</span>
        {round.decision.rejected ? <span data-prototype-rejected="" className="inline-flex items-center gap-1 text-warning"><RotateCw className="h-3.5 w-3.5" aria-hidden />{t("proto.rejected")}</span> : chosenChips(round.decision.chosen)}
        <time dateTime={round.decision.at} className="ml-auto shrink-0 text-caption tabular-nums text-muted">{when(round.decision.at, locale)}</time>
      </div>
      {round.decision.comment ? (
        <p data-prototype-comment="" className="m-0 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-border bg-canvas px-2.5 py-1.5 text-ui text-primary">{round.decision.comment}</p>
      ) : hasQuestions ? null : (
        <p className="m-0 text-label text-muted">{t("proto.noComment")}</p>
      )}
      {delivery(round.decision.delivery)}
    </div>
  ) : round.hidden ? (
    <div data-prototype-hidden={round.id} className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
      <span className="text-label text-secondary">{t("proto.hidden")}</span>
      <button type="button" className={SECONDARY} data-prototype-undo-hide="" disabled={review.saving} onClick={() => void review.hide(round.id, true, phone ? "phone" : "desktop")}>{t("proto.undoHide")}</button>
    </div>
  ) : elsewhere ? supersededLine : successor && !open ? (
    <div className="flex min-w-0 flex-1 flex-col">{supersededLine}</div>
  ) : (
    <div data-prototype-decide={round.id} className="flex min-w-0 flex-1 flex-col gap-2">
      {supersededLine}
      {hasVariants ? <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>
        {draft.reject ? null : draft.chosen.length ? chosenChips(draft.chosen) : <span className="text-label text-muted">{t(phone ? "proto.chooseFirstPhone" : "proto.chooseFirst")}</span>}
        <button type="button" role="checkbox" aria-checked={draft.reject} data-prototype-reject="" className={`${SECONDARY} ${draft.reject ? "border-warning/60 bg-warning-soft text-warning" : ""}`} onClick={() => { setRejectAsked(false); setDraft(held => ({ ...held, reject: !held.reject, chosen: [] })); }}>
          <span aria-hidden className="grid h-4 w-4 place-items-center rounded-sm border border-current">{draft.reject ? <Check className="h-3 w-3" /> : null}</span>{t("proto.reject.none")}
        </button>
        {draft.reject ? <span data-prototype-next-round="" className="text-label text-muted">{t("proto.reject.nextRound", { n: rounds.length + 1 })}</span> : null}
      </div> : null}
      <div className={`flex gap-2 ${phone ? "flex-col" : "items-end"}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={`flex min-w-0 rounded-control border ${draft.reject ? "border-warning/60 focus-within:border-warning" : "border-border focus-within:border-accent/60"} bg-canvas ${recording ? "flex-col gap-1.5 p-2" : "items-end gap-1 py-1 pl-2.5 pr-1"}`}>
            <textarea
              ref={field}
              rows={2}
              value={comment}
              readOnly={Boolean(dictation.liveText)}
              data-prototype-comment-field=""
              aria-label={t("proto.comment")}
              aria-invalid={draft.reject && rejectAsked ? true : undefined}
              placeholder={t(draft.reject ? "proto.reject.placeholder" : hasQuestions ? "proto.q.commentPlaceholder" : "proto.commentPlaceholder", { n: rounds.length + 1 })}
              className={`max-h-32 min-h-[2.75rem] resize-none bg-transparent text-body text-primary outline-none placeholder:text-muted [field-sizing:content] ${recording ? "w-full" : "min-w-0 flex-1 self-center"}`}
              onChange={(event) => { setRejectAsked(false); setDraft((held) => ({ ...held, comment: event.target.value })); }}
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
          {draft.reject && rejectAsked ? <p role="status" data-prototype-reject-needs="" className="m-0 text-label text-warning">{t("proto.reject.needs")}</p> : null}
        </div>
        <div data-prototype-actions="" className={hasQuestions ? phone ? "grid shrink-0 grid-cols-2 gap-2" : "flex shrink-0 justify-end gap-2" : "flex shrink-0 flex-wrap justify-end gap-2"}>
          <button type="button" className={SECONDARY} data-prototype-hide="" disabled={review.saving || speaking} onClick={() => void review.hide(round.id, false, phone ? "phone" : "desktop")}>{t("proto.hide")}</button>
          {hasQuestions ? <button type="button" className={SECONDARY} data-prototype-skip="" aria-label={t("proto.skipAria")} disabled={!canSend} onClick={() => void save(true)}>{t("proto.skip")}</button> : null}
          <button type="button" className={draft.reject ? REJECT_PRIMARY : PRIMARY} aria-label={draft.reject ? t("proto.reject.saveAria") : undefined} data-prototype-save="" disabled={!savable} onClick={() => void save()}>
            {review.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {draft.reject ? <RotateCw className="h-3.5 w-3.5" aria-hidden /> : null}{t(draft.reject ? "proto.reject.save" : hasQuestions ? "proto.answer" : "proto.save")}
          </button>
        </div>
      </div>
      {hasQuestions && !answersValid ? <p role="status" className="m-0 text-label text-muted">{t(draft.answers.some(a => a.other) && !draft.comment.trim() ? "proto.q.otherNeedsComment" : "proto.q.answerAll")}</p> : null}
      {voiceError ? <p role="alert" className="m-0 text-label font-semibold text-danger">{voiceError}</p> : null}
    </div>
  );

  const footer = !round ? decisionFooter : (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      {!elsewhere ? <PrototypeTelegramActions key={round.id} round={round} disabled={review.saving} onResend={() => review.resendTelegram(round.id)} /> : null}
      {decisionFooter}
    </div>
  );

  const guardDialog = guard ? (
    <div className={`${phone ? `fixed ${Z.overlay}` : "absolute z-[2]"} inset-0 flex items-center justify-center bg-black/40 p-4`} onClick={(event) => { if (event.target === event.currentTarget) setGuard(false); }}>
      <div role="alertdialog" aria-modal="true" aria-label={t(`proto.guard.${guardKind}.title`)} data-prototype-guard="" className="flex w-full max-w-[360px] flex-col gap-3 rounded-surface border border-border bg-raised p-4 shadow-2">
        <div>
          <p className="m-0 text-body font-semibold text-primary">{t(`proto.guard.${guardKind}.title`)}</p>
          <p className="m-0 mt-1 text-label text-secondary">{t(`proto.guard.${guardKind}.body`)}</p>
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
      <Lightbox src={viewer.src} alt={viewer.image.alt} caption={viewer.image.caption} detail={viewer.image.detail} at={viewer.image.at} onShow={follow} onClose={() => { setViewer(null); requestAnimationFrame(() => { const tile = galleryRef.current?.querySelector<HTMLElement>(`[data-prototype-tile="${viewerTile.current}"]`); tile?.focus({ preventScroll: true }); tile?.scrollIntoView({ block: "nearest" }); }); }} />
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
            <div ref={contextRef} data-prototype-context="" className="sticky top-0 z-[2] flex flex-col gap-1.5 bg-raised px-4 py-1">
              <p data-prototype-context-line="" className="m-0 text-label text-muted"><span className="font-semibold text-secondary">{round?.title ?? ""}</span>{round ? " · " : ""}{taskTitle}</p>
              {roundTabs}
              {waitingBody || !hasVariants ? null : variantChips}
            </div>
            {waitingBody ?? (
              <>
                {hasVariants ? gallery : null}
                {questionBlock}
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
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("proto.dialogAria", { title: taskTitle })} tabIndex={-1} className={`relative flex h-[min(88vh,960px)] ${hasQuestions ? hasVariants ? "w-[min(1560px,calc(100vw-48px))]" : "w-[min(760px,calc(100vw-48px))]" : "w-[min(1240px,calc(100vw-48px))]"} min-h-0 flex-col overflow-hidden rounded-surface border border-border bg-card shadow-2 outline-none`}>
        {viewer ? null : <DialogLayer containerRef={dialog} onClose={requestClose} />}
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          {hasQuestions ? <MessageCircleQuestionMark className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : <GalleryHorizontalEnd className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
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
            {hasVariants ? <aside aria-label={t("proto.variants")} className="flex w-[264px] shrink-0 flex-col border-r border-border">
              <p className="m-0 flex shrink-0 items-baseline gap-1.5 px-3 pb-1 pt-2.5 text-label font-semibold text-secondary">
                {t("proto.variants")} <span className="text-caption tabular-nums text-muted">{round?.variants.length ?? 0}</span>
              </p>
              <ul data-prototype-variants="" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-1.5">
                {round?.variants.map(variantRow)}
              </ul>
            </aside> : null}
            {hasVariants ? gallery : null}
            {questionBlock}
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
