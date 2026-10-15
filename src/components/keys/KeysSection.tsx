"use client";

import { Check, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, MoreHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { copyText } from "@/components/feed/CopyButton";
import { Z } from "@/components/layers";
import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { useLocale } from "@/lib/i18n";

import { KEY_CATALOG, maskedTail, maskImportText, previewImport, type ImportPreview, type KeyEntry, type KeyId, type KeysAnswer, type KeysVariant } from "./keysPrototype";

/*
 * PROTOTYPE for docs/design/keys-settings.md §4–§7, this lane's branch only.
 * One «Ключі» section in three layouts:
 *   Варіант 1 · «Сторінка в меню»: a page of the header menu (232 px panel on
 *     the desktop, the menu sheet on the phone), import as a page under it;
 *   Варіант 2 · «Діалог ключів»: a 640 px dialog (full screen on the phone),
 *     rows with the variable name and a one-line field, Export… / Import…;
 *   Варіант 3 · «Задані зверху, перенесення окремо»: the same dialog, set keys
 *     first, one «Перенести на іншу машину» with From here / To here.
 * Values come from the prototype's own `/api/keys` answers on placeholders.
 */

export const OPEN_KEYS_DIALOG_EVENT = "delegatus:open-keys-prototype";
const CHANGED = "delegatus:keys-prototype-changed";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

type Layout = "menu" | "sheet" | "dialog";

/* ---- Reading the catalog ---------------------------------------------- */

function useKeys() {
  const [answer, setAnswer] = useState<KeysAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => fetch("/api/keys", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw Error();
      setAnswer(await response.json() as KeysAnswer);
      setFailed(false);
    })
    .catch(() => setFailed(true)), []);
  useEffect(() => {
    const read = () => { void load(); };
    const first = window.setTimeout(read, 0);
    window.addEventListener(CHANGED, read);
    return () => { window.clearTimeout(first); window.removeEventListener(CHANGED, read); };
  }, [load]);
  return { answer, failed, reload: load };
}

async function revealValue(id: KeyId): Promise<string | null> {
  try {
    const response = await fetch(`/api/keys/${id}/reveal`, { method: "POST" });
    if (!response.ok) return null;
    return ((await response.json()) as { value: string }).value;
  } catch { return null; }
}

async function writeValue(id: KeyId, value: string): Promise<"ok" | "invalid" | "failed"> {
  try {
    const response = await fetch(`/api/keys/${id}/value`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    if (response.status === 400) return "invalid";
    if (!response.ok) return "failed";
    window.dispatchEvent(new Event(CHANGED));
    return "ok";
  } catch { return "failed"; }
}

const keyName = (t: ReturnType<typeof useLocale>["t"], id: KeyId) => id === "telegram" ? t("keys.name.telegram") : KEY_CATALOG[id].name;
const isSet = (entry: KeyEntry) => entry.source === "file" || entry.source === "env";

/* ---- The Settings row's state ----------------------------------------- */

/** «Задано 3 із 6» beside a dot: green while every read succeeds, amber when one failed. */
export function KeysStateWord({ size = "menu" }: { size?: "menu" | "sheet" }) {
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
  env: "bg-info",
  missing: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-muted)]",
  failed: "bg-warning",
};

const dotWords = (t: ReturnType<typeof useLocale>["t"], entry: KeyEntry) => entry.source === "file" ? t("keys.state.file")
  : entry.source === "env" ? t("keys.state.env", { variable: entry.variable })
  : entry.source === "failed" ? t("keys.state.failedHint")
  : t("keys.state.missing");

/*
 * The row's status: a dot whose short popover says where the value comes
 * from. The popover opens in the row's flow, under the line with the dot: a
 * floating bubble spilled out of the 232 px menu panel and covered the next
 * row's name and buttons, or the row's own field in the dialog.
 */
function useDot() {
  const [open, setOpenState] = useState(false);
  const id = useId();
  /* The state as the next event sees it, before React renders; a mouse click pins the note until a press elsewhere. */
  const now = useRef(false);
  const pinned = useRef(false);
  const setOpen = useCallback((next: boolean) => { now.current = next; if (!next) pinned.current = false; setOpenState(next); }, []);
  /* A mouse may cross from the dot to the note, and the centred dialog moves up as the note opens: leaving closes after a beat unless the pointer is on either. */
  const leave = useRef<number | null>(null);
  const hoverIn = useCallback(() => { if (leave.current !== null) window.clearTimeout(leave.current); leave.current = null; setOpen(true); }, [setOpen]);
  const hoverOut = useCallback(() => { if (leave.current !== null) window.clearTimeout(leave.current); leave.current = window.setTimeout(() => { leave.current = null; if (!pinned.current) setOpen(false); }, 150); }, [setOpen]);
  useEffect(() => () => { if (leave.current !== null) window.clearTimeout(leave.current); }, []);
  const pin = useCallback(() => { setOpen(true); pinned.current = true; }, [setOpen]);
  const isOpen = useCallback(() => now.current, []);
  return { open, setOpen, id, hoverIn, hoverOut, pin, isOpen };
}

function StatusDot({ entry, dot }: { entry: KeyEntry; dot: ReturnType<typeof useDot> }) {
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
      className={`relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${FOCUS} before:absolute before:-inset-1.5 before:content-['']`}
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

/** The dot's popover, in the row under the line it belongs to. */
function DotNote({ entry, dot, className = "" }: { entry: KeyEntry; dot: ReturnType<typeof useDot>; className?: string }) {
  const { t } = useLocale();
  if (!dot.open) return null;
  return (
    <span role="tooltip" id={dot.id}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") dot.hoverIn(); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") dot.hoverOut(); }}
      className={`block rounded-control border border-border bg-raised px-2.5 py-1.5 text-label leading-4 text-primary shadow-1 ${className}`}>
      <span data-keys-pop={entry.source}>{dotWords(t, entry)}</span>
    </span>
  );
}

function IconButton({ label, onClick, pressed, children, data, coarse }: {
  label: string; onClick: () => void; pressed?: boolean; children: ReactNode; data: Record<string, string>; coarse: boolean;
}) {
  return (
    <button
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

/**
 * The ⋯ of a row: portalled above the sheet or dialog it opens from. In the
 * 232 px menu panel it opens in the row's flow instead: floating there, it
 * covered the next two rows and left torn names and icons around its edges.
 */
function RowMenu({ anchor, items, onClose, inline = false }: { anchor: HTMLElement; items: { label: string; run: () => void; data: string }[]; onClose: () => void; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const box = anchor.getBoundingClientRect();
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); anchor.focus(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  /* Under its ⋯, right edges aligned, as wide as its longest item. */
  const right = Math.max(8, window.innerWidth - box.right);
  const below = box.bottom + 4;
  const top = below + items.length * (coarse ? 44 : 30) + 12 > window.innerHeight ? box.top - 4 - items.length * (coarse ? 44 : 30) - 8 : below;
  const list = items.map((item) => (
    <button key={item.data} type="button" role="menuitem" data-keys-menu-item={item.data}
      className={`flex w-full items-center whitespace-nowrap rounded-control px-2 text-left font-semibold text-primary hover:bg-sunken ${FOCUS} ${coarse ? "min-h-11 text-body" : "min-h-[30px] text-[12px]"}`}
      onClick={() => { onClose(); item.run(); }}>
      {item.label}
    </button>
  ));
  if (inline) return <div ref={ref} role="menu" data-keys-menu="" data-keep-rail-menu="" className="rounded-control border border-border bg-raised p-1 shadow-1">{list}</div>;
  return createPortal(
    <div ref={ref} role="menu" data-keys-menu="" data-keep-rail-menu="" style={{ right, top, maxWidth: window.innerWidth - right - 8 }}
      className={`fixed ${Z.overlay} w-max rounded-surface border border-border bg-raised p-1 shadow-2`}>
      {list}
    </div>,
    document.body,
  );
}

/** The field behind Replace and Add: write-only, emptied on every submit. */
function ValueField({ entry, layout, onDone }: { entry: KeyEntry; layout: Layout; onDone: (saved: boolean) => void }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const input = useRef<HTMLInputElement>(null);
  const [has, setHas] = useState(false);
  const [error, setError] = useState<"invalid" | "failed" | null>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const name = keyName(t, entry.id);
  const control = coarse ? "min-h-11 text-body" : layout === "menu" ? "h-7 text-[11.5px]" : "h-8 text-ui";
  const save = async () => {
    const value = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    setHas(false);
    const result = await writeValue(entry.id, value);
    if (result === "ok") onDone(true);
    else setError(result);
  };
  return (
    <div data-keys-field={entry.id} className="flex w-full flex-col gap-1">
      {/* In the 232 px panel the field takes the whole line and its buttons go under it. */}
      <form className={`flex w-full gap-1 ${layout === "menu" ? "flex-wrap items-center" : ""}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={4096} aria-label={t("keys.fieldAria", { name })}
          placeholder={KEY_CATALOG[entry.id].prefix ? `${KEY_CATALOG[entry.id].prefix}…` : undefined}
          onChange={(event) => { setHas(Boolean(event.target.value.trim())); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDone(false); } }}
          className={`${control} min-w-0 flex-1 ${layout === "menu" ? "basis-full" : ""} rounded-control border bg-canvas px-2 font-mono text-primary placeholder:text-muted ${FOCUS} ${error ? "border-danger" : "border-border"}`} />
        <button type="submit" disabled={!has} data-keys-save=""
          className={`${control} shrink-0 whitespace-nowrap rounded-control border border-border bg-card px-2.5 font-semibold text-primary hover:bg-sunken disabled:opacity-45 ${FOCUS}`}>{t("keys.save")}</button>
        <button type="button" data-keys-cancel="" onClick={() => onDone(false)}
          className={`shrink-0 whitespace-nowrap px-1 font-semibold text-secondary underline underline-offset-2 hover:text-primary ${FOCUS} ${coarse ? "min-h-11 text-label" : layout === "menu" ? "text-[11px]" : "text-label"}`}>{t("keys.cancel")}</button>
      </form>
      {error ? <p role="alert" data-keys-error={error} className={`w-full leading-snug text-danger ${coarse ? "text-label" : "text-[11px]"}`}>{error === "invalid" ? t("keys.invalid", { name }) : t("providerKey.failed")}</p> : null}
    </div>
  );
}

/* ---- One key ------------------------------------------------------------ */

type Note = { kind: "copied" | "masked" | "saved"; text: string } | null;

function useRowActions(entry: KeyEntry) {
  const [value, setValue] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [editing, setEditing] = useState(false);
  const timer = useRef<number | null>(null);
  const flash = (next: Note) => {
    setNote(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 2000);
  };
  useEffect(() => {
    if (value === null) return;
    const hide = window.setTimeout(() => setValue(null), 30_000);
    return () => window.clearTimeout(hide);
  }, [value]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const toggle = async () => { if (value !== null) setValue(null); else setValue(await revealValue(entry.id)); };
  const copy = async (text: string) => {
    const secret = await revealValue(entry.id);
    if (secret !== null && await copyText(secret)) flash({ kind: "copied", text });
  };
  const copyMasked = async (text: string) => { if (entry.masked && await copyText(entry.masked)) flash({ kind: "masked", text }); };
  return { value, note, editing, setEditing, toggle, copy, copyMasked, flash };
}

function KeyRow({ entry, layout, staging, owner, grouped = false }: { entry: KeyEntry; layout: Layout; staging: boolean; owner: boolean; grouped?: boolean }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const name = keyName(t, entry.id);
  const actions = useRowActions(entry);
  const dot = useDot();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menu = menuAnchor !== null;
  const set = isSet(entry);
  const writable = owner && !staging && entry.source !== "env";
  const sizes = coarse ? "h-[18px] w-[18px]" : "h-3.5 w-3.5";
  const icons = owner && set ? (
    <>
      {layout === "dialog" ? null : (
        <IconButton coarse={coarse} label={actions.value === null ? t("keys.reveal", { name }) : t("keys.hide", { name })} pressed={actions.value !== null} onClick={() => void actions.toggle()} data={{ "data-keys-eye": entry.id }}>
          {actions.value === null ? <Eye className={sizes} aria-hidden /> : <EyeOff className={sizes} aria-hidden />}
        </IconButton>
      )}
      <IconButton coarse={coarse} label={t("keys.copy", { name })} onClick={() => void actions.copy(t(layout === "menu" ? "keys.copiedShort" : "keys.copied"))} data={{ "data-keys-copy": entry.id }}>
        {actions.note?.kind === "copied" ? <Check className={`${sizes} text-success`} aria-hidden /> : <Copy className={sizes} aria-hidden />}
      </IconButton>
      <button type="button" aria-label={t("keys.more", { name })} title={t("keys.more", { name })} aria-haspopup="menu" aria-expanded={menu} data-keys-more={entry.id}
        onClick={(event) => { const anchor = event.currentTarget; setMenuAnchor((open) => open ? null : anchor); }}
        className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-primary ${FOCUS} ${coarse ? "h-11 w-11" : "h-7 w-7"} ${menu ? "bg-sunken text-primary" : ""}`}>
        <MoreHorizontal className={sizes} aria-hidden />
      </button>
    </>
  ) : null;
  const addButton = owner && !staging && (entry.source === "missing" || entry.source === "failed") && !actions.editing ? (
    <button type="button" data-keys-add={entry.id} onClick={() => actions.setEditing(true)}
      className={`shrink-0 whitespace-nowrap rounded-control border border-border bg-card font-semibold text-primary hover:bg-sunken ${FOCUS} ${coarse ? "min-h-11 px-3.5 text-body" : "h-7 px-2.5 text-[11.5px]"}`}>
      {entry.source === "failed" ? t("keys.replace") : t("keys.add")}
    </button>
  ) : null;
  const menuItems = [
    { label: t("keys.copyMasked"), data: "masked", run: () => void actions.copyMasked(t("keys.copiedMasked", { masked: layout === "menu" ? maskedTail(entry.masked ?? "") : entry.masked ?? "" })) },
    ...(writable ? [{ label: t("keys.replace"), data: "replace", run: () => actions.setEditing(true) }] : []),
  ];
  const noteLine = actions.note ? (
    <span role="status" data-keys-note={actions.note.kind} className="min-w-0 truncate font-medium text-success">{actions.note.text}</span>
  ) : null;
  const stateWords = entry.source === "missing" ? t("keys.state.missing") : entry.source === "failed" ? t(layout === "menu" ? "keys.state.failedShort" : "keys.state.failed") : null;
  const field = actions.editing ? <ValueField entry={entry} layout={layout} onDone={(saved) => { actions.setEditing(false); if (saved) actions.flash({ kind: "saved", text: t("keys.savedNote", { name }) }); }} /> : null;
  const portal = menuAnchor ? <RowMenu anchor={menuAnchor} items={menuItems} onClose={() => setMenuAnchor(null)} inline={layout === "menu"} /> : null;

  if (layout !== "dialog") {
    /* Варіант 1: name over the dot and the masked tail, the three icons at the right. */
    const sheet = layout === "sheet";
    const second = noteLine ?? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusDot entry={entry} dot={dot} />
        {stateWords ? <span className={entry.source === "failed" ? "truncate text-warning" : "truncate"}>{stateWords}</span>
          : owner ? <span className="truncate"><span className="font-mono">{maskedTail(entry.masked ?? "")}</span>{entry.source === "env" && sheet ? ` · ${t("keys.state.envShort")}` : ""}</span>
          : <span className="truncate">{entry.source === "env" ? t("keys.state.envShort") : t("keys.state.file")}</span>}
      </span>
    );
    return (
      <div data-keys-row={entry.id} data-keys-source={entry.source} className={`flex flex-col ${sheet ? "gap-2 px-4 py-2" : "gap-1 rounded-control px-2 py-1"}`}>
        <div className={`flex items-center gap-1 ${sheet ? "min-h-11" : "min-h-[34px]"}`}>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className={`truncate font-semibold text-primary ${sheet ? "text-body leading-5" : "text-[12px] leading-4"}`}>{name}</span>
            <span className={`flex min-w-0 font-medium text-muted ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>{second}</span>
          </span>
          {icons}{addButton}
        </div>
        {layout === "menu" ? portal : null}
        <DotNote entry={entry} dot={dot} />
        {actions.value !== null ? (
          <div data-keys-revealed={entry.id} className="flex flex-col gap-0.5">
            <code className={`block select-all break-all rounded-control border border-border bg-sunken font-mono text-primary ${sheet ? "px-3 py-2 text-ui leading-5" : "px-2 py-1 text-[11px] leading-[15px]"}`}>{actions.value}</code>
            <span className={`text-muted ${sheet ? "text-label" : "text-[10.5px]"}`}>{t("keys.revealHides")}</span>
          </div>
        ) : null}
        {field}
        {layout === "menu" ? null : portal}
      </div>
    );
  }

  /* In Варіант 3's «Не задано» and «Не читається» groups the heading already says it: the button stands on the name's line. */
  const oneLine = grouped && !set && !coarse && addButton !== null;
  /* On the phone an unset key is three short lines (name, what uses it, the variable) with its button at the right, as in Варіант 1. */
  const phoneUnset = coarse && owner && !set;
  /* Варіанти 2 і 3: name, what uses it and the variable on the first line, a field with the eye inside on the second. */
  const fieldBox = !set || !owner ? (
    <span data-keys-value={entry.id} className={`min-w-0 flex-1 ${entry.source === "failed" ? "text-warning" : "text-muted"} ${coarse ? "text-body" : "text-ui"}`}>
      {!owner ? (entry.source === "env" ? t("keys.state.envSource") : set ? t("keys.state.file") : t("keys.state.missing")) : grouped && entry.source === "missing" ? "" : stateWords}
    </span>
  ) : (
    <div data-keys-value={entry.id} className={`flex min-w-0 flex-1 items-center rounded-control border border-border bg-canvas ${coarse ? "min-h-11" : "min-h-8"}`}>
      {actions.value !== null ? (
        <code data-keys-revealed={entry.id} className={`min-w-0 flex-1 select-all break-all px-2.5 py-1 font-mono text-primary ${coarse ? "text-ui leading-5" : "text-[11.5px] leading-4"}`}>{actions.value}</code>
      ) : (
        <span className={`min-w-0 flex-1 truncate px-2.5 font-mono text-secondary ${coarse ? "text-ui" : "text-[11.5px]"}`}>
          {entry.masked}
        </span>
      )}
      {owner && set ? (
        <IconButton coarse={coarse} label={actions.value === null ? t("keys.reveal", { name }) : t("keys.hide", { name })} pressed={actions.value !== null} onClick={() => void actions.toggle()} data={{ "data-keys-eye": entry.id }}>
          {actions.value === null ? <Eye className={sizes} aria-hidden /> : <EyeOff className={sizes} aria-hidden />}
        </IconButton>
      ) : null}
    </div>
  );
  const variableLine = phoneUnset ? (
    <span className="text-label text-muted">
      {grouped ? null : <span className={entry.source === "failed" ? "text-warning" : ""}>{stateWords} · </span>}
      <span className="font-mono text-[10.5px]">{entry.variable}</span>
    </span>
  ) : <span className="font-mono text-[10.5px] text-muted">{entry.variable}</span>;
  return (
    <div data-keys-row={entry.id} data-keys-source={entry.source} className={`flex flex-col border-b border-border last:border-b-0 ${coarse ? "gap-2 py-3" : "gap-1.5 py-2.5"}`}>
      {phoneUnset ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="mt-0.5 self-start"><StatusDot entry={entry} dot={dot} /></span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-semibold leading-5 text-primary">{name}</span>
            <span className="truncate text-label leading-4 text-muted">{t(`keys.for.${entry.id}`)}</span>
            {variableLine}
          </span>
          {addButton}
        </div>
      ) : (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusDot entry={entry} dot={dot} />
        <span className={`shrink-0 font-semibold text-primary ${coarse ? "text-body" : "text-ui"}`}>{name}</span>
        <span className={`min-w-0 flex-1 truncate text-muted ${coarse ? "basis-full pl-6 text-label" : "text-label"}`}>{t(`keys.for.${entry.id}`)}</span>
        {coarse ? null : <span className="shrink-0 font-mono text-[10.5px] text-muted">{entry.variable}</span>}
        {oneLine ? <span className="ml-1 shrink-0">{addButton}</span> : null}
      </div>
      )}
      <DotNote entry={entry} dot={dot} className={coarse ? "" : "ml-6"} />
      {oneLine || phoneUnset ? null : (
        <div className={`flex items-center gap-1 ${coarse ? "" : "pl-6"}`}>
          {fieldBox}
          {icons}{addButton}
        </div>
      )}
      {coarse && !phoneUnset ? variableLine : null}
      {noteLine ? <span className={`text-label ${coarse ? "" : "pl-6"}`}>{noteLine}</span> : null}
      {field ? <div className={coarse ? "" : "pl-6"}>{field}</div> : null}
      {portal}
    </div>
  );
}

/* ---- Moving keys ------------------------------------------------------- */

function ExportPanel({ answer, coarse, allowFile }: { answer: KeysAnswer; coarse: boolean; allowFile: boolean }) {
  const { t } = useLocale();
  const set = answer.keys.filter(isSet);
  const [chosen, setChosen] = useState<Set<KeyId>>(() => new Set(set.map((entry) => entry.id)));
  const [format, setFormat] = useState<"lines" | "file">("lines");
  const [copied, setCopied] = useState<number | null>(null);
  const count = chosen.size;
  const copy = async () => {
    const lines: string[] = [`# Delegatus keys · 2026-10-15 · ${count}`];
    for (const entry of set) if (chosen.has(entry.id)) {
      const value = await revealValue(entry.id);
      if (value) lines.push(`${entry.variable}=${value}`);
    }
    if (await copyText(lines.join("\n"))) setCopied(count);
  };
  const text = coarse ? "text-body" : "text-ui";
  const small = "text-label";
  const primary = `rounded-control bg-brand px-4 font-semibold text-on-brand disabled:opacity-50 ${FOCUS} ${coarse ? "min-h-11 text-body" : "h-9 text-ui"}`;
  return (
    <div data-keys-export="" className="flex flex-col gap-4">
      <p className={`${text} text-muted`}>{t("keys.export.intro")}</p>
      {allowFile ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={`mb-1.5 ${text} font-semibold text-primary`}>{t("keys.export.format")}</legend>
          {(["lines", "file"] as const).map((option) => (
            <label key={option} data-keys-format={option} className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2 ${format === option ? "border-accent bg-accent/5" : "border-border"}`}>
              <input type="radio" name="keys-format" checked={format === option} onChange={() => setFormat(option)} className="mt-1 accent-[var(--color-accent)]" />
              <span className="flex min-w-0 flex-col">
                <span className={`${text} font-semibold text-primary`}>{t(option === "lines" ? "keys.export.lines" : "keys.export.file")}</span>
                <span className={`${small} text-muted`}>{t(option === "lines" ? "keys.export.linesHint" : "keys.export.fileHint")}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="flex flex-col">
        <legend className={`mb-1.5 ${text} font-semibold text-primary`}>{t("keys.export.what")}</legend>
        {set.map((entry) => (
          <label key={entry.id} data-keys-export-row={entry.id} className={`flex cursor-pointer items-center gap-2.5 border-b border-border last:border-b-0 ${coarse ? "min-h-11" : "min-h-8"}`}>
            <input type="checkbox" checked={chosen.has(entry.id)} onChange={(event) => setChosen((was) => { const next = new Set(was); if (event.target.checked) next.add(entry.id); else next.delete(entry.id); return next; })} className="accent-[var(--color-accent)]" />
            <span className={`min-w-0 flex-1 truncate ${text} font-semibold text-primary`}>{keyName(t, entry.id)}</span>
            <span className={`shrink-0 ${small} text-muted`}>{entry.source === "env" ? t("keys.state.envSource") : t("keys.state.file")}</span>
            <span className={`shrink-0 font-mono ${small} text-secondary`}>{maskedTail(entry.masked ?? "")}</span>
          </label>
        ))}
      </fieldset>
      <p className={`${small} leading-snug text-muted`}>{t("keys.export.never")}</p>
      {format === "lines" ? (
        <div className="flex flex-col gap-2">
          <p className={`rounded-control bg-warning-soft px-3 py-2 ${small} text-warning`}>{t("keys.export.clipboard")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" data-keys-export-copy="" disabled={!count} onClick={() => void copy()} className={primary}>{t("keys.export.copy", { count })}</button>
            {copied !== null ? <span role="status" data-keys-export-copied="" className={`${small} font-medium text-success`}>{t("keys.export.copied", { count: copied })}</span> : null}
          </div>
        </div>
      ) : (
        <div data-keys-export-file="" className="flex flex-col gap-2">
          <span className={`${small} font-semibold text-secondary`}>{t("keys.export.passphrase")}</span>
          <div className="flex items-center gap-1 rounded-control border border-border bg-sunken pl-3">
            <code className={`min-w-0 flex-1 break-all font-mono ${text} tracking-wide text-primary`}>ABCD-EFGH-JKLM-NPQR-STUV-WXYZ</code>
            <IconButton coarse={coarse} label={t("common.copy")} onClick={() => void copyText("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ")} data={{ "data-keys-passphrase-copy": "" }}><Copy className="h-3.5 w-3.5" aria-hidden /></IconButton>
          </div>
          <div className="flex flex-col items-start gap-1">
            <button type="button" disabled={!count} className={primary}>{t("keys.export.download")}</button>
            <span className={`font-mono ${small} text-muted`}>delegatus-keys-2026-10-15.dlgkeys</span>
          </div>
        </div>
      )}
    </div>
  );
}

const VERDICT: Record<"new" | "replaces" | "same" | "env" | "invalid", string> = {
  new: "text-success", replaces: "text-warning", same: "text-muted", env: "text-muted", invalid: "text-danger",
};

function ImportPanel({ answer, layout, onApplied }: { answer: KeysAnswer; layout: Layout; onApplied?: () => void }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const [text, setText] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const preview: ImportPreview | null = text.trim() ? previewImport(text, answer.keys) : null;
  const writes = preview?.rows.filter((row) => row.kind === "new" || row.kind === "replaces") ?? [];
  const menu = layout === "menu";
  const size = menu ? "text-[11px] leading-[15px]" : "text-label";
  const nameSize = menu ? "text-[12px]" : coarse ? "text-body" : "text-ui";
  useEffect(() => () => setText(""), []);
  const apply = async () => {
    let saved = 0;
    for (const row of writes) if ((await writeValue(row.id, row.value)) === "ok") saved += 1;
    setText("");
    setDone(saved);
    onApplied?.();
  };
  return (
    <div data-keys-import="" className={`flex flex-col ${menu ? "gap-1.5" : "gap-3"}`}>
      <p className={`${menu ? "text-[11px] leading-snug" : coarse ? "text-body" : "text-ui"} text-muted`}>{t("keys.import.hint")}</p>
      {/* Once pasted, the lines show with their values masked, in the small mono of the list: the phone's 16 px input floor made the field the largest text on the screen. */}
      {preview ? (
        <div className="flex flex-col gap-1">
          <div data-keys-import-masked="" role="group" aria-label={t("keys.import.aria")}
            className={`flex flex-col rounded-control border border-border bg-sunken font-mono text-secondary ${menu ? "px-2 py-1 text-[10.5px] leading-[14px]" : "px-3 py-2 text-[11.5px] leading-4"}`}>
            {maskImportText(text).map((line, index) => <span key={index} className={`block min-h-[1lh] ${line.startsWith("#") ? "truncate whitespace-pre" : "break-all"}`}>{line}</span>)}
          </div>
          <div className={`flex items-center justify-between gap-2 ${size}`}>
            <span className="text-muted">{t("keys.import.maskedNote")}</span>
            <button type="button" data-keys-import-again="" onClick={() => { setText(""); setDone(null); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")?.focus(), 0); }}
              className={`shrink-0 font-semibold text-secondary underline underline-offset-2 hover:text-primary ${FOCUS} ${coarse ? "min-h-11" : ""}`}>{t("keys.import.again")}</button>
          </div>
        </div>
      ) : (
        <textarea value={text} aria-label={t("keys.import.aria")} spellCheck={false} autoComplete="off" rows={menu ? 4 : 5} data-keys-import-text=""
          onChange={(event) => { setText(event.target.value); setDone(null); }} placeholder="OPENROUTER_API_KEY=sk-or-v1-…"
          className={`w-full resize-none rounded-control border border-border bg-canvas font-mono text-primary placeholder:text-muted ${FOCUS} ${menu ? "px-2 py-1 text-[10.5px] leading-[14px] [overflow-wrap:anywhere]" : "px-3 py-2 text-[11.5px] leading-4"}`} />
      )}
      {preview ? (
        <div data-keys-import-preview="" className="flex flex-col">
          {preview.rows.map((row) => (
            <div key={row.id} data-keys-import-row={row.id} data-keys-import-kind={row.kind} className={`flex flex-wrap items-baseline gap-x-2 border-b border-border py-1 last:border-b-0 ${menu ? "" : "min-h-8"}`}>
              <span className={`shrink-0 font-semibold text-primary ${nameSize}`}>{keyName(t, row.id)}</span>
              {"masked" in row ? <span className={`shrink-0 font-mono text-secondary ${size}`}>{maskedTail(row.masked)}</span> : null}
              {/* In the 232 px panel the verdict takes its own line under the name. */}
              <span className={`min-w-0 font-medium ${VERDICT[row.kind]} ${size} ${menu ? "basis-full" : "flex-1 text-right"}`}>
                {row.kind === "replaces" ? t("keys.import.replaces", { was: maskedTail(row.was) }) : t(row.kind === "env" && menu ? "keys.import.envShort" : `keys.import.${row.kind}`)}
              </span>
            </div>
          ))}
          {preview.unknown.length ? <p data-keys-import-unknown="" className={`pt-1 text-muted ${size}`}>{t("keys.import.unknown", { names: preview.unknown.join(", ") })}</p> : null}
          {preview.unparsed.length ? <p data-keys-import-unparsed="" className={`pt-1 text-muted ${size}`}>{t("keys.import.unparsed", { lines: preview.unparsed.join(", ") })}</p> : null}
          {preview.rows.some((row) => row.id === "telegram" && (row.kind === "new" || row.kind === "replaces")) ? (
            <p data-keys-import-bot="" className={`mt-1.5 rounded-control bg-warning-soft text-warning ${menu ? "px-2 py-1 text-[11px] leading-snug" : "px-3 py-2 text-label"}`}>{t("keys.import.bot")}</p>
          ) : null}
        </div>
      ) : null}
      {done !== null ? <p role="status" data-keys-import-done="" className={`rounded-control bg-success-soft text-success ${menu ? "px-2 py-1 text-[11px] leading-snug" : "px-3 py-2 text-label"}`}>{t("keys.import.done", { count: done })}</p> : null}
      {preview ? (
        <button type="button" data-keys-import-apply="" disabled={!writes.length} onClick={() => void apply()}
          className={`self-start rounded-control bg-brand px-4 font-semibold text-on-brand disabled:opacity-50 ${FOCUS} ${menu ? "h-7 px-3 text-[11.5px]" : coarse ? "min-h-11 text-body" : "h-9 text-ui"}`}>
          {t("keys.import.apply", { count: writes.length })}
        </button>
      ) : null}
    </div>
  );
}

/* ---- Notices ------------------------------------------------------------ */

function Notices({ answer, failed, reload, layout }: { answer: KeysAnswer | null; failed: boolean; reload: () => void; layout: Layout }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const box = layout === "menu" ? "px-2 py-1.5 text-[11.5px] leading-snug" : coarse ? "px-3 py-2.5 text-body" : "px-3 py-2 text-ui";
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

/* ---- Варіант 1: a page of the menu ------------------------------------- */

/** The keys page of the header menu; `onImport` opens the import page under it. */
export function KeysMenuPage({ size = "menu", onImport }: { size?: "menu" | "sheet"; onImport: () => void }) {
  const { t } = useLocale();
  const { answer, failed, reload } = useKeys();
  const [copied, setCopied] = useState<number | null>(null);
  const sheet = size === "sheet";
  const copyAll = async () => {
    if (!answer) return;
    const rows = answer.keys.filter(isSet);
    const lines = [`# Delegatus keys · 2026-10-15 · ${rows.length}`];
    for (const entry of rows) { const value = await revealValue(entry.id); if (value) lines.push(`${entry.variable}=${value}`); }
    if (await copyText(lines.join("\n"))) setCopied(rows.length);
  };
  const row = sheet
    ? "flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : `flex w-full min-h-[30px] items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
  const glyph = sheet ? "h-[18px] w-[18px] shrink-0 text-secondary" : "h-4 w-4 shrink-0 text-secondary";
  const transfer = answer && answer.owner;
  return (
    <div data-keys-page="" data-keys-variant="1" className={`flex flex-col font-normal ${sheet ? "pb-4" : "pb-1"}`}>
      <div className={`flex flex-col ${sheet ? "gap-2 px-4" : "gap-1.5 px-2"}`}><Notices answer={answer} failed={failed} reload={() => void reload()} layout={size} /></div>
      <div data-keys-list="" className="flex flex-col">
        {answer?.keys.map((entry) => <KeyRow key={entry.id} entry={entry} layout={size} staging={answer.staging} owner={answer.owner} />)}
      </div>
      {transfer ? (
        <div className={`mt-1 flex flex-col border-t border-border ${sheet ? "pt-1" : "pt-1"}`}>
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

/** Варіант 1's import page. */
export function KeysImportPage({ size = "menu" }: { size?: "menu" | "sheet" }) {
  const { answer } = useKeys();
  return (
    <div data-keys-import-page="" className={`font-normal ${size === "sheet" ? "px-4 pb-4 pt-1" : "px-2 pb-1.5"}`}>
      {answer ? <ImportPanel answer={answer} layout={size === "sheet" ? "sheet" : "menu"} /> : null}
    </div>
  );
}

/* ---- Варіанти 2 і 3: the dialog ----------------------------------------- */

type Step = "list" | "export" | "import" | "move";

export function KeysDialog({ variant, onClose }: { variant: Exclude<KeysVariant, 1>; onClose: () => void }) {
  const { t } = useLocale();
  const coarse = useCoarsePointer();
  const { answer, failed, reload } = useKeys();
  const [step, setStep] = useState<Step>("list");
  const [tab, setTab] = useState<"from" | "to">("from");
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("[data-keys-menu]")) onClose(); };
    window.addEventListener("keydown", key);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const set = answer?.keys.filter(isSet) ?? [];
  const unreadable = answer?.keys.filter((entry) => entry.source === "failed") ?? [];
  const unset = answer?.keys.filter((entry) => entry.source === "missing") ?? [];
  const canMove = Boolean(answer?.owner);
  const secondary = `rounded-control border border-border bg-card px-4 font-semibold text-primary hover:bg-sunken disabled:opacity-50 ${FOCUS} ${coarse ? "min-h-11 flex-1 text-body" : "h-9 text-ui"}`;
  const primary = `rounded-control bg-brand px-4 font-semibold text-on-brand disabled:opacity-50 ${FOCUS} ${coarse ? "min-h-11 flex-1 text-body" : "h-9 text-ui"}`;
  const rows = (list: KeyEntry[], grouped = false) => list.map((entry) => <KeyRow key={entry.id} entry={entry} layout="dialog" staging={answer!.staging} owner={answer!.owner} grouped={grouped} />);
  const group = (label: string, list: KeyEntry[], name: string) => list.length ? (
    <section data-keys-group={name} aria-label={label} className="flex flex-col">
      <h3 className={`border-b border-border pb-1.5 font-semibold uppercase tracking-[0.06em] text-muted ${coarse ? "text-label" : "text-caption"}`}>{label}</h3>
      {rows(list, true)}
    </section>
  ) : null;

  const title = step === "list" ? t("keys.title") : step === "export" ? t("keys.exportStep").replace("…", "") : step === "import" ? t("keys.import") : t("keys.move");
  const body = !answer ? null
    : step === "export" ? <ExportPanel answer={answer} coarse={coarse} allowFile />
    : step === "import" ? <ImportPanel answer={answer} layout="dialog" />
    : step === "move" ? (
      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label={t("keys.move")} className="grid grid-cols-2 gap-1 rounded-control bg-sunken p-1">
          {(["from", "to"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} data-keys-tab={id} onClick={() => setTab(id)}
              className={`rounded-[6px] font-semibold ${FOCUS} ${coarse ? "min-h-11 text-body" : "h-8 text-ui"} ${tab === id ? "bg-card text-primary shadow-1" : "text-secondary hover:text-primary"}`}>
              {t(id === "from" ? "keys.move.from" : "keys.move.to")}
            </button>
          ))}
        </div>
        {tab === "from" ? <ExportPanel answer={answer} coarse={coarse} allowFile /> : <ImportPanel answer={answer} layout="dialog" />}
      </div>
    )
    : variant === 3 ? (
      <div className="flex flex-col gap-5">
        {group(t("keys.groupSet"), set, "set")}
        {group(t("keys.groupFailed"), unreadable, "failed")}
        {group(t("keys.groupUnset"), unset, "unset")}
      </div>
    ) : <div data-keys-list="" className="flex flex-col">{rows(answer.keys)}</div>;

  const footer = step !== "list" ? null : variant === 2 ? (
    canMove ? (
      <>
        <button type="button" data-keys-open-export="" className={secondary} onClick={() => setStep("export")}>{t("keys.exportStep")}</button>
        {answer?.staging ? null : <button type="button" data-keys-open-import="" className={secondary} onClick={() => setStep("import")}>{t("keys.importStep")}</button>}
      </>
    ) : null
  ) : canMove ? <button type="button" data-keys-open-move="" className={primary} onClick={() => { setTab("from"); setStep("move"); }}>{t("keys.move")}</button> : null;

  return (
    /* Anchored at the top: a note or field opening in a row grows the dialog downwards and leaves the row under the pointer. */
    <div className={`fixed inset-0 ${Z.modal} flex items-start justify-center bg-black/40 p-0 sm:px-8 sm:pb-8 sm:pt-[12vh]`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("keys.title")} data-keys-dialog="" data-keys-variant={variant} data-keys-step={step}
        className="flex h-full w-full max-w-[640px] flex-col overflow-hidden bg-canvas shadow-2 outline-none sm:h-auto sm:max-h-[80vh] sm:rounded-[12px] sm:border sm:border-border">
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border pl-4 pr-1.5 sm:pl-6">
          {step !== "list" ? (
            <button type="button" data-keys-back="" aria-label={t("keys.backToList")} title={t("keys.backToList")} onClick={() => setStep("list")}
              className={`-ml-2 flex h-11 w-11 items-center justify-center rounded-control text-secondary hover:bg-sunken ${FOCUS}`}>
              <ChevronRight className="h-5 w-5 rotate-180" aria-hidden />
            </button>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-title font-bold text-primary">{title}</h2>
          {step === "list" && variant === 3 && answer ? <span data-keys-summary="" className="shrink-0 text-ui font-medium text-muted">{t("keys.rowState", { set: set.length, total: answer.keys.length })}</span> : null}
          {step === "list" && variant === 3 && footer && !coarse ? <span className="ml-2 shrink-0">{footer}</span> : null}
          <button type="button" aria-label={t("common.close")} onClick={onClose} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken ${FOCUS}`}><X className="h-5 w-5" aria-hidden /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6 sm:py-4">
          <div className="mb-2 flex flex-col gap-2 empty:hidden"><Notices answer={answer} failed={failed} reload={() => void reload()} layout="dialog" /></div>
          {body}
        </div>
        {footer && (variant === 2 || coarse) ? (
          <footer data-keys-footer="" className="flex shrink-0 gap-2 border-t border-border px-4 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] sm:px-6">{footer}</footer>
        ) : null}
      </section>
    </div>
  );
}

export function openKeysDialog(): void {
  window.dispatchEvent(new Event(OPEN_KEYS_DIALOG_EVENT));
}

export function KeysDialogHost({ variant }: { variant: KeysVariant | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_KEYS_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_KEYS_DIALOG_EVENT, onOpen);
  }, []);
  return open && (variant === 2 || variant === 3) ? <KeysDialog variant={variant} onClose={() => setOpen(false)} /> : null;
}
