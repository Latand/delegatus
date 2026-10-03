"use client";

/*
 * Design prototype, not product code (docs/design/own-message-navigation.md).
 * Four variants of "jump between my own messages and see the replies to
 * them", drawn over a stand-in conversation window with the product's own
 * colours, type and shapes. Nothing in the product imports this file: only the
 * conversation evidence fixture mounts it (`?case=own-messages&variant=N`),
 * and it draws its own rows so the live feed components stay untouched.
 *
 * Interface text is written in Ukrainian in place. A build moves it to the
 * i18n tables in both languages.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Ellipsis, Eye, EyeOff, History, ListTree, Search, X } from "lucide-react";

import {
  PROTO_OLDER,
  firstLine,
  isOwn,
  modeRows,
  outline,
  ownCounter,
  ownTurns,
  protoConversation,
  stepOwn,
  type MachineRun,
  type OutlineEntry,
  type ProtoTurn,
} from "./ownMessages.prototype.model";

export type OwnMessagesVariant = 1 | 2 | 3 | 4;

const VARIANTS: Record<OwnMessagesVariant, { name: string; note: string }> = {
  1: { name: "Стрілки з лічильником", note: "Попереднє / наступне моє повідомлення, розмова лишається як є" },
  2: { name: "Режим «Мої»", note: "Машинні ходи згорнуті в один рядок, мої повідомлення поруч" },
  3: { name: "Рейка з позначками", note: "Кожне моє повідомлення — позначка на рейці, машинні ходи приглушені" },
  4: { name: "Зміст розмови", note: "Список моїх повідомлень із першим рядком відповіді" },
};

const SENDER_LABEL: Record<ProtoTurn["sender"], string> = {
  operator: "Ви",
  "seat-tick": "Агент · пробудження",
  agent: "Агент · виконавець",
  pipeline: "Агент · пайплайн",
};

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${count} ${word}`;
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

function Reply({ turn, marked }: { turn: ProtoTurn; marked: boolean }) {
  return (
    <div data-own-reply={marked ? "own" : undefined} className={marked ? "border-l-2 border-accent pl-3" : ""}>
      {marked ? <div className="mb-1 text-label font-semibold text-accent">Відповідь на ваше повідомлення</div> : null}
      <div className="space-y-2.5 text-[14px] leading-[1.55]">
        {turn.reply.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </div>
      <div className="mt-1.5 text-label text-muted">{plural(turn.tools, "виклик інструмента", "виклики інструментів", "викликів інструментів")}</div>
    </div>
  );
}

function TurnView({ turn, phone, marked, dimmed }: { turn: ProtoTurn; phone: boolean; marked: boolean; dimmed: boolean }) {
  return (
    <div data-turn-id={turn.id} data-turn-sender={turn.sender} className={`pb-4 ${dimmed ? "opacity-50" : ""}`}>
      {isOwn(turn) ? (
        <div className="my-3 flex items-end justify-end gap-2">
          <span className="shrink-0 pb-1 text-label tabular-nums text-muted">{turn.at}</span>
          <div className={`${phone ? "max-w-[86%] px-3 py-[9px] text-title leading-[1.45]" : "max-w-[70ch] px-4 py-2.5 text-[14px]"} whitespace-pre-wrap break-words rounded-surface bg-user`}>
            {turn.text}
          </div>
        </div>
      ) : (
        <div className="my-3 overflow-hidden rounded-surface border border-accent/25 bg-accent-soft px-3.5 py-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-full border border-accent/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">внутрішнє</span>
            <span className="min-w-0 truncate text-[11px] font-semibold text-accent">{SENDER_LABEL[turn.sender]}</span>
            <span className="ml-auto shrink-0 text-label tabular-nums text-muted">{turn.at}</span>
          </div>
          <div className="mt-0.5 break-words text-[13px]">{turn.text}</div>
        </div>
      )}
      <Reply turn={turn} marked={marked} />
    </div>
  );
}

function RunRow({ run, open, phone, onToggle }: { run: MachineRun; open: boolean; phone: boolean; onToggle: () => void }) {
  const parts = [
    run.wakes ? plural(run.wakes, "пробудження", "пробудження", "пробуджень") : null,
    run.notices ? plural(run.notices, "сповіщення агентів", "сповіщення агентів", "сповіщень агентів") : null,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-own-run={run.turns[0]!.id}
      aria-expanded={open}
      onClick={onToggle}
      className={`my-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-label text-muted hover:bg-sunken ${phone ? "min-h-11" : "min-h-9"}`}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{parts}</span>
      <span className="shrink-0 tabular-nums">{run.from === run.to ? run.from : `${run.from}–${run.to}`}</span>
    </button>
  );
}

function OutlineList({ entries, activeId, onPick }: { entries: OutlineEntry[]; activeId: string | null; onPick: (entry: OutlineEntry) => void }) {
  const list = useRef<HTMLOListElement>(null);
  /* Opening the list shows where the operator is in it. */
  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" }); }, []);
  return (
    <ol ref={list} data-own-outline className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <button
            type="button"
            data-own-outline-entry={entry.id}
            data-own-outline-loaded={entry.loaded ? "yes" : "no"}
            aria-current={entry.id === activeId ? "true" : undefined}
            onClick={() => onPick(entry)}
            className={`flex w-full gap-2.5 border-b border-border border-l-2 px-3 py-2.5 text-left hover:bg-sunken ${entry.id === activeId ? "border-l-accent bg-accent-soft" : "border-l-transparent"}`}
          >
            <span className="w-5 shrink-0 pt-px text-right text-label tabular-nums text-muted">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-label text-muted">
                <span className="tabular-nums">{entry.at}</span>
                {entry.loaded ? null : <span className="rounded-full border border-dashed border-strong px-1.5 text-[10px] font-semibold">ще не завантажено</span>}
              </span>
              <span className="line-clamp-2 text-ui font-semibold text-primary">{entry.message}</span>
              <span className="mt-0.5 line-clamp-2 text-label text-secondary">↳ {entry.reply}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const ICON_BUTTON = "flex h-11 w-11 shrink-0 items-center justify-center text-secondary";

export function OwnMessagesPrototype({ variant }: { variant: OwnMessagesVariant }) {
  const phone = usePhone();
  const all = useMemo(() => protoConversation(), []);
  const [loadedFrom, setLoadedFrom] = useState(PROTO_OLDER);
  const loaded = useMemo(() => all.slice(loadedFrom), [all, loadedFrom]);
  const own = useMemo(() => ownTurns(loaded), [loaded]);
  const entries = useMemo(() => outline(all, loadedFrom), [all, loadedFrom]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState(false);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(new Set());
  const [dim, setDim] = useState(true);
  const [panel, setPanel] = useState(!phone);
  const [preview, setPreview] = useState<string | null>(null);
  const [ticks, setTicks] = useState<ReadonlyMap<string, number>>(new Map());
  const [view, setView] = useState({ top: 0, height: 1 });

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  /* What the next layout has to do to the scroll position: land on a turn, or
     keep the row the operator was reading where it was. */
  const pending = useRef<{ jump: string } | { keep: number } | { bottom: true } | null>({ bottom: true });
  const programmatic = useRef<number | null>(null);

  const turnElement = useCallback((id: string) => scroller.current?.querySelector<HTMLElement>(`[data-turn-id="${id}"]`) ?? null, []);

  const land = useCallback((id: string) => {
    const box = scroller.current;
    const element = turnElement(id);
    if (!box || !element) return;
    const top = Math.max(0, Math.min(element.offsetTop - 8, box.scrollHeight - box.clientHeight));
    programmatic.current = top;
    box.scrollTop = top;
    setActiveId(id);
  }, [turnElement]);

  const jumpTo = useCallback((id: string) => {
    if (turnElement(id)) land(id);
    else {
      pending.current = { jump: id };
      setLoadedFrom(0);
    }
  }, [land, turnElement]);

  const loadOlder = useCallback(() => {
    const box = scroller.current;
    if (box) pending.current = { keep: box.scrollHeight - box.scrollTop };
    setLoadedFrom(0);
  }, []);

  const step = useCallback((direction: -1 | 1) => {
    const box = scroller.current;
    if (!box) return;
    const current = activeId ? turnElement(activeId) : null;
    /* Going back from the middle of a reply first returns to the message that
       reply answers. */
    if (direction === -1 && activeId && current && current.offsetTop - 8 < box.scrollTop - 4) return land(activeId);
    const target = stepOwn(loaded, activeId, direction);
    if (target) return jumpTo(target.id);
    if (direction === -1 && loadedFrom > 0) {
      const older = ownTurns(all.slice(0, loadedFrom)).at(-1);
      if (older) jumpTo(older.id);
    } else if (direction === 1) {
      programmatic.current = null;
      box.scrollTop = box.scrollHeight;
    }
  }, [activeId, all, jumpTo, land, loaded, loadedFrom, turnElement]);

  const toggleMode = useCallback(() => {
    pending.current = activeId ? { jump: activeId } : { bottom: true };
    setMode((value) => !value);
  }, [activeId]);

  const measure = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const next = new Map<string, number>();
    for (const element of box.querySelectorAll<HTMLElement>("[data-turn-id]")) next.set(element.dataset.turnId!, element.offsetTop / box.scrollHeight);
    setTicks(next);
    setView({ top: box.scrollTop / box.scrollHeight, height: box.clientHeight / box.scrollHeight });
  }, []);

  useLayoutEffect(() => {
    const box = scroller.current;
    const todo = pending.current;
    pending.current = null;
    if (box && todo) {
      if ("jump" in todo) land(todo.jump);
      else if ("keep" in todo) box.scrollTop = box.scrollHeight - todo.keep;
      else box.scrollTop = box.scrollHeight;
    }
    measure();
  }, [land, loadedFrom, measure, mode, openRuns, phone, panel]);

  useEffect(() => {
    const inner = content.current;
    if (!inner) return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [measure]);

  const onScroll = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    setView({ top: box.scrollTop / box.scrollHeight, height: box.clientHeight / box.scrollHeight });
    if (programmatic.current !== null && Math.abs(box.scrollTop - programmatic.current) < 2) return;
    programmatic.current = null;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    let current: string | null = null;
    for (const turn of own) {
      const element = turnElement(turn.id);
      if (element && (atEnd || element.offsetTop <= box.scrollTop + 120)) current = turn.id;
    }
    setActiveId(current);
  }, [own, turnElement]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); step(-1); }
      else if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); step(1); }
      else if (variant === 2 && event.altKey && event.code === "KeyM") { event.preventDefault(); toggleMode(); }
      else if (variant === 4 && event.altKey && event.code === "KeyO") { event.preventDefault(); setPanel((value) => !value); }
      else if (event.key === "Escape") {
        if (variant === 2 && mode) toggleMode();
        if (variant === 4 && phone) setPanel(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, phone, step, toggleMode, variant]);

  const olderUnloaded = loadedFrom > 0;
  const atOldestLoaded = activeId !== null && own[0]?.id === activeId;
  const marked = (turn: ProtoTurn) => isOwn(turn) && (variant === 1 || (variant === 4 && turn.id === activeId));
  const dimmed = (turn: ProtoTurn) => variant === 3 && dim && !isOwn(turn);

  /* ---- variant 3: the rail ---- */
  const nearestOwn = (clientY: number): string | null => {
    const box = rail.current?.getBoundingClientRect();
    if (!box) return null;
    const at = (clientY - box.top) / box.height;
    let best: string | null = null;
    let distance = Infinity;
    for (const turn of own) {
      const tick = ticks.get(turn.id);
      if (tick !== undefined && Math.abs(tick - at) < distance) { best = turn.id; distance = Math.abs(tick - at); }
    }
    return best;
  };
  const previewTurn = preview ? own.find((turn) => turn.id === preview) ?? null : null;

  const pick = (entry: OutlineEntry) => {
    if (phone) setPanel(false);
    jumpTo(entry.id);
  };

  const headerControl: ReactNode = variant === 2 && !phone ? (
    <div className="inline-flex shrink-0 rounded-lg border border-border p-0.5 text-ui font-semibold" role="group" aria-label="Що показувати">
      <button type="button" data-own-mode="all" aria-pressed={!mode} onClick={() => mode && toggleMode()} className={`h-7 rounded-md px-2.5 ${mode ? "text-secondary" : "bg-accent-soft text-accent"}`}>Уся розмова</button>
      <button type="button" data-own-mode="own" aria-pressed={mode} onClick={() => !mode && toggleMode()} className={`h-7 rounded-md px-2.5 ${mode ? "bg-accent-soft text-accent" : "text-secondary"}`}>Мої · {own.length}{olderUnloaded ? "+" : ""}</button>
      <span className="self-center px-2 text-label font-normal text-muted">Alt+M</span>
    </div>
  ) : variant === 4 && !phone ? (
    <button type="button" data-own-panel-toggle aria-pressed={panel} onClick={() => setPanel((value) => !value)} className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-ui font-semibold ${panel ? "bg-accent-soft text-accent" : "text-secondary"}`}>
      <ListTree className="h-4 w-4" aria-hidden />Зміст · {entries.length}
      <span className="pl-1 text-label font-normal text-muted">Alt+O</span>
    </button>
  ) : null;

  const info = VARIANTS[variant];
  return (
    <div data-own-proto={variant} className="flex min-h-0 flex-1 flex-col bg-canvas text-primary">
      <div data-own-variant-band className={`flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 ${phone ? "h-14" : "h-16"}`}>
        <span data-own-variant-number className={`shrink-0 font-black leading-none tabular-nums text-accent ${phone ? "text-[40px]" : "text-[48px]"}`}>{variant}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-title font-bold leading-tight">Варіант {variant} · {info.name}</span>
          <span className={`text-label leading-tight text-muted ${phone ? "line-clamp-2" : "truncate"}`}>{info.note}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-w-0 flex-1 flex-col">
          {phone ? (
            <header className="flex h-[52px] shrink-0 items-center gap-0.5 border-b border-border bg-canvas px-1">
              <span className={ICON_BUTTON}><ChevronLeft className="h-5 w-5" aria-hidden /></span>
              <span className="flex min-w-0 flex-1 flex-col px-1">
                <span className="truncate text-title font-semibold leading-tight">Оркестратор</span>
                <span className="truncate text-label leading-tight text-muted">delegatus · працює</span>
              </span>
              <span className={ICON_BUTTON}><Search className="h-5 w-5" aria-hidden /></span>
              <span className={ICON_BUTTON}><Ellipsis className="h-5 w-5" aria-hidden /></span>
            </header>
          ) : (
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
              <span className="min-w-0 truncate text-title font-semibold">Оркестратор · delegatus</span>
              <span className="shrink-0 text-label text-muted">{plural(loaded.length, "хід", "ходи", "ходів")} · {own.length}{olderUnloaded ? "+" : ""} ваших</span>
              <span className="ml-auto" />
              {headerControl}
            </header>
          )}

          <div className="relative flex min-h-0 flex-1">
            <div ref={scroller} data-own-scroller onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              <div ref={content} className={`mx-auto max-w-[860px] py-3 ${phone ? "px-3" : "px-5"} ${phone && variant !== 3 && !(variant === 2 && mode) ? "pb-16" : ""}`}>
                {olderUnloaded ? (
                  <div className="mb-2 flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-label text-muted">
                    <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">Раніша історія ще не завантажена</span>
                    <button type="button" data-own-load-older onClick={loadOlder} className="shrink-0 font-semibold text-accent">Завантажити</button>
                  </div>
                ) : null}
                {variant === 2 && mode
                  ? modeRows(loaded).map((row) => row.kind === "own"
                    ? <TurnView key={row.turn.id} turn={row.turn} phone={phone} marked={false} dimmed={false} />
                    : (
                      <div key={row.turns[0]!.id}>
                        <RunRow
                          run={row}
                          phone={phone}
                          open={openRuns.has(row.turns[0]!.id)}
                          onToggle={() => {
                            const box = scroller.current;
                            const next = new Set(openRuns);
                            if (!next.delete(row.turns[0]!.id)) next.add(row.turns[0]!.id);
                            if (box) pending.current = { keep: box.scrollHeight - box.scrollTop };
                            setOpenRuns(next);
                          }}
                        />
                        {openRuns.has(row.turns[0]!.id) ? row.turns.map((turn) => <TurnView key={turn.id} turn={turn} phone={phone} marked={false} dimmed={false} />) : null}
                      </div>
                    ))
                  : loaded.map((turn) => <TurnView key={turn.id} turn={turn} phone={phone} marked={marked(turn)} dimmed={dimmed(turn)} />)}
              </div>
            </div>

            {variant === 3 ? (
              <div data-own-rail-column className={`flex shrink-0 flex-col border-l border-border bg-canvas ${phone ? "w-[45px]" : "w-9"}`}>
                {olderUnloaded ? (
                  <button type="button" data-own-load-older-rail aria-label="Завантажити раніші повідомлення" title="Раніша історія ще не завантажена" onClick={loadOlder} className={`flex shrink-0 items-center justify-center border-b border-dashed border-border text-muted ${phone ? "h-11" : "h-8"}`}>
                    <History className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
                <div
                  ref={rail}
                  data-own-rail
                  role="slider"
                  aria-label="Мої повідомлення в розмові"
                  aria-valuemin={1}
                  aria-valuemax={own.length}
                  aria-valuenow={Math.max(1, own.findIndex((turn) => turn.id === activeId) + 1)}
                  tabIndex={0}
                  className="relative min-h-0 flex-1 cursor-pointer touch-none"
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setPreview(nearestOwn(event.clientY)); }}
                  onPointerMove={(event) => setPreview(nearestOwn(event.clientY))}
                  onPointerUp={(event) => { const id = nearestOwn(event.clientY); if (id) jumpTo(id); if (event.pointerType !== "mouse") setPreview(null); }}
                  onPointerLeave={() => setPreview(null)}
                >
                  <span aria-hidden className="absolute inset-x-0 border-y border-strong bg-primary/10" style={{ top: `${view.top * 100}%`, height: `${view.height * 100}%` }} />
                  {loaded.map((turn) => {
                    const top = ticks.get(turn.id);
                    if (top === undefined) return null;
                    const mine = isOwn(turn);
                    return (
                      <span
                        key={turn.id}
                        aria-hidden
                        data-own-tick={mine ? turn.id : undefined}
                        className={`absolute right-1.5 rounded-full ${mine ? `h-[3px] ${turn.id === activeId || turn.id === preview ? "left-1 bg-accent" : "left-2.5 bg-accent/70"}` : "left-[62%] h-px bg-strong"}`}
                        style={{ top: `${top * 100}%` }}
                      />
                    );
                  })}
                </div>
                <button type="button" data-own-dim-toggle aria-pressed={dim} aria-label={dim ? "Показати всю розмову без приглушення" : "Приглушити машинні ходи"} title={dim ? "Уся розмова без приглушення" : "Приглушити машинні ходи"} onClick={() => setDim((value) => !value)} className={`flex shrink-0 items-center justify-center border-t border-border ${dim ? "text-accent" : "text-muted"} ${phone ? "h-11" : "h-9"}`}>
                  {dim ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
            ) : null}

            {variant === 3 && previewTurn ? (
              <div data-own-preview className={`pointer-events-none absolute z-20 rounded-lg border border-border bg-card px-3 py-2 shadow-1 ${phone ? "right-12 w-[250px]" : "right-11 w-[320px]"}`} style={{ top: `clamp(8px, calc(${(ticks.get(previewTurn.id) ?? 0) * 100}% - 12px), calc(100% - 120px))` }}>
                <div className="text-label tabular-nums text-muted">{previewTurn.at} · {own.indexOf(previewTurn) + 1} з {own.length}{olderUnloaded ? "+" : ""}</div>
                <div className="line-clamp-2 text-ui font-semibold">{firstLine(previewTurn.text, 90)}</div>
                <div className="mt-0.5 line-clamp-2 text-label text-secondary">↳ {firstLine(previewTurn.reply[0]!, 100)}</div>
              </div>
            ) : null}

            {variant === 1 ? (
              <div data-own-stepper className={`absolute z-10 flex items-center rounded-full border border-border bg-card shadow-1 ${phone ? "bottom-2 right-3" : "bottom-3 right-5"}`}>
                <button type="button" data-own-step="prev" aria-label={atOldestLoaded && olderUnloaded ? "Завантажити раніші та перейти до попереднього мого повідомлення" : "Попереднє моє повідомлення"} onClick={() => step(-1)} className={`flex items-center justify-center rounded-full text-secondary hover:bg-sunken ${phone ? "h-11 w-11" : "h-9 w-9"}`}>
                  {atOldestLoaded && olderUnloaded ? <History className="h-4 w-4" aria-hidden /> : <ChevronUp className="h-5 w-5" aria-hidden />}
                </button>
                <span data-own-counter className="min-w-[58px] px-1 text-center text-ui font-semibold tabular-nums">{ownCounter(loaded, activeId, olderUnloaded)}</span>
                <button type="button" data-own-step="next" aria-label="Наступне моє повідомлення" onClick={() => step(1)} className={`flex items-center justify-center rounded-full text-secondary hover:bg-sunken ${phone ? "h-11 w-11" : "h-9 w-9"}`}>
                  <ChevronDown className="h-5 w-5" aria-hidden />
                </button>
                {phone ? null : <span className="border-l border-border py-1 pl-2.5 pr-3 text-label text-muted">Alt+↑ / Alt+↓</span>}
              </div>
            ) : null}

            {variant === 2 && phone && !mode ? (
              <button type="button" data-own-mode-chip aria-pressed={false} onClick={toggleMode} className="absolute bottom-2 right-3 z-10 flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-ui font-semibold shadow-1">
                Мої · {own.length}{olderUnloaded ? "+" : ""}
              </button>
            ) : null}

            {variant === 4 && phone && !panel ? (
              <button type="button" data-own-panel-toggle onClick={() => setPanel(true)} className="absolute bottom-2 right-3 z-10 flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-ui font-semibold shadow-1">
                <ListTree className="h-4 w-4" aria-hidden />Зміст · {entries.length}
              </button>
            ) : null}
          </div>

          {/* While the mode is on, its state and the way out sit in the flow
              above the composer, so nothing floats over a message. */}
          {variant === 2 && phone && mode ? (
            <div data-own-mode-strip className="flex h-11 shrink-0 items-center gap-2 border-t border-accent/30 bg-accent-soft pl-3 text-ui">
              <span className="min-w-0 flex-1 truncate font-semibold text-accent">Лише мої повідомлення · {own.length}{olderUnloaded ? "+" : ""}</span>
              <button type="button" data-own-mode-chip aria-pressed onClick={toggleMode} className="h-11 shrink-0 px-4 font-semibold text-primary">Уся розмова</button>
            </div>
          ) : null}

          <footer data-own-composer className={`shrink-0 border-t border-border bg-card ${phone ? "px-3 py-1.5" : "px-5 py-3"}`}>
            <div className={`flex items-center rounded-lg border border-border bg-canvas px-3 text-ui text-muted ${phone ? "h-11" : "h-10"}`}>Напишіть оркестратору…</div>
          </footer>

          {variant === 4 && phone && panel ? (
            <>
              <button type="button" aria-label="Закрити зміст" onClick={() => setPanel(false)} className="absolute inset-0 z-20 bg-black/50" />
              <div data-own-sheet role="dialog" aria-label="Мої повідомлення" className="absolute inset-x-0 bottom-0 z-30 flex max-h-[74%] flex-col rounded-t-2xl border-t border-border bg-card">
                <div className="flex h-12 shrink-0 items-center border-b border-border pl-4 pr-1">
                  <span className="min-w-0 flex-1 truncate text-title font-semibold">Мої повідомлення · {entries.length}</span>
                  <button type="button" data-own-sheet-close aria-label="Закрити" onClick={() => setPanel(false)} className={ICON_BUTTON}><X className="h-5 w-5" aria-hidden /></button>
                </div>
                <OutlineList entries={entries} activeId={activeId} onPick={pick} />
              </div>
            </>
          ) : null}
        </section>

        {variant === 4 && !phone && panel ? (
          <aside data-own-panel className="flex w-[340px] shrink-0 flex-col border-l border-border bg-card">
            <div className="flex h-12 shrink-0 items-center border-b border-border pl-3 pr-1">
              <span className="min-w-0 flex-1 truncate text-title font-semibold">Мої повідомлення · {entries.length}</span>
              <button type="button" data-own-panel-close aria-label="Закрити зміст" onClick={() => setPanel(false)} className="flex h-9 w-9 items-center justify-center text-secondary"><X className="h-4 w-4" aria-hidden /></button>
            </div>
            <OutlineList entries={entries} activeId={activeId} onPick={pick} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function mountOwnMessagesPrototype(root: HTMLElement, variant: number): void {
  const picked = (variant === 2 || variant === 3 || variant === 4 ? variant : 1) as OwnMessagesVariant;
  createRoot(root).render(<OwnMessagesPrototype variant={picked} />);
}
