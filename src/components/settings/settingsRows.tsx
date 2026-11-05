"use client";

import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";

import { MobileSheetSection } from "@/components/mobile/MobileSheet";
import { SettingSwitch } from "@/components/ProjectSettingRow";
import { Select } from "@/components/ui/Select";
import { useLocale } from "@/lib/i18n";

import { StatusDot, type DotTone } from "./StatusDot";

/*
 * The rows every section of the Settings window is made of: one language, two
 * densities (docs/design/settings-redo/build-brief.md §3). A row with a chevron
 * opens a page in the section's place; a status is a dot with a short popover;
 * a key is a row that opens «Keys»; every technical value stays behind one
 * collapsed «Details» row and no bordered box stands inside the surface.
 */

export type Density = "dialog" | "sheet";
const DensityContext = createContext<Density>("dialog");
export const SettingsDensity = DensityContext;
export const useDensity = () => useContext(DensityContext);

type Data = Record<`data-${string}`, string | undefined> & { id?: string };

const DENSITY: Record<Density, { box: string; boxHint: string; label: string; hint: string; pad: string; section: string; pick: string }> = {
  dialog: { box: "min-h-10 px-5 py-1.5", boxHint: "min-h-10 px-5 py-1.5", label: "text-body", hint: "text-ui", pad: "px-5", section: "px-5 pt-3 pb-1 text-label", pick: "w-56" },
  /* A row with a line under its label keeps its first line where a row of one line has it: every dot then has a whole 44 px target. */
  sheet: { box: "min-h-11 px-4 py-1.5", boxHint: "min-h-11 px-4 pt-3 pb-1.5", label: "text-body", hint: "text-ui", pad: "px-4", section: "", pick: "w-48" },
};
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
export const BUTTON = `min-h-9 rounded-control border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 settings-sheet:min-h-11 settings-sheet:text-body ${FOCUS}`;
export const PRIMARY = `min-h-9 rounded-control bg-brand px-3 text-ui font-semibold text-on-brand disabled:cursor-not-allowed disabled:opacity-45 settings-sheet:min-h-11 settings-sheet:text-body ${FOCUS}`;
/* The product's warning button (TelegramFileConfirmation): the secondary's shape, the warning colour on the surface. */
export const CAUTION = `min-h-9 rounded-control border border-warning bg-card px-3 text-ui font-semibold text-warning hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 settings-sheet:min-h-11 settings-sheet:text-body ${FOCUS}`;
export const DANGER_TEXT = `min-h-9 px-1 first:-ml-1 font-semibold text-danger underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-45 settings-sheet:min-h-11 text-body ${FOCUS}`;
export const FIELD = `min-h-9 w-full min-w-0 rounded-control border border-border bg-well px-2.5 text-body text-primary placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-55 settings-sheet:min-h-11 ${FOCUS}`;

/** The rows of one page. Its foot keeps 16 px under an open «Details» at the end of the surface. */
export function Rows({ children, ...data }: { children: ReactNode } & Data) {
  const sheet = useDensity() === "sheet";
  return <div {...data} data-settings-rows="" className={`flex flex-1 flex-col break-words pb-4 font-normal ${sheet ? "pt-1" : "pt-2"}`}>{children}</div>;
}

/** A heading under the page's own: the window's page title is an h3, the sheet's page title stands in its back row under the h2. */
export function SectionHead({ title, count }: { title: string; count?: number }) {
  const density = useDensity();
  return density === "sheet"
    ? <div role="heading" aria-level={3} data-settings-unit="" data-settings-section=""><MobileSheetSection count={count}>{title}</MobileSheetSection></div>
    : (
      <h4 data-settings-unit="" data-settings-section="" className={`flex items-center gap-1.5 font-semibold text-secondary ${DENSITY.dialog.section}`}>
        {title}{count !== undefined ? <span className="text-caption font-semibold tabular-nums text-muted">{count}</span> : null}
      </h4>
    );
}

/** A label and its muted line are one block; the switch stands centred beside it. */
export function SwitchRow({ label, hint, enabled, blocked, disabled, onToggle, onPressStart, attrs, switchAttrs, children }: {
  label: string;
  hint?: ReactNode;
  enabled: boolean;
  blocked?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** Before the blur of a field the press takes focus from. */
  onPressStart?: () => void;
  attrs?: Data;
  switchAttrs?: Data;
  /** What belongs under the row: its refusal, read where the press was. */
  children?: ReactNode;
}) {
  const density = useDensity();
  const d = DENSITY[density];
  const hintId = useId();
  return (
    <div {...attrs} data-settings-unit="">
      {/* On a landscape phone the switch stands on the label's line, so a short screen can end under that line. */}
      <div data-settings-unit="" className={`flex items-center gap-3 ${density === "sheet" && hint ? "landscape:items-start" : ""} ${d.box}`} data-settings-row="switch">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span data-settings-line="" className={`font-semibold text-primary ${d.label}`}>{label}</span>
          {hint ? <span id={hintId} className={`block font-normal leading-snug text-muted ${d.hint}`}>{hint}</span> : null}
        </span>
        {/* The sheet's switch centres a 36 px track in a 48 px target: the row gives it those 6 px back, so its track ends on the edge a select and a chevron end on. */}
        <SettingSwitch enabled={enabled} blocked={blocked} disabled={disabled} size={density === "sheet" ? "sheet" : "row"} className={density === "sheet" ? `-mr-1.5 ${hint ? "landscape:-mt-2" : ""}` : ""} aria-label={label} aria-describedby={hint ? hintId : undefined} onPointerDown={onPressStart} onClick={onToggle} {...switchAttrs} />
      </div>
      {children}
    </div>
  );
}

export interface ChoiceOption { value: string; label: string; disabled?: boolean }

/**
 * A choice on the phone: a touch screen draws every field at 16 px (globals.css,
 * so iOS does not zoom), which would make the value the loudest text on the
 * sheet. The value shows at the row's size in the select's own face, and the
 * app's `Select` lies over that face, transparent and 44 px tall.
 */
function SheetChoice({ label, value, options, width, disabled, onChange, selectAttrs, describedBy, id }: {
  label?: string; value: string; options: readonly ChoiceOption[]; width: string; disabled?: boolean; onChange: (value: string) => void; selectAttrs?: Data; describedBy?: string; id?: string;
}) {
  const current = options.find((option) => option.value === value)?.label ?? "";
  return (
    <span className={`relative flex h-8 shrink-0 items-center gap-1 rounded-control border border-border bg-card pl-2 pr-1.5 text-body text-primary has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-accent/40 ${disabled ? "opacity-60" : ""} ${width}`}>
      <span data-settings-choice-face="" className="min-w-0 flex-1 truncate">{current}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <Select id={id} value={value} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} className="absolute inset-x-0 top-1/2 -translate-y-1/2 cursor-pointer opacity-0" style={{ height: 44 }} {...selectAttrs}>
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </Select>
    </span>
  );
}

/** The label on the left, the value on the right at one width per group; the muted line spans the row under both. */
export function ChoiceRow({ label, ariaLabel = label, hint, value, options, disabled, onChange, attrs, selectAttrs, describedBy, id, labelNode, wide = false, children }: {
  label: string;
  /** What a screen reader hears when the label alone would not say it. */
  ariaLabel?: string;
  hint?: ReactNode;
  value: string;
  options: readonly ChoiceOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  attrs?: Data;
  selectAttrs?: Data;
  describedBy?: string;
  id?: string;
  /** A label drawn otherwise than plain, such as one a `<label>` ties to the select. */
  labelNode?: ReactNode;
  /** Values as long as a device's name: in the window and on a landscape phone the select takes two thirds of the row, so the name reads whole. */
  wide?: boolean;
  children?: ReactNode;
}) {
  const density = useDensity();
  const d = DENSITY[density];
  return (
    <div {...attrs} data-settings-unit="">
      <div data-settings-unit="" className={`flex flex-col justify-center gap-0.5 ${d.box} ${hint ? "" : "pb-2"}`} data-settings-row="choice">
        <div data-settings-line="" className="flex items-center gap-3">
          <span title={label} className={`min-w-0 flex-1 truncate font-semibold text-primary ${d.label}`}>{labelNode ?? label}</span>
          {density === "sheet"
            ? <SheetChoice label={ariaLabel} value={value} options={options} width={wide ? `${d.pick} landscape:w-2/3` : d.pick} disabled={disabled} onChange={onChange} selectAttrs={selectAttrs} describedBy={describedBy} id={id} />
            : (
              <Select roomy id={id} value={value} disabled={disabled} aria-label={ariaLabel} aria-describedby={describedBy} className={`shrink-0 ${wide ? "w-2/3" : d.pick}`} onChange={(event) => onChange(event.target.value)} {...selectAttrs}>
                {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
              </Select>
            )}
        </div>
        {hint ? <span className={`block font-normal leading-snug text-muted ${d.hint}`}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export interface RowDot { tone: DotTone; note: string }

/**
 * A row with a label, a short muted word and a chevron when it opens something.
 * The row is a `<div>` holding the row's button and the dot's button as
 * siblings, so no control sits inside another; the dot lies over the slot the
 * row's first line keeps for it. A row with no `onOpen` is still, and keeps the
 * chevron's slot, so every status in a list ends on one edge.
 */
export function LinkRow({ label, hint, value, dot, onOpen, attrs, buttonAttrs, sub, children }: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  dot?: RowDot;
  onOpen?: () => void;
  attrs?: Data;
  buttonAttrs?: Data;
  /** The page this row opens: back from it returns focus here. */
  sub?: string;
  children?: ReactNode;
}) {
  const density = useDensity();
  const d = DENSITY[density];
  const sheet = density === "sheet";
  const unit = useRef<HTMLDivElement | null>(null);
  const body = (
    <>
      <span data-settings-line="" className="flex w-full items-center gap-2">
        {dot ? <span aria-hidden className="block h-[7px] w-[7px] shrink-0" /> : null}
        <span data-settings-row-label="" className={`min-w-0 flex-1 truncate font-semibold text-primary ${d.label}`}>{label}</span>
        {value !== undefined && value !== null ? <span className={`shrink-0 font-medium text-muted ${d.hint}`} data-settings-row-value="">{value}</span> : null}
        {onOpen ? <ChevronRight data-settings-chevron="" className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : value !== undefined && value !== null ? <span className="w-4 shrink-0" aria-hidden /> : null}
      </span>
      {hint ? <span className={`block font-normal leading-snug text-muted ${d.hint}`}>{hint}</span> : null}
    </>
  );
  const shape = `flex w-full flex-col justify-center gap-0.5 text-left ${hint ? d.boxHint : d.box}`;
  /* The dot's target stands on the first line's centre, 44 px on the phone and reaching into the row's padding. */
  const dotTop = sheet ? "top-0 h-11 w-11 pl-4" : hint ? "top-1 h-6 w-8 pl-5" : "top-2 h-6 w-8 pl-5";
  return (
    <div {...attrs} ref={unit} data-settings-unit="" className="relative">
      {onOpen
        ? <button type="button" data-settings-row="link" data-settings-sub={sub} onClick={onOpen} {...buttonAttrs} className={`${shape} hover:bg-sunken active:bg-sunken ${FOCUS}`}>{body}</button>
        : <div data-settings-row="link" {...buttonAttrs} className={shape}>{body}</div>}
      {dot ? <StatusDot tone={dot.tone} note={dot.note} label={typeof label === "string" ? label : ""} anchor={() => unit.current} hit={`absolute left-0 justify-start ${dotTop}`} /> : null}
      {children}
    </div>
  );
}

/** A value that may take two lines (a folder's path, a call's heading) and a text action at its end. */
export function ValueRow({ value, hint, action, attrs, children }: { value: ReactNode; hint?: ReactNode; action?: ReactNode; attrs?: Data; children?: ReactNode }) {
  const d = DENSITY[useDensity()];
  return (
    <div {...attrs} data-settings-unit="" className={`flex flex-col justify-center gap-0.5 ${d.box}`} data-settings-row="value">
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 font-semibold text-primary ${d.label}`}>{value}</span>
        {action}
      </div>
      {hint ? <span className={`block font-normal leading-snug text-muted ${d.hint}`}>{hint}</span> : null}
      {children}
    </div>
  );
}

/** A field beside its label on the row, or under it where the label would crowd it. */
export function FieldRow({ label, hint, children, attrs }: { label: ReactNode; hint?: ReactNode; children: ReactNode; attrs?: Data }) {
  const density = useDensity();
  const d = DENSITY[density];
  return (
    <div {...attrs} data-settings-unit="" data-settings-row="field" className={`flex flex-col justify-center gap-1 ${d.box}`}>
      <div className="flex items-center gap-3">
        <span className={`min-w-0 flex-1 font-semibold text-primary ${d.label}`}>{label}</span>
        <span className={`flex shrink-0 items-center gap-2 ${d.pick}`}>{children}</span>
      </div>
      {hint ? <span className={`block font-normal leading-snug text-muted ${d.hint}`}>{hint}</span> : null}
    </div>
  );
}

/**
 * A field on a row's line. On the sheet it wears the face of the select it stands
 * beside (`SheetChoice`): 32 px tall over a 44 px target, the row's type. A touch
 * screen draws a field at 16 px so iOS does not zoom (globals.css), so the input
 * is scaled to the row's size and keeps its 16 px for the browser.
 */
export function RowField({ desktopClass = "", ...input }: InputHTMLAttributes<HTMLInputElement> & Data & { desktopClass?: string }) {
  if (useDensity() !== "sheet") return <input {...input} className={`${FIELD} ${desktopClass}`} />;
  return (
    <span data-settings-field-face="" className={`relative block h-8 w-full min-w-0 overflow-visible rounded-control border border-border bg-well has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent/40 ${input.disabled ? "opacity-55" : ""}`}>
      <input {...input} className="absolute left-0 top-1/2 h-[50.3px] w-[114.286%] origin-left -translate-y-1/2 scale-[.875] bg-transparent pl-[9px] pr-2 text-body text-primary outline-none placeholder:text-muted disabled:cursor-not-allowed" />
    </span>
  );
}

/** A body of its own under a row: a form, a field that takes the whole width. */
export function BlockRow({ children, attrs }: { children: ReactNode; attrs?: Data }) {
  const d = DENSITY[useDensity()];
  return <div {...attrs} data-settings-unit="" className={`${d.pad} py-1.5`}>{children}</div>;
}

export const TEXT_ACTION = `min-h-6 shrink-0 px-1 font-semibold text-secondary underline underline-offset-2 hover:text-primary disabled:opacity-45 settings-sheet:min-h-11 text-ui ${FOCUS}`;

const TEXT_TONE = { muted: "text-muted", warning: "text-warning", danger: "text-danger", plain: "text-secondary" } as const;

/** A note is passive: the muted line's size, below the labels; a warning keeps the labels' size. */
export function TextRow({ children, tone = "plain", attrs, role }: { children: ReactNode; tone?: keyof typeof TEXT_TONE; attrs?: Data; role?: HTMLAttributes<HTMLElement>["role"] }) {
  const d = DENSITY[useDensity()];
  const size = tone === "warning" || tone === "danger" ? d.label : d.hint;
  return <p {...attrs} role={role} data-settings-unit="" data-settings-row="text" className={`font-normal leading-snug ${d.pad} py-1.5 ${TEXT_TONE[tone]} ${size}`}>{children}</p>;
}

/** A refusal, read beside the control that was pressed and brought into view. */
export function RefusalLine({ children, attrs }: { children: ReactNode; attrs?: Data }) {
  const line = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => { line.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  const d = DENSITY[useDensity()];
  return <p ref={line} role="alert" {...attrs} data-settings-unit="" className={`${d.pad} pb-1.5 text-ui leading-snug text-danger`}>{children}</p>;
}

/** The actions of a page, above a hairline; `foot` pushes them to the foot of a page on the phone. */
export function ActionsRow({ children, note, foot = false, attrs }: { children: ReactNode; note?: ReactNode; foot?: boolean; attrs?: Data }) {
  const d = DENSITY[useDensity()];
  return (
    <div {...attrs} data-settings-unit="" data-settings-row="actions" className={`mt-1 flex flex-col gap-2 border-t border-border pb-2 pt-3 ${d.pad} ${foot ? "settings-sheet:mt-auto" : ""}`}>
      <div data-settings-unit="" className="flex flex-wrap items-center gap-2">{children}</div>
      {note ? <span data-settings-unit="" className={`block font-normal leading-snug text-muted ${d.hint}`}>{note}</span> : null}
    </div>
  );
}

/** Arms on the first press and acts only on an explicit confirm, as `ConfirmingAction` does, at the rows' sizes. */
export function ConfirmAction({ label, prompt, onConfirm, disabled }: { label: string; prompt: string; onConfirm: () => void; disabled?: boolean }) {
  const { t } = useLocale();
  const [arming, setArming] = useState(false);
  const promptId = useId();
  const arm = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  /* The pressed button leaves the page: the keyboard lands on Cancel, the safe answer, and a cancel returns it to the button that armed. */
  const move = useRef<"in" | "back" | null>(null);
  useEffect(() => {
    if (move.current === "in") cancel.current?.focus();
    else if (move.current === "back") arm.current?.focus();
    move.current = null;
  }, [arming]);
  if (!arming) return <button ref={arm} type="button" disabled={disabled} onClick={() => { move.current = "in"; setArming(true); }} className={DANGER_TEXT}>{label}</button>;
  return (
    <span role="group" aria-labelledby={promptId} data-settings-confirm="" className="flex w-full flex-wrap items-center gap-2">
      <span id={promptId} role="alert" className="w-full text-ui font-semibold leading-snug text-danger">{prompt}</span>
      <button type="button" disabled={disabled} className={`${BUTTON} !border-danger !text-danger`} onClick={() => { setArming(false); onConfirm(); }}>{t("telegram.confirmCta")}</button>
      <button ref={cancel} type="button" disabled={disabled} className={BUTTON} onClick={() => { move.current = "back"; setArming(false); }}>{t("telegram.confirmCancel")}</button>
    </span>
  );
}

/* Above this a run of characters cannot be expected to fit a column at 390 px. */
const LONG_PART = 40;
const TAIL = 8;

/** A token wider than its column: the middle gives way, the DOM keeps the whole text for a copy and `title` shows it. */
function Elided({ text }: { text: string }) {
  return (
    <span className="inline-flex max-w-full align-bottom">
      <span className="min-w-0 truncate">{text.slice(0, -TAIL)}</span>
      <span className="shrink-0">{text.slice(-TAIL)}</span>
    </span>
  );
}

/**
 * A literal value in monospace. It stays whole: it moves to the next line where
 * it does not fit, and one too long for a line of its own breaks only after a
 * path's «/» or a «:», never inside a word and never at a NAME=value's «=»;
 * `after` is punctuation that stays on its line.
 */
export function Literal({ text, after }: { text: string; after?: string }) {
  const parts = text.split(/(?<=[/:])(?![/])/);
  return (
    <code title={text} data-settings-literal="" className="inline-block max-w-full align-bottom font-mono">
      {parts.map((part, at) => (
        <Fragment key={at}>
          {at ? <wbr /> : null}
          {part.length > LONG_PART ? <Elided text={part} /> : <span className="whitespace-nowrap">{part}</span>}
        </Fragment>
      ))}
      {after ? <span className="font-sans">{after}</span> : null}
    </code>
  );
}

/** Prose with its literal values marked by backticks. */
export function Prose({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, at) => {
        if (!(at % 2)) {
          /* Punctuation right after a literal stays with it. */
          const next = at > 0 ? part.match(/^[.,:;!?)]+/)?.[0] ?? "" : "";
          return <Fragment key={at}>{part.slice(next.length)}</Fragment>;
        }
        return <Literal key={at} text={part} after={parts[at + 1]?.match(/^[.,:;!?)]+/)?.[0]} />;
      })}
    </>
  );
}

/** Marks the NAME=value and domain tokens of a text that carries no backticks of its own. */
export function markLiterals(text: string): string {
  return text.replace(/[A-Z][A-Z0-9_]+=\S*?(?=[,.\s]*(?:\s|$))|[a-z0-9.-]+\.(?:org|com)(?:\/[^\s,]*)?/g, (token) => `\`${token}\``);
}

export interface DetailLine { label: string; value: ReactNode; attrs?: Data }

/** One collapsed row per page: every technical value, prose in the body face and only a literal in monospace. */
export function DetailsRow({ lines, attrs, initiallyOpen = false }: { lines: readonly (DetailLine | null | false | undefined)[]; attrs?: Data; initiallyOpen?: boolean }) {
  const { t } = useLocale();
  const d = DENSITY[useDensity()];
  const [open, setOpen] = useState(initiallyOpen);
  const fold = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (open && opened.current) fold.current?.scrollIntoView?.({ block: "nearest" });
    opened.current = true;
  }, [open]);
  const Arrow = open ? ChevronUp : ChevronDown;
  const shown = lines.filter((line): line is DetailLine => Boolean(line));
  return (
    <div ref={fold} {...attrs} data-settings-row="details" className="mt-1 border-t border-border pt-1">
      <button type="button" aria-expanded={open} data-settings-unit="" data-settings-details-toggle="" onClick={() => setOpen((was) => !was)} className={`flex w-full items-center text-left hover:bg-sunken active:bg-sunken ${FOCUS} ${d.box}`}>
        <span className={`min-w-0 flex-1 font-semibold text-primary ${d.label}`}>{t("settings.details")}</span>
        <Arrow data-settings-chevron="" className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? (
        <dl data-settings-details="" className={`flex flex-col gap-1.5 pb-0.5 pt-0.5 ${d.pad}`}>
          {shown.map((line, at) => (
            <div key={`${line.label}-${at}`} {...line.attrs} data-settings-unit="" className="flex flex-col gap-px">
              {line.label ? <dt className={`font-semibold text-muted ${d.hint}`}>{line.label}</dt> : null}
              <dd className="m-0 text-ui leading-snug text-primary">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** A page whose record is no longer there: the section again. */
export function Gone({ back }: { back: () => void }) {
  useEffect(() => { back(); }, [back]);
  return null;
}

/**
 * No line is cut by a scroll edge on the first screen or at the end of the
 * scroll: the scroller ends on the last whole row, and the end of the scroll
 * starts on a row's top. A hairline under the scroller says more rows follow.
 * `content` is any element inside the scroller; a new `page` fits before the
 * browser paints it, so what lands on a row reads the scroll it will keep.
 */
/* NodeFilter.SHOW_TEXT, which not every DOM a test runs in defines globally. */
const SHOW_TEXT = 4;

/** Lines of words under `root`, measured from the top of the scroller's content. */
function contentLines(scroller: HTMLElement, root: HTMLElement = scroller): { top: number; bottom: number }[] {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const lines: { top: number; bottom: number }[] = [];
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.textContent ?? "").trim() || node.parentElement?.closest("option, select")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const box of range.getClientRects?.() ?? []) if (box.width > 0 && box.height > 0) lines.push({ top: box.top - origin, bottom: box.bottom - origin });
  }
  return lines;
}

/**
 * A scroll position as near `desired` as rows allow: at or above it, with no line cut by the top edge or the
 * bottom one. A page the window lands on mid-scroll keeps the whole rows its first screen keeps.
 */
export function wholeRowsTop(scroller: HTMLElement, desired: number): number {
  const height = scroller.clientHeight;
  const want = Math.max(0, Math.min(desired, scroller.scrollHeight - height));
  const lines = contentLines(scroller);
  const cuts = (y: number) => lines.some((line) => line.top < y - 0.5 && line.bottom > y + 0.5);
  const fits = (top: number) => !cuts(top) && !cuts(top + height);
  if (fits(want)) return want;
  /* Every place where the top edge or the bottom one falls between lines, nearest first, within half a screen above. */
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const tops = [...scroller.querySelectorAll<HTMLElement>("[data-settings-unit]")].map((unit) => Math.floor(unit.getBoundingClientRect().top - origin));
  for (const line of lines) tops.push(Math.floor(line.top) - 1, Math.ceil(line.bottom), Math.ceil(line.bottom) - height, Math.floor(line.top) - 1 - height);
  for (const top of [...new Set(tops)].filter((top) => top <= want && top >= Math.max(0, want - height / 2)).sort((a, b) => b - a)) if (fits(top)) return top;
  return want;
}

/* What stays under the scroller's hairline, and the blank under it that a first screen does not keep. Below `SHORT`
   (a landscape phone) a row may end the screen after its first line, with its muted line on the next. */
const FOOT = 12;
const SHORT_FOOT = 4;
const BLANK_BAND = 48;
const SHORT = 360;

/** Whether the phone's voice head stands over the sheet: covered by this window, the room its stylesheet keeps is waste. */
function headOverSheet(): boolean {
  const head = document.querySelector<HTMLElement>("[data-phone-voice-head]");
  if (!head) return true;
  const box = head.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const top = document.elementFromPoint?.(box.left + box.width / 2, box.top + box.height / 2);
  return Boolean(top && head.contains(top));
}

export function useWholeRows(content: RefObject<HTMLElement | null>, page?: string): void {
  useLayoutEffect(() => {
    const inner = content.current;
    const scroller = inner?.closest<HTMLElement>("[data-settings-scroller], [data-mobile2-sheet-body]");
    if (!inner || !scroller) return;
    scroller.classList.add("no-scrollbar");
    const cue = () => { scroller.style.boxShadow = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1 ? "0 1px 0 var(--color-border)" : ""; };
    const fit = () => {
      const held = scroller.scrollTop;
      scroller.style.maxHeight = "";
      scroller.style.paddingBottom = "";
      /* A live voice head keeps room at a phone body's end through a stylesheet: what is added here comes on top of it.
         A head this window covers keeps none. */
      const kept = parseFloat(window.getComputedStyle(scroller).paddingBottom) || 0;
      const base = headOverSheet() ? kept : 0;
      if (base !== kept) scroller.style.paddingBottom = `${base}px`;
      const available = scroller.clientHeight;
      const height = scroller.scrollHeight;
      if (available && height > available + 0.5) {
        /* The hairline stands above the window's own edge, where it can be seen; a band this wide takes a section heading alone rather than stay blank. */
        const short = available < SHORT;
        /* A sheet keeps a little of its own under the scroller: that counts toward both. */
        const box = scroller.getBoundingClientRect();
        const below = Math.max(0, (scroller.closest("[data-settings-window], [data-mobile2-sheet]")?.getBoundingClientRect().bottom ?? box.top + available) - box.top - available);
        const room = available - Math.max(0, (short ? SHORT_FOOT : FOOT) - below);
        const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
        const units = [...scroller.querySelectorAll<HTMLElement>("[data-settings-unit]")].map((element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top - origin, bottom: box.bottom - origin, section: element.hasAttribute("data-settings-section") };
        });
        let end = 0;
        for (const unit of units) if (!unit.section && unit.bottom <= room + 0.5 && unit.bottom > end) end = unit.bottom;
        const blank = () => available + below - end >= BLANK_BAND;
        if (blank()) for (const unit of units) if (unit.bottom <= room + 0.5 && unit.bottom > end) end = unit.bottom;
        if (short && blank()) {
          const all = contentLines(scroller);
          const take = (bottom: number) => {
            const under = bottom + 2;
            if (under <= room + 0.5 && under > end && !all.some((other) => other.top < under - 0.5 && other.bottom > under + 0.5)) end = under;
          };
          /* A row's first line ends at its box, which holds its control; a text's lines at their words. */
          for (const line of scroller.querySelectorAll<HTMLElement>("[data-settings-line]")) take(line.getBoundingClientRect().bottom - origin);
          for (const text of scroller.querySelectorAll<HTMLElement>("[data-settings-row='text'], [data-settings-row='value']")) for (const line of contentLines(scroller, text)) take(line.bottom);
        }
        if (end) {
          const edge = Math.ceil(end);
          scroller.style.maxHeight = `${edge}px`;
          const rest = height - edge;
          /* The first row at or under the end's top; where that row is far below, the first line of words under it. */
          const unitTop = units.find((unit) => unit.top >= rest - 0.5)?.top;
          const lineTop = contentLines(scroller).map((line) => line.top).filter((top) => top >= rest - 0.5).sort((a, b) => a - b)[0];
          const headTop = unitTop !== undefined && unitTop - rest <= 64 ? unitTop : lineTop !== undefined && lineTop - rest <= 64 ? Math.floor(lineTop) - 2 : unitTop;
          const pad = headTop !== undefined ? Math.ceil(headTop - rest) : 0;
          if (pad > 0 && pad <= 64) scroller.style.paddingBottom = `${base + pad}px`;
          else if (base !== kept) scroller.style.paddingBottom = `${base}px`;
        }
      }
      scroller.scrollTop = held;
      /* A fit after the window landed mid-scroll (a list that shrank under it) keeps that screen on whole rows. */
      if (held > 0) scroller.scrollTop = wholeRowsTop(scroller, held);
      cue();
    };
    fit();
    scroller.addEventListener("scroll", cue, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => fit());
      observer.observe(inner);
      if (scroller.parentElement) observer.observe(scroller.parentElement);
    }
    return () => {
      scroller.removeEventListener("scroll", cue);
      observer?.disconnect();
      scroller.style.maxHeight = "";
      scroller.style.paddingBottom = "";
      scroller.style.boxShadow = "";
    };
  }, [content, page]);
}
