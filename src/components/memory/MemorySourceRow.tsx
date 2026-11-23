"use client";

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

export type MemorySourceState = "loading" | "unknown" | "unchosen" | "needs-orchestrator" | "preparing" | "importing" | "draining" | "active" | "engines";

/** A failed read is a state nobody can vouch for, as on the Shared memory row; the switch keeps the last reading. */
export function memorySourceState(view: MemorySourceView | null, readFailed: boolean): MemorySourceState {
  if (readFailed) return "unknown";
  if (!view) return "loading";
  /* The import runs as an agent's work, so before any orchestrator exists the choice cannot be made. */
  if (view.choice !== "delegatus" && view.orchestrator === false) return "needs-orchestrator";
  if (view.choice === null) return "unchosen";
  if (view.choice === "engines") return "engines";
  if (view.phase === "draining" || view.phase === "active") return view.phase;
  return view.import?.counts ? "importing" : "preparing";
}

/** The state line's words; `now` places the last sync run. */
export function memorySourceLine(view: MemorySourceView | null, readFailed: boolean, t: TFunction, locale: Locale, now = Date.now(), limit = false): string {
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
    case "needs-orchestrator": return t("memorySource.needsOrchestrator");
    /* The Settings row is the only place that offers the switch without the setup step's lead, so it also says what the import spends. */
    case "unchosen": return t("memorySource.unchosen") + (limit ? ` ${t("memorySource.limit")}` : "") + failure;
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

export function MemorySourceRow({ phone = false, inset = false, readEveryMs = READ_MS, onState }: {
  phone?: boolean;
  /** Drawn inside a bordered frame of its own (the setup step) rather than as a Settings row. */
  inset?: boolean;
  readEveryMs?: number;
  /** The state on screen, for a host that offers a way to the orchestrator while the switch cannot be turned on. */
  onState?: (state: MemorySourceState) => void;
}) {
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
      ? { choice: "delegatus", phase: "importing", orchestrator: view.orchestrator, import: { counts: null, remainingGenerations: 0, hold: null } }
      : { choice: "engines", phase: view.phase, orchestrator: view.orchestrator });
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
  const line = memorySourceLine(view, readFailed, t, locale, undefined, !inset);
  useEffect(() => { onState?.(state); }, [onState, state]);
  const enabled = view?.choice === "delegatus";
  const title = t("memorySource.title");
  /* A switch row of the Settings window: the title and its line in one block, the switch centred beside them and
     its track on the edge every other switch, select and chevron ends on. */
  return (
    <div data-header-menu-memory-source="" data-memory-source-state={state} className={`flex w-full items-center gap-3 ${inset ? "min-h-11 px-3 py-2" : phone ? "min-h-11 px-4 py-1.5" : "min-h-10 px-5 py-1.5"}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-body">
        <span data-memory-source-title="" className="font-semibold text-primary">{title}</span>
        <span id={stateId} role="status" data-memory-source-line="" className="text-ui font-normal leading-snug">
          {saveFailed ? <span data-memory-source-failed="" className="text-danger">{t("memorySource.saveFailed")} </span> : null}
          <span className={readFailed ? "text-warning" : "text-muted"}>{line}</span>
        </span>
      </span>
      <SettingSwitch enabled={enabled} size={phone ? "sheet" : "row"} className={phone ? "-mr-1.5" : ""} aria-label={title} aria-describedby={stateId} disabled={!view || state === "needs-orchestrator"}
        data-memory-source-switch="" onClick={() => void press()} />
    </div>
  );
}
