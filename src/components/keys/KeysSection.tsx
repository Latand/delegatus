"use client";

import { Check, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { copyText } from "@/components/feed/CopyButton";
import { KEYS_CHANGED_EVENT } from "@/components/keys/openKeys";
import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useLocale } from "@/lib/i18n";
import {
  KEY_PROVIDER_NAME, maskedTail, maskKey, maskPastedLines, validKeyValue,
  type ImportConfirmation, type ImportPreview, type ImportRow, type KeyEntry, type KeyId, type KeysAnswer,
} from "@/lib/keys/shared";

/*
 * «Keys» (docs/design/keys-settings.md, Варіант 1 «Сторінка в меню»): every
 * key Delegatus reads, on one page of the header menu (the 232 px panel on the
 * desktop, the menu sheet on the phone), with «Import keys» as a page under it.
 *
 * The list carries states and masked values only. A value comes from
 * `POST /api/keys/<id>/reveal`, one request per press of the eye or of copy,
 * and copy puts it on the clipboard without putting it on screen. A revealed
 * value hides again after 30 s, and at once when the page or the menu closes.
 */


const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

type Size = "menu" | "sheet";
type T = ReturnType<typeof useLocale>["t"];

/* ---- Reading and writing ------------------------------------------------ */

/** What a row does to the list while a save is in flight: show the saved state at once, and take it back if the save is refused. */
interface Optimism {
  hold: (entry: KeyEntry) => void;
  /** Ends a held entry; `restore` puts the row back. False when a newer save has replaced it. */
  release: (entry: KeyEntry, restore: KeyEntry | null) => boolean;
  adopt: (answer: KeysAnswer) => void;
}

function useKeys() {
  const [answer, setAnswer] = useState<KeysAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  /* The rows a save is still answering for: a list read that lands meanwhile must not undo them. */
  const held = useRef(new Map<KeyId, KeyEntry>());
  const adopt = useCallback((next: KeysAnswer) => {
    setAnswer({ ...next, keys: next.keys.map((entry) => held.current.get(entry.id) ?? entry) });
  }, []);
  const hold = useCallback((entry: KeyEntry) => {
    held.current.set(entry.id, entry);
    setAnswer((now) => now && { ...now, keys: now.keys.map((candidate) => candidate.id === entry.id ? entry : candidate) });
  }, []);
  const release = useCallback((entry: KeyEntry, restore: KeyEntry | null) => {
    if (held.current.get(entry.id) !== entry) return false;
    held.current.delete(entry.id);
    if (restore) setAnswer((now) => now && { ...now, keys: now.keys.map((candidate) => candidate.id === entry.id ? restore : candidate) });
    return true;
  }, []);
  const optimism: Optimism = { hold, release, adopt };
  const load = useCallback(() => fetch("/api/keys", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      adopt(await response.json() as KeysAnswer);
      setFailed(false);
    })
    .catch(() => setFailed(true)), [adopt]);
  useEffect(() => {
    const read = () => { void load(); };
    read();
    window.addEventListener(KEYS_CHANGED_EVENT, read);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, read);
  }, [load]);
  return { answer, failed, reload: load, optimism };
}

async function revealValue(id: KeyId, purpose: "reveal" | "copy"): Promise<string | null> {
  try {
    const response = await fetch(`/api/keys/${id}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose }), cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { value?: unknown };
    return typeof body.value === "string" ? body.value : null;
  } catch { return null; }
}

/**
 * Copies a value fetched for this press. Safari keeps the tap's permission to
 * write the clipboard across the request only for a `ClipboardItem` whose data
 * is a promise; elsewhere, and over a plain-http origin, the value is fetched
 * and then copied through the app's own fallback.
 */
async function copyFetched(fetched: Promise<string | null>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = fetched.then((value) => {
        if (value === null) throw new Error("no value");
        return new Blob([value], { type: "text/plain" });
      });
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch { /* the fallback below */ }
  }
  const value = await fetched;
  return value !== null && copyText(value);
}

type WriteFailure = "invalid" | "telegram" | "failed";
type WriteResult = { ok: true; answer: KeysAnswer | null } | { ok: false; error: WriteFailure };

async function writeValue(id: KeyId, value: string): Promise<WriteResult> {
  try {
    const response = await fetch(`/api/keys/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    if (response.ok) {
      const answer = await response.json().catch(() => null) as KeysAnswer | null;
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
      return { ok: true, answer: answer && Array.isArray(answer.keys) ? answer : null };
    }
    const body = await response.json().catch(() => ({})) as { code?: unknown };
    return { ok: false, error: body.code === "invalid_key" ? "invalid" : body.code === "telegram_refused" ? "telegram" : "failed" };
  } catch { return { ok: false, error: "failed" }; }
}

export const keyName = (t: T, id: KeyId) => id === "telegram" ? t("keys.name.telegram") : KEY_PROVIDER_NAME[id];
const isSet = (entry: KeyEntry) => entry.source === "file" || entry.source === "env";

/* ---- The Settings row's state ----------------------------------------- */

/** «Задано 3 із 6» beside a dot: green while every read succeeds, amber when one failed. */
export function KeysStateWord({ size = "menu" }: { size?: Size }) {
  const { t } = useLocale();
  const { answer, failed } = useKeys();
  const set = answer?.keys.filter(isSet).length ?? 0;
  const tone = failed || answer?.keys.some((entry) => entry.source === "failed") ? "bg-warning" : set ? "bg-success" : "bg-muted";
  return (
    <span data-keys-state="" className={`inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap font-medium text-muted ${size === "sheet" ? "text-label" : "text-[11px] leading-[14px]"}`}>
      <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${tone}`} />
      <span className="truncate">{failed ? t("keys.state.failed") : answer ? t("keys.rowState", { set, total: answer.keys.length }) : "…"}</span>
    </span>
  );
}

/* ---- Pieces ------------------------------------------------------------ */

const DOT: Record<KeyEntry["source"], string> = {
  file: "bg-success",
  env: "bg-accent",
  missing: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-muted)]",
  failed: "bg-warning",
};

const dotWords = (t: T, entry: KeyEntry) => entry.source === "file" ? t("keys.state.file")
  : entry.source === "env" ? t("keys.state.env", { variable: entry.variable })
  : entry.source === "failed" ? t("keys.state.failedHint")
  : t("keys.state.missing");

/*
 * The row's status: a dot whose short note says where the value comes from.
 * The note opens in the row's flow, under the line with the dot: a floating
 * bubble spilled out of the 232 px panel and covered the next row's buttons.
 */
function useDot() {
  const [open, setOpenState] = useState(false);
  const id = useId();
  /* The state as the next event sees it, before React renders; a mouse click pins the note until a press elsewhere. */
  const now = useRef(false);
  const pinned = useRef(false);
  const setOpen = useCallback((next: boolean) => { now.current = next; if (!next) pinned.current = false; setOpenState(next); }, []);
  const leave = useRef<number | null>(null);
  const hoverIn = useCallback(() => { if (leave.current !== null) window.clearTimeout(leave.current); leave.current = null; setOpen(true); }, [setOpen]);
  const hoverOut = useCallback(() => { if (leave.current !== null) window.clearTimeout(leave.current); leave.current = window.setTimeout(() => { leave.current = null; if (!pinned.current) setOpen(false); }, 150); }, [setOpen]);
  useEffect(() => () => { if (leave.current !== null) window.clearTimeout(leave.current); }, []);
  const pin = useCallback(() => { setOpen(true); pinned.current = true; }, [setOpen]);
  const isOpen = useCallback(() => now.current, []);
  return { open, setOpen, id, hoverIn, hoverOut, pin, isOpen };
}

function StatusDot({ entry, dot, coarse }: { entry: KeyEntry; dot: ReturnType<typeof useDot>; coarse: boolean }) {
  const { t } = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const { open, setOpen } = dot;
  /* A tap focuses before it clicks: the click answers the state the press found, so a tap opens. */
  const openAtPress = useRef(false);
  const pressType = useRef("");
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, setOpen]);
  return (
    <span
      ref={ref}
      role="button"
      tabIndex={0}
      data-keys-dot={entry.source}
      aria-label={t("keys.dotAria", { name: keyName(t, entry.id), state: dotWords(t, entry) })}
      aria-expanded={open}
      aria-describedby={open ? dot.id : undefined}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${FOCUS} ${coarse ? "h-11 w-11" : "h-4 w-4 before:absolute before:-inset-1.5 before:content-['']"}`}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") dot.hoverIn(); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") dot.hoverOut(); }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onPointerDown={(event) => { openAtPress.current = dot.isOpen(); pressType.current = event.pointerType; }}
      onClick={(event) => {
        event.stopPropagation();
        if (pressType.current === "mouse") dot.pin(); else setOpen(!openAtPress.current);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(!dot.isOpen()); }
      }}
    >
      <span aria-hidden className={`h-[7px] w-[7px] rounded-full ${DOT[entry.source]}`} />
    </span>
  );
}

/** The dot's note, in the row under the line it belongs to. */
function DotNote({ entry, dot }: { entry: KeyEntry; dot: ReturnType<typeof useDot> }) {
  const { t } = useLocale();
  if (!dot.open) return null;
  return (
    <span role="tooltip" id={dot.id}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") dot.hoverIn(); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") dot.hoverOut(); }}
      className="block rounded-control border border-border bg-raised px-2.5 py-1.5 text-label leading-4 text-primary shadow-1">
      <span data-keys-pop={entry.source}>{dotWords(t, entry)}</span>
    </span>
  );
}

function IconButton({ label, onClick, pressed, children, data, coarse, buttonRef }: {
  label: string; onClick: () => void; pressed?: boolean; children: ReactNode; data: Record<string, string>; coarse: boolean; buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      {...data}
      className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary ${FOCUS} ${coarse ? "h-11 w-11" : "h-7 w-7"} ${pressed ? "bg-sunken text-primary" : ""}`}
    >
      {children}
    </button>
  );
}

/** A row's ⋯ opens in the row's flow, under the ⋯, so no edge of it lands on the next row's icons. */
function RowMenu({ anchor, items, onClose, full }: { anchor: HTMLElement; items: { label: string; run: () => void; data: string }[]; onClose: () => void; full: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); anchor.focus(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  return (
    <div ref={ref} role="menu" data-keys-menu="" className={`rounded-control border border-border bg-raised p-1 shadow-1 ${full ? "" : "w-max self-end"}`}>
      {items.map((item) => (
        <button key={item.data} type="button" role="menuitem" data-keys-menu-item={item.data}
          className={`flex w-full items-center whitespace-nowrap rounded-control px-2 text-left font-semibold text-primary hover:bg-sunken ${FOCUS} ${coarse ? "min-h-11 text-body" : "min-h-[30px] text-[12px]"}`}
          onClick={() => { onClose(); item.run(); }}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The field behind «Replace» and «Add»: write-only, emptied on every submit,
 * never filled from a saved key. `onSave` answers the refusal to show while
 * the field stays open, or null once the row has taken the save over.
 */
function ValueField({ entry, size, initialError, onSave, onCancel }: {
  entry: KeyEntry; size: Size; initialError: WriteFailure | null;
  onSave: (value: string) => Promise<WriteFailure | null>; onCancel: () => void;
}) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const input = useRef<HTMLInputElement>(null);
  const [has, setHas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteFailure | null>(initialError);
  useEffect(() => { input.current?.focus(); }, []);
  const name = keyName(t, entry.id);
  const control = coarse ? "min-h-11 text-body" : size === "menu" ? "h-7 text-[11.5px]" : "h-8 text-ui";
  const placeholder = entry.id === "openrouter" ? "sk-or-v1-…" : entry.id === "openai" ? "sk-…" : undefined;
  const save = async () => {
    const value = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    setHas(false);
    setBusy(true);
    const refused = await onSave(value);
    setBusy(false);
    if (refused) setError(refused);
  };
  return (
    <div data-keys-field={entry.id} className="flex w-full flex-col gap-1">
      {/* In the 232 px panel the field takes the whole line and its buttons go under it. */}
      <form className={`flex w-full gap-1 ${size === "menu" ? "flex-wrap items-center" : ""}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={4096} aria-label={t("keys.fieldAria", { name })} disabled={busy}
          placeholder={placeholder} data-1p-ignore="" data-lpignore="true"
          onChange={(event) => { setHas(Boolean(event.target.value.trim())); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}
          className={`${control} min-w-0 flex-1 ${size === "menu" ? "basis-full" : ""} rounded-control border bg-canvas px-2 font-mono text-primary placeholder:text-muted ${FOCUS} ${error ? "border-danger" : "border-border"}`} />
        <button type="submit" disabled={!has || busy} data-keys-save=""
          className={`${control} shrink-0 whitespace-nowrap rounded-control border border-border bg-card px-2.5 font-semibold text-primary hover:bg-sunken disabled:opacity-45 ${FOCUS}`}>{t("keys.save")}</button>
        <button type="button" data-keys-cancel="" onClick={onCancel}
          className={`shrink-0 whitespace-nowrap px-1 font-semibold text-secondary underline underline-offset-2 hover:text-primary ${FOCUS} ${coarse ? "min-h-11 text-label" : size === "menu" ? "text-[11px]" : "text-label"}`}>{t("keys.cancel")}</button>
      </form>
      {error ? (
        <p role="alert" data-keys-error={error} className={`w-full leading-snug text-danger ${coarse ? "text-label" : "text-[11px]"}`}>
          {error === "invalid" ? t("keys.invalid", { name }) : error === "telegram" ? t("keys.telegramRefused") : t("keys.failed")}
        </p>
      ) : null}
    </div>
  );
}

/* ---- One key ------------------------------------------------------------ */

type Note = { kind: "copied" | "masked" | "saved"; text: string } | null;

function useRowActions(entry: KeyEntry, optimism: Optimism) {
  const { t } = useLocale();
  /* A value is shown only for the key it was revealed for: a saved replacement hides it. */
  const [revealed, setRevealed] = useState<{ value: string; masked: string | null } | null>(null);
  const value = revealed && revealed.masked === entry.masked ? revealed.value : null;
  const setValue = useCallback((next: string | null) => setRevealed(next === null ? null : { value: next, masked: entry.masked }), [entry.masked]);
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState(false);
  /* The refusal a save met after the row had already taken it: the field comes back with it. */
  const [editError, setEditError] = useState<WriteFailure | null>(null);
  const timer = useRef<number | null>(null);
  /* Every answer to a reveal belongs to the press that asked for it: Hide, a changed key and leaving the page end it. */
  const epoch = useRef(0);
  const revealing = useRef(false);
  const flash = (next: Note) => {
    setNote(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 2000);
  };
  useEffect(() => {
    if (value === null) return;
    const hide = window.setTimeout(() => setValue(null), 30_000);
    return () => window.clearTimeout(hide);
  }, [value, setValue]);
  useEffect(() => { epoch.current += 1; }, [entry.masked]);
  useEffect(() => () => { epoch.current += 1; if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const toggle = async () => {
    if (value !== null) { epoch.current += 1; setValue(null); return; }
    /* A second press before the answer asks for what is already on its way. */
    if (revealing.current) return;
    revealing.current = true;
    const mine = ++epoch.current;
    const answer = await revealValue(entry.id, "reveal");
    revealing.current = false;
    if (epoch.current === mine) setValue(answer);
  };
  const copy = async (text: string) => { if (await copyFetched(revealValue(entry.id, "copy"))) flash({ kind: "copied", text }); };
  const copyMasked = async (text: string) => { if (entry.masked && await copyText(entry.masked)) flash({ kind: "masked", text }); };
  const cancelEdit = () => { setEditing(false); setEditError(null); };
  const open = () => { setEditError(null); setEditing(true); };
  const saved = () => flash({ kind: "saved", text: t("keys.savedNote", { name: keyName(t, entry.id) }) });

  /**
   * Saves a typed value. A key the server needs no one else's word for shows
   * as saved at once (the optimistic entry, the editor closed) and is taken
   * back, with the field and the reason, if the save is refused. The bot's
   * token is checked with Telegram first, so its field waits for the answer.
   */
  const save = async (typed: string): Promise<WriteFailure | null> => {
    const trimmed = typed.trim();
    if (!validKeyValue(entry.id, trimmed)) return "invalid";
    if (entry.id === "telegram") {
      const result = await writeValue(entry.id, typed);
      if (!result.ok) return result.error;
      if (result.answer) optimism.adopt(result.answer);
      cancelEdit(); saved();
      return null;
    }
    const before = entry;
    const shown: KeyEntry = { ...entry, source: "file", masked: maskKey(entry.id, trimmed) };
    optimism.hold(shown);
    cancelEdit(); saved();
    void writeValue(entry.id, typed).then((result) => {
      if (result.ok) {
        optimism.release(shown, null);
        if (result.answer) optimism.adopt(result.answer);
      } else if (optimism.release(shown, before)) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        setNote(null);
        setEditError(result.error);
        setEditing(true);
      }
    });
    return null;
  };
  return { value, note, editing, editError, open, cancelEdit, toggle, copy, copyMasked, save };
}

function KeyRow({ entry, size, staging, owner, focus, optimism }: { entry: KeyEntry; size: Size; staging: boolean; owner: boolean; focus: boolean; optimism: Optimism }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const name = keyName(t, entry.id);
  const actions = useRowActions(entry, optimism);
  const dot = useDot();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const firstButton = useRef<HTMLButtonElement>(null);
  const set = isSet(entry);
  const writable = owner && !staging && entry.source !== "env";
  const sheet = size === "sheet";
  const { open: openEditor } = actions;
  /* Opened from a place that asked for this key: an unset key opens its field, a set one takes focus on its first button. */
  useEffect(() => {
    if (!focus) return;
    if (!set && writable) openEditor();
    else firstButton.current?.focus();
  }, [focus, set, writable, openEditor]);
  const glyph = coarse ? "h-[18px] w-[18px]" : "h-3.5 w-3.5";
  const icons = owner && set ? (
    <>
      <IconButton buttonRef={firstButton} coarse={coarse} label={actions.value === null ? t("keys.reveal", { name }) : t("keys.hide", { name })} pressed={actions.value !== null} onClick={() => void actions.toggle()} data={{ "data-keys-eye": entry.id }}>
        {actions.value === null ? <Eye className={glyph} aria-hidden /> : <EyeOff className={glyph} aria-hidden />}
      </IconButton>
      <IconButton coarse={coarse} label={t("keys.copy", { name })} onClick={() => void actions.copy(t("keys.copiedShort"))} data={{ "data-keys-copy": entry.id }}>
        {actions.note?.kind === "copied" ? <Check className={`${glyph} text-success`} aria-hidden /> : <Copy className={glyph} aria-hidden />}
      </IconButton>
      <button type="button" aria-label={t("keys.more", { name })} title={t("keys.more", { name })} aria-haspopup="menu" aria-expanded={menuAnchor !== null} data-keys-more={entry.id}
        onClick={(event) => { const anchor = event.currentTarget; setMenuAnchor((open) => open ? null : anchor); }}
        className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary ${FOCUS} ${coarse ? "h-11 w-11" : "h-7 w-7"} ${menuAnchor ? "bg-sunken text-primary" : ""}`}>
        <MoreHorizontal className={glyph} aria-hidden />
      </button>
    </>
  ) : null;
  const addButton = writable && !set && !actions.editing ? (
    <button ref={firstButton} type="button" data-keys-add={entry.id} onClick={actions.open}
      className={`shrink-0 whitespace-nowrap rounded-control border border-border bg-card font-semibold text-primary hover:bg-sunken ${FOCUS} ${coarse ? "min-h-11 px-3.5 text-body" : "h-7 px-2.5 text-[11.5px]"}`}>
      {entry.source === "failed" ? t("keys.replace") : t("keys.add")}
    </button>
  ) : null;
  const menuItems = [
    { label: t("keys.copyMasked"), data: "masked", run: () => void actions.copyMasked(t("keys.copiedMasked", { masked: maskedTail(entry.masked ?? "") })) },
    ...(writable ? [{ label: t("keys.replace"), data: "replace", run: actions.open }] : []),
  ];
  const noteLine = actions.note ? (
    <span role="status" data-keys-note={actions.note.kind} className="min-w-0 truncate font-medium text-success">{actions.note.text}</span>
  ) : null;
  const stateWords = entry.source === "missing" ? t("keys.state.missing") : entry.source === "failed" ? t("keys.state.failedShort") : null;
  /* On a touch screen the dot is a 44 px cell of its own at the row's start; elsewhere it leads the second line. */
  const statusDot = <StatusDot entry={entry} dot={dot} coarse={coarse} />;
  const second = noteLine ?? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {coarse ? null : statusDot}
      {stateWords ? <span className={entry.source === "failed" ? "truncate text-warning" : "truncate"}>{stateWords}</span>
        : owner ? <span className="truncate"><span data-keys-masked={entry.id} className="font-mono">{maskedTail(entry.masked ?? "")}</span>{entry.source === "env" && sheet ? <span data-keys-env-tail="">{` · ${t("keys.state.envShort")}`}</span> : null}</span>
        : <span className="truncate">{entry.source === "env" ? t("keys.state.envSource") : t("keys.state.file")}</span>}
    </span>
  );
  return (
    <div data-keys-row={entry.id} data-keys-source={entry.source} className={`flex flex-col ${sheet ? "gap-2 px-4 py-2" : "gap-1 rounded-control px-2 py-1"}`}>
      <div className={`flex items-center gap-1 ${sheet ? "min-h-11" : "min-h-[34px]"}`}>
        {coarse ? <span className="-ml-3 flex shrink-0">{statusDot}</span> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className={`truncate font-semibold text-primary ${sheet ? "text-body leading-5" : "text-[12px] leading-4"}`}>{name}
            {/* The 232 px panel has no room after the masked tail: a key set by a variable says so after its name. */}
            {entry.source === "env" && owner && !sheet ? <span data-keys-env-tail="" className="text-[11px] font-medium text-muted">{` · ${t("keys.state.envShort")}`}</span> : null}</span>
          <span className={`flex min-w-0 font-medium text-muted ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>{second}</span>
        </span>
        {icons}{addButton}
      </div>
      {menuAnchor ? <RowMenu anchor={menuAnchor} items={menuItems} onClose={() => setMenuAnchor(null)} full={!sheet} /> : null}
      <DotNote entry={entry} dot={dot} />
      {actions.value !== null ? (
        <div data-keys-revealed={entry.id} className="flex flex-col gap-0.5">
          <code className={`block select-all break-all rounded-control border border-border bg-sunken font-mono text-primary ${sheet ? "px-3 py-2 text-ui leading-5" : "px-2 py-1 text-[11px] leading-[15px]"}`}>{actions.value}</code>
          <span className={`text-muted ${sheet ? "text-label" : "text-[10.5px]"}`}>{t("keys.revealHides")}</span>
        </div>
      ) : null}
      {actions.editing ? <ValueField entry={entry} size={size} initialError={actions.editError} onSave={actions.save} onCancel={actions.cancelEdit} /> : null}
    </div>
  );
}

/* ---- Notices ------------------------------------------------------------ */

function Notices({ answer, failed, reload, size }: { answer: KeysAnswer | null; failed: boolean; reload: () => void; size: Size }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const box = size === "menu" ? "px-2 py-1.5 text-[11.5px] leading-snug" : "px-3 py-2.5 text-body";
  return (
    <>
      {failed ? (
        <div role="alert" data-keys-failed="" className={`flex flex-col items-start gap-1.5 rounded-control bg-warning-soft text-primary ${box}`}>
          <span>{t("keys.loadFailed")}</span>
          <button type="button" onClick={reload} className={`rounded-control border border-border bg-card px-2.5 font-semibold text-primary hover:bg-sunken ${FOCUS} ${coarse ? "min-h-11 text-body" : "h-7 text-[11.5px]"}`}>{t("keys.retry")}</button>
        </div>
      ) : null}
      {answer?.staging ? <p data-keys-staging="" className={`rounded-control bg-sunken text-secondary ${box}`}>{t("keys.staging")}</p> : null}
      {answer && !answer.owner ? <p data-keys-member="" className={`rounded-control bg-sunken text-secondary ${box}`}>{t("keys.member")}</p> : null}
    </>
  );
}

/* ---- The page ----------------------------------------------------------- */

/** The keys page of the header menu; `onImport` opens the import page under it, `focusKey` the key a place asked for. */
export function KeysMenuPage({ size = "menu", onImport, focusKey = null }: { size?: Size; onImport: () => void; focusKey?: KeyId | null }) {
  const { t } = useLocale();
  const { answer, failed, reload, optimism } = useKeys();
  const [copied, setCopied] = useState<number | null>(null);
  const sheet = size === "sheet";
  const copyAll = async () => {
    let count = 0;
    const text = fetch("/api/keys/export", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { text?: unknown; count?: unknown };
        count = typeof body.count === "number" ? body.count : 0;
        return typeof body.text === "string" ? body.text : null;
      })
      .catch(() => null);
    if (await copyFetched(text)) setCopied(count);
  };
  const row = sheet
    ? "flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : `flex w-full min-h-[30px] items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
  const glyph = sheet ? "h-[18px] w-[18px] shrink-0 text-secondary" : "h-4 w-4 shrink-0 text-secondary";
  return (
    <div data-keys-page="" className={`flex flex-col font-normal ${sheet ? "pb-4" : "pb-1"}`}>
      <div className={`flex flex-col empty:hidden ${sheet ? "gap-2 px-4" : "gap-1.5 px-2"}`}><Notices answer={answer} failed={failed} reload={() => void reload()} size={size} /></div>
      <div data-keys-list="" className="flex flex-col">
        {answer?.keys.map((entry) => <KeyRow key={entry.id} entry={entry} size={size} staging={answer.staging} owner={answer.owner} focus={entry.id === focusKey} optimism={optimism} />)}
      </div>
      {answer?.owner ? (
        <div className="mt-1 flex flex-col border-t border-border pt-1">
          <button type="button" data-keys-copy-all="" className={row} onClick={() => void copyAll()}>
            {copied === null ? <Copy className={glyph} aria-hidden /> : <Check className={`${glyph} text-success`} aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{t("keys.copyAll")}</span>
          </button>
          {copied !== null ? <p role="status" data-keys-copied-all="" className={`${sheet ? "px-4 pb-1 text-label" : "px-2 pb-1 text-[11px] leading-snug"} font-medium text-success`}>{t("keys.copiedAll", { count: copied })}</p> : null}
          {answer.staging ? null : (
            <button type="button" data-keys-open-import="" className={row} onClick={onImport}>
              <ClipboardPaste className={glyph} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t("keys.import")}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---- Import ------------------------------------------------------------- */

const VERDICT: Record<ImportRow["kind"], string> = {
  new: "text-success", replaces: "text-warning", same: "text-muted", env: "text-muted", invalid: "text-danger",
};

const verdictText = (t: T, row: ImportRow, menu: boolean) => row.kind === "replaces"
  ? row.was ? t("keys.import.replaces", { was: maskedTail(row.was) }) : t("keys.import.replacesUnread")
  : row.kind === "env" ? t(menu ? "keys.import.envShort" : "keys.import.env")
  : t(`keys.import.${row.kind}`);

async function postImport(body: { text: string; confirm?: ImportConfirmation }): Promise<Response | null> {
  try { return await fetch("/api/keys/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }); }
  catch { return null; }
}

/**
 * «Import keys»: the pasted NAME=value lines show masked at once, the server
 * answers what each one would do, and nothing is written until «Apply»,
 * which confirms exactly the rows the preview showed (design §7).
 */
export function KeysImportPage({ size = "menu" }: { size?: Size }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const [text, setText] = useState("");
  /* The server's preview of the text it was asked about: a later text, or none, shows no stale answer. */
  const [answered, setAnswered] = useState<{ text: string; preview: ImportPreview | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ saved: number; failed: KeyId[] } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const menu = size === "menu";
  const small = menu ? "text-[11px] leading-[15px]" : "text-label";
  const nameSize = menu ? "text-[12px]" : coarse ? "text-body" : "text-ui";

  useEffect(() => {
    if (!text.trim()) return;
    let current = true;
    void postImport({ text }).then(async (response) => {
      const preview = response?.ok ? await response.json() as ImportPreview : null;
      if (current) setAnswered({ text, preview });
    });
    return () => { current = false; };
  }, [text]);
  const shown = text.trim() && answered?.text === text ? answered : null;
  const preview = shown?.preview ?? null;
  const previewFailed = shown !== null && shown.preview === null;

  const writes = preview?.rows.filter((row) => row.kind === "new" || row.kind === "replaces") ?? [];
  const apply = async () => {
    if (!writes.length || busy) return;
    const confirm: ImportConfirmation = {};
    for (const row of writes) confirm[row.id] = row.kind === "replaces" ? { kind: "replaces", revision: row.revision ?? null } : { kind: "new" };
    setBusy(true);
    const response = await postImport({ text, confirm });
    setBusy(false);
    const outcome = response?.ok ? await response.json() as { saved: KeyId[]; unconfirmed: KeyId[]; failed: { id: KeyId }[] } : null;
    setText("");
    setDone(outcome ? { saved: outcome.saved.length, failed: [...outcome.unconfirmed, ...outcome.failed.map((entry) => entry.id)] } : { saved: 0, failed: writes.map((row) => row.id) });
    window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
  };
  const again = () => { setText(""); setDone(null); window.setTimeout(() => area.current?.focus(), 0); };

  return (
    /* The panel is as tall as its page: in the 232 px menu the page scrolls inside the window, so «Apply» is always reachable. */
    <div data-keys-import-page="" className={`font-normal ${size === "sheet" ? "px-4 pb-4 pt-1" : "max-h-[calc(100dvh-6rem)] overflow-y-auto px-2 pb-1.5"}`}>
      <div data-keys-import="" className={`flex flex-col ${menu ? "gap-1.5" : "gap-3"}`}>
        <p className={`${menu ? "text-[11px] leading-snug" : "text-body"} text-muted`}>{t("keys.import.hint")}</p>
        {/* Once pasted, the lines show with their values masked, in the small mono of the list: the phone's 16 px input floor made the field the largest text on screen. The box shows eight whole lines and scrolls past them; a wrapped line keeps its height (`shrink-0`) instead of being squeezed over the next. */}
        {text.trim() ? (
          <div className="flex flex-col gap-1">
            <div data-keys-import-masked="" role="group" tabIndex={0} aria-label={t("keys.import.aria")}
              className={`flex flex-col overflow-y-auto rounded-control border border-border bg-sunken font-mono text-secondary ${FOCUS} ${menu ? "max-h-[calc(8lh+6px)] px-2 py-1 text-[10.5px] leading-[14px]" : "max-h-[calc(8lh+10px)] px-3 py-2 text-[11.5px] leading-4"}`}>
              {maskPastedLines(text).map((line, index) => <span key={index} className={`block min-h-[1lh] shrink-0 ${line.startsWith("#") ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "break-all"}`}>{line}</span>)}
            </div>
            <div className={`flex items-center justify-between gap-2 ${small}`}>
              <span className="text-muted">{t("keys.import.maskedNote")}</span>
              <button type="button" data-keys-import-again="" onClick={again}
                className={`shrink-0 font-semibold text-secondary underline underline-offset-2 hover:text-primary ${FOCUS} ${coarse ? "min-h-11" : ""}`}>{t("keys.import.again")}</button>
            </div>
          </div>
        ) : (
          <textarea ref={area} value={text} aria-label={t("keys.import.aria")} spellCheck={false} autoComplete="off" rows={menu ? 4 : 5} data-keys-import-text=""
            onChange={(event) => { setText(event.target.value); setDone(null); }} placeholder="OPENROUTER_API_KEY=sk-or-v1-…"
            className={`w-full resize-none rounded-control border border-border bg-canvas font-mono text-primary placeholder:text-muted ${FOCUS} ${menu ? "px-2 py-1 text-[10.5px] leading-[14px] [overflow-wrap:anywhere]" : "px-3 py-2 text-[11.5px] leading-4"}`} />
        )}
        {previewFailed ? <p role="alert" data-keys-import-failed="" className={`text-danger ${small}`}>{t("keys.import.previewFailed")}</p> : null}
        {preview ? (
          <div data-keys-import-preview="" className="flex flex-col">
            {preview.rows.map((row) => (
              <div key={row.id} data-keys-import-row={row.id} data-keys-import-kind={row.kind} className={`flex flex-wrap items-baseline gap-x-2 border-b border-border py-1 last:border-b-0 ${menu ? "" : "min-h-8"}`}>
                <span className={`shrink-0 font-semibold text-primary ${nameSize}`}>{keyName(t, row.id)}</span>
                {row.masked ? <span className={`shrink-0 font-mono text-secondary ${small}`}>{maskedTail(row.masked)}</span> : null}
                {/* In the 232 px panel the verdict takes its own line under the name. */}
                <span className={`min-w-0 font-medium ${VERDICT[row.kind]} ${small} ${menu ? "basis-full" : "flex-1 text-right"}`}>{verdictText(t, row, menu)}</span>
              </div>
            ))}
            {preview.unknown.length ? <p data-keys-import-unknown="" className={`pt-1 text-muted ${small}`}>{t("keys.import.unknown", { names: preview.unknown.join(", ") })}</p> : null}
            {preview.unparsed.length ? <p data-keys-import-unparsed="" className={`pt-1 text-muted ${small}`}>{t("keys.import.unparsed", { lines: preview.unparsed.join(", ") })}</p> : null}
            {preview.rows.some((row) => row.id === "telegram" && (row.kind === "new" || row.kind === "replaces")) ? (
              <p data-keys-import-bot="" className={`mt-1.5 rounded-control bg-warning-soft text-warning ${menu ? "px-2 py-1 text-[11px] leading-snug" : "px-3 py-2 text-label"}`}>{t("keys.import.bot")}</p>
            ) : null}
          </div>
        ) : null}
        {done ? (
          <div role="status" data-keys-import-done="" className={`flex flex-col gap-0.5 rounded-control bg-success-soft text-success ${menu ? "px-2 py-1 text-[11px] leading-snug" : "px-3 py-2 text-label"}`}>
            <span>{t("keys.import.done", { count: done.saved })}</span>
            {done.failed.length ? <span data-keys-import-not-saved="" className="text-danger">{t("keys.import.notSaved", { names: done.failed.map((id) => keyName(t, id)).join(", ") })}</span> : null}
          </div>
        ) : null}
        {preview ? (
          <button type="button" data-keys-import-apply="" disabled={!writes.length || busy} onClick={() => void apply()}
            className={`self-start rounded-control bg-brand px-4 font-semibold text-on-brand disabled:opacity-50 ${FOCUS} ${menu ? "h-7 px-3 text-[11.5px]" : coarse ? "min-h-11 text-body" : "h-9 text-ui"}`}>
            {t("keys.import.apply", { count: writes.length })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
