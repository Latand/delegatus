"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { OpenRouterKeyField } from "@/components/asks/OpenRouterKeyField";
import { memoryBlocked, memoryTone, money, monthName, monthResets, type MemoryTone, type MemoryView } from "@/components/headerMenu/headerMenuModel";
import { ProjectSettingRow } from "@/components/ProjectSettingRow";
import { useLocale } from "@/lib/i18n";

/* Shared memory and the OpenRouter key as rows of the header's menu
   (docs/design/header-menu.md): each row says
   its state as a word beside a coloured dot, and one step in is a page with
   the per-project switch, what blocks memory and how to lift that, the month
   in three numbers with the rest behind Details, and the key's field opened
   where it was asked for. Everything is read from and written to the
   product's own `/api/memory/settings` and `/api/asks-you/key`. */

export type KeyView = { present: boolean; source: "env" | "file" | null; staging?: boolean };
export type MemorySize = "menu" | "sheet";

interface Reading {
  /** The project the switch belongs to; none on the overview, which has no memory row. */
  project: string | null;
  memory: MemoryView | null;
  key: KeyView | null;
  memoryError: "read" | "save" | null;
  keyFailed: boolean;
  busy: boolean;
  setEnabled: (enabled: boolean) => void;
}

const MemoryReading = createContext<Reading | null>(null);

/** One reading for every row and page of an open menu, refreshed while it is open. */
export function MemoryReadingProvider({ project, children }: { project: string | null; children: ReactNode }) {
  const [memory, setMemory] = useState<(MemoryView & { project: string }) | null>(null);
  const [key, setKey] = useState<KeyView | null>(null);
  const [memoryError, setMemoryError] = useState<"read" | "save" | null>(null);
  const [keyFailed, setKeyFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /* A read that started before a write, or before the project changed, never lands over what came after it. */
  const revision = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    writing.current = false;
    const readMemory = async () => {
      if (!project || writing.current) return;
      const current = ++revision.current;
      try {
        const response = await fetch(`/api/memory/settings?project=${encodeURIComponent(project)}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw Error();
        const value = await response.json() as MemoryView;
        if (current === revision.current && !abort.signal.aborted) { setMemory({ ...value, project }); setMemoryError(null); }
      } catch { if (current === revision.current && !abort.signal.aborted) setMemoryError("read"); }
    };
    const readKey = async () => {
      try {
        const response = await fetch("/api/asks-you/key", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw Error();
        const value = await response.json() as KeyView;
        if (!abort.signal.aborted) { setKey(value); setKeyFailed(false); }
      } catch { if (!abort.signal.aborted) setKeyFailed(true); }
    };
    const refresh = () => { void readMemory(); void readKey(); };
    refresh();
    window.addEventListener("delegatus:provider-key-changed", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => { revision.current++; abort.abort(); clearInterval(timer); window.removeEventListener("delegatus:provider-key-changed", refresh); };
  }, [project]);
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!project || writing.current) return;
    writing.current = true;
    const current = ++revision.current;
    setBusy(true); setMemoryError(null);
    try {
      const response = await fetch("/api/memory/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled }) });
      if (!response.ok) throw Error();
      const value = await response.json() as MemoryView;
      if (current === revision.current) setMemory({ ...value, project });
    } catch { if (current === revision.current) setMemoryError("save"); }
    finally { writing.current = false; setBusy(false); }
  }, [project]);
  const value: Reading = {
    project,
    memory: memory && memory.project === project ? memory : null,
    key,
    memoryError,
    keyFailed,
    busy,
    setEnabled: (enabled) => void setEnabled(enabled),
  };
  return <MemoryReading.Provider value={value}>{children}</MemoryReading.Provider>;
}

export function useMemoryReading(): Reading {
  const reading = useContext(MemoryReading);
  if (!reading) throw new Error("useMemoryReading needs a MemoryReadingProvider");
  return reading;
}

/** The tone the rows show: a failed read is a state nobody can vouch for, even with an earlier reading in hand. */
function toneOf(reading: Reading): MemoryTone | "loading" {
  if (reading.memoryError === "read") return "unknown";
  if (!reading.memory) return "loading";
  return memoryTone(reading.memory);
}

const DOT: Record<MemoryTone | "loading", string> = {
  working: "bg-success", off: "bg-muted", noKey: "bg-warning", capped: "bg-warning", notOwner: "bg-warning", unknown: "bg-muted", loading: "bg-muted",
};
function Dot({ className }: { className: string }) {
  return <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${className}`} />;
}
const STATE = "inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap font-medium text-muted";

/** Memory's state in words beside its dot: in full on the memory row, in short ("memory: working") on the Settings row. */
export function MemoryStateWord({ short = false, size = "menu" }: { short?: boolean; size?: MemorySize }) {
  const { t, locale } = useLocale();
  const reading = useMemoryReading();
  const tone = toneOf(reading);
  const lang = locale === "uk" ? "uk" : "en";
  const full = tone === "loading" ? "…"
    : tone === "working" ? t("memoryState.working", { count: reading.memory?.counts?.delivered ?? 0 })
    : tone === "capped" ? t("memoryState.capped", { date: monthResets(reading.memory?.month, lang) })
    : t(`memoryState.${tone}`);
  const word = short ? t("memoryState.short", { state: tone === "loading" ? "…" : t(`memoryState.short.${tone}`) }) : full;
  return (
    <span data-memory-state={tone} className={`${STATE} ${size === "sheet" ? "text-label" : "text-[11px] leading-[14px]"}`}>
      <Dot className={DOT[tone]} />
      <span className="truncate">{word}</span>
    </span>
  );
}

/** The key's state: Saved or Missing. `lead`: the line that opens the key's page, in the size of a row's name. */
export function KeyStateWord({ size = "menu", lead = false }: { size?: MemorySize; lead?: boolean }) {
  const { t } = useLocale();
  const { key, keyFailed } = useMemoryReading();
  const state = key ? (key.present ? "saved" : "missing") : keyFailed ? "unknown" : "loading";
  return (
    <span data-key-state={state} className={lead
      ? `${STATE} font-semibold text-primary ${size === "sheet" ? "text-body" : "text-[12px]"}`
      : `${STATE} ${size === "sheet" ? "text-label" : "text-[11px] leading-[14px]"}`}>
      <Dot className={state === "saved" ? "bg-success" : state === "missing" ? "bg-warning" : "bg-muted"} />
      <span className="truncate">{state === "saved" ? t("keyPage.saved") : state === "missing" ? t("keyPage.missing") : state === "unknown" ? t("memoryState.unknown") : "…"}</span>
    </span>
  );
}

const ACT = {
  menu: "h-7 rounded-[7px] border border-border bg-card px-2.5 text-[11.5px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
  sheet: "min-h-11 rounded-[8px] border border-border bg-card px-3.5 text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
} as const;
const PAD = { menu: "px-2", sheet: "px-4" } as const;
const LINE = { menu: "text-[11px] leading-snug", sheet: "text-label leading-snug" } as const;

/** One step in from the memory row. */
export function MemoryPanel({ size = "menu" }: { size?: MemorySize }) {
  const { t, locale } = useLocale();
  const lang = locale === "uk" ? "uk" : "en";
  const reading = useMemoryReading();
  const { memory, memoryError, busy, setEnabled } = reading;
  const [keyOpen, setKeyOpen] = useState(false);
  const [details, setDetails] = useState(false);
  /* The switch keeps the last setting read; what blocks it and the month are not vouched for after a failed read. */
  const readFailed = memoryError === "read";
  const tone = readFailed ? "unknown" : memoryTone(memory);
  const blocked = memoryBlocked(tone);
  const staging = Boolean(memory?.staging);
  const reason = tone === "noKey" ? t(staging ? "memoryPage.reason.noKeyStaging" : "memoryPage.reason.noKey")
    : tone === "capped" ? t("memoryPage.reason.capped", { cap: money(memory?.capUsd ?? 0), date: monthResets(memory?.month, lang) })
    : tone === "notOwner" ? t("memoryPage.reason.notOwner")
    : tone === "unknown" && (memory || readFailed) ? t("memoryPage.reason.unknown") : null;
  const counts = memory?.counts;
  /* While memory is blocked, a month of zeros says nothing. */
  const numbers = tone !== "unknown" && counts && memory?.spentUsd !== undefined && memory.capUsd !== undefined
    && !(blocked && counts.decisions === 0 && counts.delivered === 0);
  const sheet = size === "sheet";
  const detailsToggle = (
    <button type="button" data-memory-details="" aria-expanded={details} onClick={() => setDetails((open) => !open)}
      className={`font-semibold text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${sheet ? "min-h-11 self-start text-body" : "inline text-[11.5px]"}`}>
      {t("memoryPage.details")}
    </button>
  );
  return (
    <div data-memory-page="" data-memory-tone={tone} className={`flex flex-col font-normal ${sheet ? "gap-2.5 pb-4" : "gap-1.5 pb-1.5"}`}>
      <ProjectSettingRow
        label={t("memoryPage.forProject")}
        hint={memoryError === "save" ? t("memory.save.failed") : blocked ? "" : t("memoryPage.explains")}
        enabled={Boolean(memory?.enabled)}
        disabled={busy || !memory}
        failed={memoryError === "save"}
        variant={size}
        blocked={Boolean(memory?.enabled) && blocked}
        rowProps={{ "data-memory-setting": "" }}
        switchProps={{ "data-memory-switch": "", onClick: () => { if (memory) setEnabled(!memory.enabled); } }}
      />
      {reason ? (
        <div className={PAD[size]}>
          <div role={readFailed ? "alert" : "status"} data-memory-reason={tone} className={`flex flex-col items-start gap-1.5 rounded-[8px] bg-warning-soft ${sheet ? "px-3 py-2.5 text-body" : "px-2 py-1.5 text-[12px]"} leading-snug text-primary`}>
            <span>{reason}</span>
            {tone === "noKey" && !staging && !keyOpen ? <button type="button" data-memory-enter-key="" className={ACT[size]} onClick={() => setKeyOpen(true)}>{t("memoryPage.enterKey")}</button> : null}
            {tone === "noKey" && !staging && keyOpen ? <OpenRouterKeyField size={size} /> : null}
          </div>
        </div>
      ) : null}
      {numbers ? (
        <div className={`flex flex-col ${sheet ? "gap-2" : "gap-1"} ${PAD[size]}`}>
          <div data-memory-numbers="" className="grid grid-cols-3 gap-1">
            {([[counts.delivered, t("memoryPage.added")], [counts.decisions, t("memoryPage.checked")], [money(memory.spentUsd!), t("memoryPage.spentOf", { cap: money(memory.capUsd!) })]] as const).map(([value, label]) => (
              <div key={label} className={`min-w-0 rounded-[7px] bg-sunken ${sheet ? "px-2.5 py-2" : "px-1.5 py-1"}`}>
                <b className={`block whitespace-nowrap font-bold tabular-nums text-primary ${sheet ? "text-[20px] leading-6" : "text-[15px] leading-[18px]"}`}>{value}</b>
                <span className={`block text-muted ${sheet ? "text-label leading-4" : "text-[10.5px] leading-[13px]"}`}>{label}</span>
              </div>
            ))}
          </div>
          {/* In the menu, Details ends the scope's own line: a refused key under a counted month still fits 360 px. */}
          <span data-memory-scope="" className={`${LINE[size]} text-muted`}>
            {t("memoryPage.scope", { month: monthName(memory.month, lang) })}
            {sheet ? null : <>{" "}{detailsToggle}</>}
          </span>
          {sheet ? detailsToggle : null}
          {details ? (
            <dl data-memory-table="" className={`m-0 grid grid-cols-[1fr_auto_1fr_auto] tabular-nums text-muted ${sheet ? "gap-x-3 gap-y-1.5 text-label" : "gap-x-1.5 gap-y-0.5 text-[11px] leading-[14px]"}`}>
              {([["memoryPage.picked", counts.prepared], ["memoryPage.noCandidates", counts.noCandidates], ["memoryPage.noMatches", counts.noMatches], ["memoryPage.skipped", counts.skipped], ["memoryPage.failed", counts.failed]] as const).map(([name, value]) => (
                <div key={name} className="contents"><dt className="whitespace-nowrap">{t(name)}</dt><dd className="m-0 mr-1.5 text-right font-semibold text-primary">{value}</dd></div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One step in from the key row: what uses the key, whether it is saved, and the field behind Replace. */
export function KeyPanel({ size = "menu" }: { size?: MemorySize }) {
  const { t } = useLocale();
  const { key, keyFailed } = useMemoryReading();
  const [open, setOpen] = useState(false);
  const env = key?.source === "env";
  const staging = Boolean(key?.staging);
  const field = key !== null && !env && !staging && (open || !key.present);
  const sheet = size === "sheet";
  return (
    <div data-key-page="" className={`flex flex-col font-normal ${sheet ? "gap-2.5 pb-4" : "gap-1.5 pb-1.5"} ${PAD[size]}`}>
      <span className={`${LINE[size]} text-muted`}>{t("keyPage.for")}</span>
      <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-7"}`}>
        <span className="flex min-w-0 flex-1"><KeyStateWord size={size} lead /></span>
        {key?.present && !env && !staging && !open ? <button type="button" data-key-replace="" className={ACT[size]} onClick={() => setOpen(true)}>{t("keyPage.replace")}</button> : null}
      </div>
      {env ? <span className={`${LINE[size]} text-muted`}>{t("keyPage.env")}</span> : null}
      {staging ? <span className={`${LINE[size]} text-muted`}>{t("providerKey.staging")}</span> : null}
      {keyFailed ? <span role="alert" className={`${LINE[size]} text-danger`}>{t("providerKey.failed")}</span> : null}
      {field ? <OpenRouterKeyField size={size} onSaved={() => setOpen(false)} /> : null}
    </div>
  );
}
