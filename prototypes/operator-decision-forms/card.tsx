/*
 * The decision card: one form, the same component in every variant and on
 * both devices. Its question rows copy the classes of the prototype review
 * window's question block (src/components/prototypeReview/PrototypeReview.tsx,
 * `questionBlock`), so the build extracts that block into one shared
 * component, and nothing draws a second one. Differences from the window are
 * deliberate and listed in docs/design/operator-decision-forms.md §4.2: no
 * per-question box inside the card, a 36 px option row on a fine pointer
 * (44 px on touch, as today), and one primary button with no «Пропустити»,
 * because the recommended options are already chosen.
 */
import { Check, CircleCheck, GalleryHorizontalEnd, MessageCircleQuestionMark, Mic, ZoomIn } from "lucide-react";

import type { Copy, Question } from "./copy";

export type FormKind = "seat" | "proto";

const PRIMARY = "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control bg-accent px-3.5 text-ui font-semibold text-white hover:opacity-90 [@media(pointer:coarse)]:h-11";
const SECONDARY = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary [@media(pointer:coarse)]:h-11";

function QuestionRows({ question, at, copy, chosen }: { question: Question; at: number; copy: Copy; chosen: number }) {
  return (
    <fieldset data-dc-question={question.id} className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{question.text}</legend>
      <div className="mb-1.5 flex items-start gap-1.5">
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-caption font-bold text-secondary">{at + 1}</span>
        <p className="m-0 min-w-0 flex-1 text-ui font-semibold text-primary [overflow-wrap:anywhere]">{question.text}</p>
      </div>
      {question.multiple ? <p className="m-0 mb-1.5 text-label text-muted">{copy.multiple}</p> : null}
      <div role="radiogroup" aria-label={question.text} className="flex flex-col gap-1">
        {[...question.options.map((o, i) => ({ label: o.label, recommended: Boolean(o.recommended), i })), ...(question.other ? [{ label: copy.other, recommended: false, i: -1 }] : [])].map((option) => {
          const checked = option.i === chosen;
          return (
            <button
              key={option.i}
              type="button"
              role="radio"
              aria-checked={checked}
              data-dc-option=""
              className={`flex min-h-9 w-full items-center gap-2 rounded-control border px-2.5 py-1.5 text-left text-ui [@media(pointer:coarse)]:min-h-11 ${checked ? "border-accent/50 bg-accent-soft text-accent" : "border-border bg-canvas text-primary"}`}
            >
              <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${checked ? "border-accent bg-accent text-white" : "border-border bg-sunken"}`}>{checked ? <Check className="h-3.5 w-3.5" /> : null}</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
              {option.recommended ? <span data-dc-recommended="" className="shrink-0 whitespace-nowrap rounded-full bg-sunken px-1.5 py-0.5 text-caption font-semibold text-secondary">{copy.recommended}</span> : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Numbered previews of a prototype round: the first frame of each variant,
    opening the existing review window (which keeps full-size comparison). */
function Thumbs({ copy, phone, narrow, variants }: { copy: Copy; phone: boolean; narrow: boolean; variants: Array<{ n: number; name: string }> }) {
  const w = phone || narrow ? 150 : 176;
  const h = Math.round(w * 0.6);
  return (
    <div data-dc-thumbs="" className="flex min-w-0 items-end gap-2">
      {variants.map((v) => (
        <figure key={v.n} className="m-0 flex shrink-0 flex-col gap-1">
          <span className="relative block overflow-hidden rounded-control border border-border bg-sunken" style={{ width: w, height: h }}>
            <img data-dc-thumb={v.n} src={`thumbs/v${v.n}.png`} alt="" style={{ width: w, height: h, maxWidth: "none" }} className="block object-cover object-top" />
            <span className="absolute left-1 top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-accent px-1 text-caption font-bold text-white">{v.n}</span>
            <ZoomIn aria-hidden className="absolute bottom-1 right-1 h-4 w-4 rounded-sm bg-card/90 p-0.5 text-secondary" />
          </span>
          <figcaption className="truncate text-label text-secondary" style={{ maxWidth: w }}>{v.name}</figcaption>
        </figure>
      ))}
      {phone || narrow ? null : <button type="button" className={`${SECONDARY} mb-5 ml-1`}><GalleryHorizontalEnd className="h-3.5 w-3.5" aria-hidden />{copy.openPrototypes}</button>}
    </div>
  );
}

export function DecisionCard({ kind, copy, phone, columns = 1, time, answered = false, stepper, framed = true, headless = false, scroll = false, subject = false, narrow = false }: {
  kind: FormKind;
  copy: Copy;
  phone: boolean;
  /** Questions side by side: the desktop feed has room for two. */
  columns?: 1 | 2;
  time: string;
  answered?: boolean;
  /** Variant 2's dock: «1 з 3» and the arrows between open forms. */
  stepper?: React.ReactNode;
  framed?: boolean;
  /** Inside the strip's opened row, which already names the form. */
  headless?: boolean;
  /** Variant 2's dock: the questions scroll, the footer never yields. */
  scroll?: boolean;
  /** The card a frame is about: render.ts measures this one. */
  subject?: boolean;
  /** A 380 px column: the title keeps the room, the source line goes. */
  narrow?: boolean;
}) {
  const form = kind === "seat" ? copy.seatForm : copy.protoForm;
  const Mark = kind === "seat" ? MessageCircleQuestionMark : GalleryHorizontalEnd;
  const source = kind === "seat" ? copy.fromSeat : `${copy.fromLane} ${copy.protoForm.lane} · ${copy.variantsCount(copy.protoForm.variants.length)}`;
  if (answered) {
    return (
      <section data-decision-card="answered" className="min-w-0 rounded-surface border border-border bg-card">
        <header className="flex min-w-0 items-center gap-1.5 px-3 py-2">
          <CircleCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
          <span className="shrink-0 text-ui font-semibold text-primary">{copy.answeredAt(time)}</span>
          <span className="min-w-0 flex-1 truncate text-label text-muted">· {form.title}</span>
          <span className="shrink-0 rounded-full bg-success-soft px-1.5 py-0.5 text-caption font-semibold text-success">{copy.delivered}</span>
        </header>
        <ol className="m-0 flex list-none flex-col gap-1 px-3 pb-2.5 pl-3">
          {form.questions.map((q, at) => (
            <li key={q.id} className="flex min-w-0 items-start gap-1.5 text-ui">
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-caption font-bold text-secondary">{at + 1}</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="text-secondary">{q.text} </span>
                <span className="font-semibold text-accent">{q.options[0]!.label}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    );
  }
  return (
    <section data-decision-card="open" {...(subject ? { "data-dc-subject": "" } : {})} className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-card ${framed ? "rounded-surface border border-accent/40 shadow-1" : ""} ${scroll ? "flex-1" : ""}`}>
      {headless ? null : <header className="flex min-w-0 items-center gap-1.5 border-b border-border bg-accent-soft/60 px-3 py-2">
        <Mark className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span data-dc-title="" className="min-w-0 truncate text-ui font-semibold text-primary">{form.title}</span>
        {narrow ? null : <span className="hidden min-w-0 shrink truncate text-label text-muted sm:inline">· {source}</span>}
        <span className="flex-1" />
        {stepper ?? <time className="shrink-0 text-caption tabular-nums text-muted">{time}</time>}
      </header>}
      <div data-dc-body="" className={scroll ? "min-h-0 flex-1 overflow-y-auto" : ""}>
        {kind === "proto" ? <div className="px-3 pt-3"><Thumbs copy={copy} phone={phone} narrow={narrow} variants={copy.protoForm.variants} /></div> : null}
        <div className={`grid gap-3 px-3 pt-3 ${columns === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {form.questions.map((q, at) => <QuestionRows key={q.id} question={q} at={at} copy={copy} chosen={q.options.findIndex((o) => o.recommended)} />)}
        </div>
        {scroll ? <div className="h-3" /> : null}
      </div>
      <footer data-dc-footer="" className={`flex min-w-0 shrink-0 items-center gap-2 p-3 ${scroll ? "border-t border-border" : ""}`}>
        <span className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-control border border-border bg-canvas pl-2.5 pr-1 [@media(pointer:coarse)]:h-11">
          <span className="min-w-0 flex-1 truncate text-body text-muted">{copy.commentPlaceholder}</span>
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted"><Mic className="h-4 w-4" aria-hidden /></span>
        </span>
        <button type="button" data-dc-send="" className={PRIMARY}>{copy.send}</button>
      </footer>
    </section>
  );
}
