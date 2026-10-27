"use client";

import { BookMarked } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { SettingSwitch } from "@/components/ProjectSettingRow";
import { relativeTime } from "@/components/team/ui";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";
import type { MemorySourceView } from "@/lib/memory/viewTypes";

/* The installation's one memory (docs/design/memory-source-switch.md §3.4): a
   row of the Settings page beside Shared memory, drawn like the worker limit
   with an icon, a title and a muted state line, and the board's switch. The
   press moves the switch and the line at once and writes in the background; a
   refused write puts both back and says so in the same line. Only the
   import's counts are the server's, and they arrive with the next read. */

export type MemorySourceState = "loading" | "unknown" | "unchosen" | "preparing" | "importing" | "draining" | "active" | "engines";

/** A failed read is a state nobody can vouch for, as on the Shared memory row; the switch keeps the last reading. */
export function memorySourceState(view: MemorySourceView | null, readFailed: boolean): MemorySourceState {
  if (readFailed) return "unknown";
  if (!view) return "loading";
  if (view.choice === null) return "unchosen";
  if (view.choice === "engines") return "engines";
  if (view.phase === "draining" || view.phase === "active") return view.phase;
  return view.import?.counts ? "importing" : "preparing";
}

/** The state line's words; `now` places the last sync run. */
export function memorySourceLine(view: MemorySourceView | null, readFailed: boolean, t: TFunction, locale: Locale, now = Date.now()): string {
  const state = memorySourceState(view, readFailed);
  const reason = (value: NonNullable<MemorySourceView["lastFailure"]>["reason"]) => t(`memorySource.reason.${value}`);
  const hold = view?.import?.hold ? ` ${t("memorySource.hold", { reason: reason(view.import.hold) })}` : "";
  /* Admission holds the import's next passes (§4.5), and an undone pass is told after the state's words (§4.7). */
  const waits = view?.import?.admission ? ` ${t("memorySource.admission", { reason: t(`memorySource.admission.${view.import.admission}`) })}` : "";
  const undo = view?.import?.undo ? ` ${view.import.undo.state === "undone" ? t("memorySource.undone") : t("memorySource.partlyUndone", { count: view.import.undo.kept })}` : "";
  const failure = view?.lastFailure ? ` ${t("memorySource.lastFailure", { reason: reason(view.lastFailure.reason) })}` : "";
  switch (state) {
    case "loading": return t("memorySource.loading");
    case "unknown": return t("memorySource.readFailed");
    case "unchosen": return t("memorySource.unchosen") + failure;
    case "preparing": return t("memorySource.preparing") + hold + waits;
    case "importing": {
      const counts = view!.import!.counts!;
      /* Files are counted; parts are named only while a file of several still has one left (§4.4). */
      const parts = counts.pendingParts > counts.pendingFiles ? t("memorySource.partsLeft", { count: counts.pendingParts }) : "";
      return t("memorySource.importing", { done: counts.files - counts.pendingFiles, total: counts.files, parts }) + hold + waits + undo;
    }
    case "draining": {
      const left = view!.import?.remainingGenerations ?? 0;
      return (left ? t("memorySource.draining", { count: left }) : t("memorySource.drainingLast")) + hold + waits + undo;
    }
    case "active": return t("memorySource.active") + hold + undo;
    case "engines": return [t("memorySource.engines"), syncLine(view!.sync, t, locale, now)].filter(Boolean).join(" ") + undo + failure;
  }
}

function syncLine(sync: MemorySourceView["sync"], t: TFunction, locale: Locale, now: number): string {
  if (!sync) return "";
  if (sync.intervalHours === 0) return t("memorySource.sync.off");
  const detail = (sync.failure ? t("memorySource.sync.failed", { reason: t(`memorySource.reason.${sync.failure}`) })
    : sync.lastAt ? t("memorySource.sync.last", { when: relativeTime(sync.lastAt, locale, now, "long"), added: t("memorySource.sync.added", { count: sync.added }) })
    : t("memorySource.sync.never")) + (sync.capped && !sync.failure ? t("memorySource.sync.capped") : "");
  if (sync.intervalHours === 24) return t("memorySource.sync.daily", { detail });
  if (sync.intervalHours === 1) return t("memorySource.sync.hourly", { detail });
  return t("memorySource.sync.every", { count: sync.intervalHours, detail });
}

const READ_MS = 15_000;

export function MemorySourceRow({ phone = false, readEveryMs = READ_MS }: { phone?: boolean; readEveryMs?: number }) {
  const { t, locale } = useLocale();
  const stateId = useId();
  const [view, setView] = useState<MemorySourceView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  /* A read that started before a write never lands over what came after it, and a
     second press while one is out sends nothing. */
  const revision = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    const read = async () => {
      if (writing.current) return;
      const current = ++revision.current;
      try {
        const response = await fetch("/api/memory/source", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw Error("read refused");
        const value = await response.json() as MemorySourceView;
        if (current === revision.current && !abort.signal.aborted) { setView(value); setReadFailed(false); setSaveFailed(false); }
      } catch { if (current === revision.current && !abort.signal.aborted) setReadFailed(true); }
    };
    void read();
    /* While the page is open; the import moves in passes of minutes, so the read stays one small file. */
    const timer = setInterval(() => void read(), readEveryMs);
    const reads = revision;
    return () => { reads.current++; abort.abort(); clearInterval(timer); };
  }, [readEveryMs]);
  const press = useCallback(async () => {
    if (!view || writing.current) return;
    writing.current = true;
    const current = ++revision.current;
    const before = view;
    const source = view.choice === "delegatus" ? "engines" : "delegatus";
    setView(source === "delegatus"
      ? { choice: "delegatus", phase: "importing", import: { counts: null, remainingGenerations: 0, hold: null } }
      : { choice: "engines", phase: view.phase });
    setSaveFailed(false);
    try {
      const response = await fetch("/api/memory/source", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) });
      if (!response.ok) throw Error("write refused");
      const value = await response.json() as MemorySourceView;
      if (current === revision.current) { setView(value); setReadFailed(false); }
    } catch { if (current === revision.current) { setView(before); setSaveFailed(true); } }
    finally { writing.current = false; }
  }, [view]);

  const state = memorySourceState(view, readFailed);
  const line = memorySourceLine(view, readFailed, t, locale);
  const enabled = view?.choice === "delegatus";
  const title = t("memorySource.title");
  /* The geometry of the sibling rows: the sheet's 44 px row (18 px icon, 12 px gap, body title) on the
     phone, the panel's still row (16 px icon, 8 px gap, 12 px title) on the desktop; the line hangs
     under the title, as the worker limit's does, and wraps at word boundaries. */
  return (
    <div data-header-menu-memory-source="" data-memory-source-state={state} className={phone ? "flex w-full flex-col px-4 pb-1.5" : "flex w-full flex-col rounded-[8px] px-2 py-1"}>
      <div className={`flex items-center font-semibold text-primary ${phone ? "min-h-11 gap-3 text-body" : "min-h-6 gap-2 text-[12px]"}`}>
        <BookMarked className={`shrink-0 text-secondary ${phone ? "h-[18px] w-[18px]" : "h-4 w-4"}`} aria-hidden data-memory-source-icon="" />
        <span data-memory-source-title="" className="min-w-0 flex-1 leading-4">{title}</span>
        <SettingSwitch enabled={enabled} size={phone ? "sheet" : "row"} aria-label={title} aria-describedby={stateId} disabled={!view}
          data-memory-source-switch="" onClick={() => void press()} />
      </div>
      <span id={stateId} role="status" data-memory-source-line="" className={`font-medium ${phone ? "pl-[30px] text-label leading-snug" : "pl-6 text-[11px] leading-[14px]"}`}>
        {saveFailed ? <span data-memory-source-failed="" className="text-danger">{t("memorySource.saveFailed")} </span> : null}
        <span className={readFailed ? "text-warning" : "text-muted"}>{line}</span>
      </span>
    </div>
  );
}
