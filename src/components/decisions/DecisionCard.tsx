"use client";

import { CircleCheck, GalleryHorizontalEnd, Loader2, MessageCircleQuestionMark, RotateCw, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ImageGalleryProvider, Lightbox, type GalleryImage } from "@/components/feed/Lightbox";
import { Check, ChevronDown } from "@/components/icons";
import { MicButtonView } from "@/components/MicButton";
import { currentDecisionDraft, initialDraft, saveDecisionDraft, useStoredDecisionDraft, type Draft } from "@/components/prototypeReview/decisionDrafts";
import { DecisionQuestions, selectPrototypeAnswer } from "@/components/prototypeReview/DecisionQuestions";
import { roundGallery } from "@/components/prototypeReview/PrototypeReview";
import { PrototypeTelegramActions } from "@/components/prototypeReview/PrototypeTelegramActions";
import { useDictation } from "@/hooks/useDictation";
import { openPrototypeReview } from "@/hooks/usePrototypeReview";
import { useLocale, type TFunction } from "@/lib/i18n";
import { normalizePrototypeAnswers } from "@/lib/prototypeReview/questions";
import type { OperatorDecisionView } from "@/lib/prototypeReview/types";

import type { DecisionAnswer } from "./useOperatorDecisions";

/*
 * One operator decision as a form (docs/design/operator-decision-forms.md
 * §2.4–§2.6): the round's title, where it comes from and when; for a
 * prototype round its numbered first frames; its questions with the
 * recommended answer already chosen; one comment with the microphone, and
 * «Відповісти». The card is the box, so its questions stand bare. A round
 * with variants and no questions is decided in the review window; the card
 * shows its frames and opens the window.
 */

const PRIMARY = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3.5 text-ui font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-45 [@media(pointer:coarse)]:h-11";
const SECONDARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-11";

/** A moment as the column writes it: the hours and minutes. */
export const decisionClock = (at: string, locale: string) => new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));

function source(t: TFunction, decision: OperatorDecisionView): string {
  if (decision.nativeAssociationState) return t("decisions.fromNative");
  return decision.taskId === null ? t("decisions.fromSeat") : t("decisions.fromTask", { title: decision.taskTitle ?? decision.taskId });
}

/** The first frame of each variant, numbered; a press opens the review
    window, or for a seat's round, which has no window, the full-screen viewer
    over the round's frames. The form stays open under it with its draft. */
function Thumbs({ decision, small }: { decision: OperatorDecisionView; small: boolean }) {
  const { t } = useLocale();
  const [viewer, setViewer] = useState<{ image: GalleryImage; gallery: GalleryImage[] } | null>(null);
  const w = small ? 150 : 176;
  const h = Math.round(w * 0.6);
  const open = (number?: number) => {
    if (decision.taskId !== null) {
      openPrototypeReview({ kind: "prototype-review", taskId: decision.taskId, reviewId: decision.id, from: "notice" });
      return;
    }
    const gallery = roundGallery(t, decision);
    const first = decision.variants.find((variant) => variant.number === number)?.frames.find((entry) => entry.image.available && entry.image.url)?.image.url;
    const image = gallery.find((entry) => entry.src === first) ?? gallery[0];
    if (image) setViewer({ image, gallery });
  };
  const opens = decision.taskId !== null || decision.variants.some((variant) => variant.frames.some((entry) => entry.image.available && entry.image.url));
  return (
    <div data-decision-thumbs="" className="flex min-w-0 flex-wrap items-end gap-2">
      {decision.variants.map((variant) => {
        const frame = variant.frames.find((entry) => entry.image.available && entry.image.url);
        const zooms = decision.taskId !== null || Boolean(frame);
        const picture = (
          <span className="relative block overflow-hidden rounded-control border border-border bg-sunken" style={{ width: w, height: h }}>
            {frame?.image.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a stored prototype frame served by the review's own route
              <img data-decision-thumb={variant.number} src={frame.image.url} alt="" style={{ width: w, height: h, maxWidth: "none" }} className="block object-cover object-top" />
            ) : null}
            <span className="absolute left-1 top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-accent px-1 text-caption font-bold text-white">{variant.number}</span>
            {zooms ? <ZoomIn aria-hidden className="absolute bottom-1 right-1 h-4 w-4 rounded-sm bg-card/90 p-0.5 text-secondary" /> : null}
          </span>
        );
        return (
          <figure key={variant.number} className="m-0 flex shrink-0 flex-col gap-1">
            {zooms ? (
              <button type="button" data-decision-thumb-open={variant.number} className="rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label={t("decisions.thumbAria", { n: variant.number, name: variant.name })} onClick={() => open(variant.number)}>
                {picture}
              </button>
            ) : picture}
            <figcaption className="truncate text-label text-secondary" style={{ maxWidth: w }}>{variant.name}</figcaption>
          </figure>
        );
      })}
      {opens && !small ? (
        <button type="button" data-decision-open-prototypes="" className={`${SECONDARY} mb-5 ml-1`} onClick={() => open()}>
          <GalleryHorizontalEnd className="h-3.5 w-3.5" aria-hidden />{t("decisions.openPrototypes")}
        </button>
      ) : null}
      {viewer ? (
        <ImageGalleryProvider value={() => viewer.gallery}>
          <Lightbox src={viewer.image.src} alt={viewer.image.alt} caption={viewer.image.caption} detail={viewer.image.detail} onClose={() => setViewer(null)} />
        </ImageGalleryProvider>
      ) : null}
    </div>
  );
}

/** A decision folded to its title: a press opens its form. */
export function DecisionRow({ decision, onOpen }: { decision: OperatorDecisionView; onOpen: () => void }) {
  const { t } = useLocale();
  const Mark = decision.questions?.length ? MessageCircleQuestionMark : GalleryHorizontalEnd;
  return (
    <button
      type="button"
      data-decision-row={decision.id}
      aria-expanded={false}
      aria-label={t("decisions.expandAria", { title: decision.title })}
      className="flex min-h-11 w-full min-w-0 shrink-0 items-center gap-2 rounded-surface border border-border bg-card px-3 text-left hover:border-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={onOpen}
    >
      <Mark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
      <span className={`min-w-0 flex-1 text-ui font-semibold text-primary ${decision.decision ? "[overflow-wrap:anywhere]" : "truncate"}`}>{decision.title}</span>
      {decision.decision ? <span data-decision-delivery={decision.decision.delivery.state} className="shrink-0 text-caption font-semibold text-warning">{t(decision.decision.delivery.phase === "attention" && decision.decision.delivery.state === "pending" ? "decisions.state.failed" : `decisions.state.${decision.decision.delivery.state}`)}</span> : null}
      <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    </button>
  );
}

export function DecisionCard({ decision, narrow = false, columns = 1, onAnswer, error }: {
  decision: OperatorDecisionView;
  /** A column narrower than the card's own design: the title keeps the room
      and the source line goes, the frames draw smaller. */
  narrow?: boolean;
  /** Questions side by side, where the card is at least 600 px wide. */
  columns?: 1 | 2;
  onAnswer: (reviewId: string, answer: DecisionAnswer) => Promise<boolean>;
  /** The server's refusal of the last answer, said under the button. */
  error?: string | null;
}) {
  const { t, locale } = useLocale();
  const questions = decision.questions ?? [];
  const asks = questions.length > 0;
  /* The draft lives in the store as the operator types, so the form comes back
     as they left it after a refusal, a fold, a tab switch or a reload, and the
     review window of the same round shows the same words. */
  const stored = useStoredDecisionDraft(decision);
  const { answers, comment, reject, chosen } = stored ?? initialDraft(decision);
  const latest = useRef(decision);
  useEffect(() => { latest.current = decision; }, [decision]);
  const edit = useCallback((change: (held: Draft) => Draft) => {
    const own = latest.current;
    saveDecisionDraft(own, change(currentDecisionDraft(own)));
  }, []);
  const [sending, setSending] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const insertSpoken = useCallback((spoken: string) => {
    edit((held) => ({ ...held, comment: held.comment ? `${held.comment.trimEnd()} ${spoken}` : spoken }));
    setVoiceError(null);
    requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  }, [edit]);
  const dictation = useDictation({ onError: setVoiceError, onUnclaimedText: insertSpoken, onLiveCommit: insertSpoken });
  const recording = dictation.phase === "rec";
  const shown = dictation.liveText ? (comment ? `${comment.trimEnd()} ` : "") + dictation.liveText : comment;
  let valid = asks;
  if (asks) {
    try { normalizePrototypeAnswers(questions, answers, comment); } catch { valid = false; }
  }
  const savable = valid && (!reject || Boolean(comment.trim())) && !sending && dictation.phase === "idle";
  const send = async () => {
    if (!savable) return;
    setSending(true);
    try { await onAnswer(decision.id, { chosen: reject ? [] : chosen, comment, answers, ...(reject ? { reject: true as const } : {}) }); }
    finally { setSending(false); }
  };
  const Mark = asks ? MessageCircleQuestionMark : GalleryHorizontalEnd;
  return (
    <section
      data-decision-card="open"
      data-decision-review={decision.id}
      aria-label={decision.title}
      className="flex min-w-0 shrink-0 flex-col overflow-hidden rounded-surface border border-accent/40 bg-card shadow-1"
    >
      <header className="flex min-w-0 items-start gap-1.5 border-b border-border bg-accent-soft/60 px-3 py-2">
        <Mark className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span data-decision-title="" className="min-w-0 [overflow-wrap:anywhere] text-ui font-semibold text-primary" title={decision.title}>{decision.title}</span>
        {narrow ? null : <span data-decision-source="" className="mt-px min-w-0 shrink truncate text-label text-muted">· {source(t, decision)}</span>}
        <span className="flex-1" />
        <time dateTime={decision.createdAt} className="mt-0.5 shrink-0 text-caption tabular-nums text-muted">{decisionClock(decision.createdAt, locale)}</time>
      </header>
      {narrow && decision.taskId !== null ? <p data-decision-source="" className="m-0 px-3 pt-2 text-label text-muted [overflow-wrap:anywhere]">{source(t, decision)}</p> : null}
      {decision.variants.length ? <div className="px-3 pt-3"><Thumbs decision={decision} small={narrow} /></div> : null}
      {asks ? (
        <div className="flex flex-col gap-3 px-3 pt-3" data-prototype-questions="">
          <DecisionQuestions questions={questions} answers={answers} open={!sending} boxed={false} columns={columns}
            onSelect={(questionId, option) => edit((held) => ({ ...held, answers: selectPrototypeAnswer(questions, held.answers, questionId, option) }))} />
        </div>
      ) : null}
      {asks ? (
        <footer data-decision-footer="" className="flex min-w-0 flex-col gap-1.5 p-3">
          <PrototypeTelegramActions key={decision.id} round={decision} disabled={sending} />
          {decision.variants.length ? (
            <button type="button" role="checkbox" aria-checked={reject} data-decision-reject="" disabled={sending}
              className={`${SECONDARY} self-start ${reject ? "border-warning/60 bg-warning-soft text-warning" : ""}`} onClick={() => edit((held) => ({ ...held, reject: !held.reject, chosen: [] }))}>
              <span aria-hidden className="grid h-4 w-4 place-items-center rounded-sm border border-current">{reject ? <Check className="h-3 w-3" /> : null}</span>{t("proto.reject.none")}
            </button>
          ) : null}
          <div className="flex min-w-0 items-end gap-2">
            <div className={`flex min-w-0 flex-1 rounded-control border border-border bg-canvas focus-within:border-accent/60 ${recording ? "flex-col gap-1.5 p-2" : "items-center gap-1 py-0.5 pl-2.5 pr-1"}`}>
              <textarea
                ref={field}
                rows={1}
                value={shown}
                readOnly={Boolean(dictation.liveText)}
                data-decision-comment=""
                aria-label={t("proto.comment")}
                placeholder={t(reject ? "proto.reject.needs" : "proto.q.commentPlaceholder")}
                className={`max-h-32 min-h-8 resize-none bg-transparent py-1 text-body text-primary outline-none placeholder:text-muted [field-sizing:content] [@media(pointer:coarse)]:min-h-10 ${recording ? "w-full" : "min-w-0 flex-1"}`}
                onChange={(event) => edit((held) => ({ ...held, comment: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
                }}
              />
              <span className={recording ? "self-end" : "shrink-0"}>
                <MicButtonView {...dictation} start={dictation.start} busy={sending} onText={insertSpoken} anchored />
              </span>
            </div>
            <button type="button" data-decision-send="" className={reject ? PRIMARY.replace("bg-accent", "bg-warning").replace("text-white", "text-canvas").replace("ring-accent", "ring-warning") : PRIMARY} disabled={!savable} onClick={() => void send()}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {t(reject ? "proto.reject.save" : "proto.answer")}
            </button>
          </div>
          {reject && !comment.trim() ? <p role="status" data-decision-reject-needs="" className="m-0 text-label text-warning">{t("proto.reject.needs")}</p> : null}
          {!valid ? <p role="status" className="m-0 text-label text-muted">{t(answers.some((answer) => answer.other) && !comment.trim() ? "proto.q.otherNeedsComment" : "proto.q.answerAll")}</p> : null}
          {error ? <p role="alert" data-decision-error="" className="m-0 text-label font-semibold text-danger">{t("decisions.refused", { error })}</p> : null}
          {voiceError ? <p role="alert" className="m-0 text-label font-semibold text-danger">{voiceError}</p> : null}
        </footer>
      ) : <div className="h-3" />}
    </section>
  );
}

/** The answer where it was asked: each question with the answer chosen, the
    time of the answer and whether the seat has it. A message that did not
    reach the seat offers to send it again from here: a seat's own question has
    no task card and no review window to retry from (§2.4). */
export function DecisionRecord({ decision, onRetry, retrying = false, retryError = null, onRevoke, revokeError = null }: {
  decision: OperatorDecisionView;
  /** Sends the saved message again; absent where the record cannot. */
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
  onRevoke?: () => Promise<boolean>;
  revokeError?: string | null;
}) {
  const { t, locale } = useLocale();
  const made = decision.decision;
  if (!made) return null;
  const state = made.delivery.state;
  const retry = !decision.nativeAssociationState && onRetry && made.delivery.retryable && (made.delivery.phase === "attention" || state !== "pending" && state !== "sent");
  const attention = made.delivery.phase === "attention";
  const tone = decision.nativeAssociationState === "approved" || state === "sent" ? "bg-success-soft text-success" : state === "pending" && !attention ? "bg-sunken text-secondary" : "bg-warning-soft text-warning";
  return (
    <section data-decision-card="answered" data-decision-review={decision.id} aria-label={t("decisions.recordAria", { title: decision.title })} className="min-w-0 rounded-surface border border-border bg-card">
      <header className="flex min-w-0 flex-wrap items-start gap-1.5 px-3 py-2">
        <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
        <span className="shrink-0 text-ui font-semibold text-primary">{t("decisions.answeredAt", { time: decisionClock(made.at, locale) })}</span>
        <span data-decision-record-title="" className="order-last min-w-0 basis-full text-ui font-semibold text-primary [overflow-wrap:anywhere]">{decision.title}</span>
        <span data-decision-delivery={state} className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-caption font-semibold ${tone}`}>{t(decision.nativeAssociationState === "approved" ? "decisions.accessApproved" : decision.nativeAssociationState === "refused" ? "decisions.accessRefused" : attention && state === "pending" ? "decisions.state.failed" : `decisions.state.${state}`)}</span>
      </header>
      {made.rejected ? <p data-decision-rejected="" className="m-0 px-3 pb-2.5 text-ui font-semibold text-warning">{t("proto.rejected")}</p> : null}
      {decision.questions?.length ? (
        <ol className="m-0 flex list-none flex-col gap-1 px-3 pb-2.5">
          {decision.questions.map((question, at) => {
            const answer = made.answers?.find((entry) => entry.questionId === question.id);
            const chosen = [...(answer?.options ?? []).map((index) => question.options[index]?.label ?? ""), ...(answer?.other ? [t("proto.q.other")] : [])].filter(Boolean).join(", ");
            return (
              <li key={question.id} className="flex min-w-0 items-start gap-1.5 text-ui">
                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-caption font-bold text-secondary">{at + 1}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="text-secondary">{question.text} </span>
                  {answer?.skipped ? <span data-decision-record-skipped={question.id} className="font-semibold text-muted">{t("proto.q.skippedShort")}</span> : <span className="font-semibold text-accent">{chosen}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {made.comment ? <p data-decision-record-comment="" className="m-0 whitespace-pre-wrap break-words px-3 pb-2.5 text-ui text-primary">{made.comment}</p> : null}
      <footer className="flex min-w-0 flex-col gap-2 px-3 pb-2.5">
        {decision.nativeAssociationState === "approved" && onRevoke ? <button type="button" data-native-association-revoke="" className={`${SECONDARY} min-h-11`} onClick={() => void onRevoke()}>{t("decisions.revokeAccess")}</button> : null}
        {revokeError ? <p role="alert" className="m-0 min-w-0 text-label font-semibold text-danger">{t("decisions.revokeFailed", { error: revokeError })}</p> : null}
        {!decision.nativeAssociationState ? <PrototypeTelegramActions key={decision.id} round={decision} disabled={retrying} /> : null}
        {retry ? (
          <button type="button" data-decision-retry="" className={SECONDARY} disabled={retrying} onClick={onRetry}>
            {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
            {t(state === "no-orchestrator" ? "proto.delivery.sendNow" : "proto.delivery.retry")}
          </button>
        ) : null}
        {retryError ? <p role="alert" data-decision-retry-error="" className="m-0 min-w-0 text-label font-semibold text-danger">{t("decisions.retryFailed", { error: retryError })}</p> : null}
      </footer>
    </section>
  );
}
