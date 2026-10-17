"use client";

import { Layers } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredBox } from "@/components/feed/SpeakMenu";
import { useModalLayer } from "@/components/modalLayer";
import { Z } from "@/components/layers";
import { useLocale } from "@/lib/i18n";
import type { WorkerLimitAnswer, WorkerReading } from "@/lib/operator/workerLimitView";
import { confirmWorkerReading } from "./useOrchestratorIncumbent";

const NUMBER = "shrink-0 rounded-control border border-border bg-sunken px-1.5 py-1 text-ui tabular-nums text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

/* A limit shows at once on the chip and the row (audit B20): `onPredict` draws
   the value before the request and returns how to take it back, which a
   refusal does beside its words. Nothing is locked; a second save while one
   is out, or while a reset is, sends nothing. */
function LimitField({ project, value, machine = false, placeholder, disabled = false, onBusy, onPredict, onSaved, onEnter }: {
  project: string | null; value: number | null; machine?: boolean;
  placeholder?: number;
  disabled?: boolean; onBusy?: (busy: boolean) => void;
  onPredict?: (next: number | null) => () => void;
  onSaved: (answer: WorkerLimitAnswer) => void; onEnter?: () => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState({ project, value, draft: value === null ? "" : String(value) });
  let draft = editing.draft;
  if (editing.project !== project || editing.value !== value) {
    draft = value === null ? "" : String(value);
    setEditing({ project, value, draft });
  }
  const setDraft = (draft: string) => setEditing({ project, value, draft });
  const [error, setError] = useState<"bounds" | "save" | null>(null);
  const saving = useRef(false);
  const save = async (raw: string, close = false, invalid = false) => {
    if (saving.current || disabled) return;
    const next = invalid ? NaN : raw.trim() === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 64)) {
      setDraft(value === null ? "" : String(value)); setError("bounds"); return;
    }
    if (next === value) { if (close) onEnter?.(); return; }
    saving.current = true; onBusy?.(true); setError(null);
    const undo = onPredict?.(next);
    try {
      const response = await fetch(`/api/operator/worker-limit${project ? `?project=${encodeURIComponent(project)}` : ""}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: next, ...(!machine && project ? { project } : {}) }),
      });
      if (!response.ok) throw new Error("save refused");
      const answer = await response.json() as WorkerLimitAnswer;
      if (!answer.machine || !Number.isInteger(answer.machine.value) || (!machine && !answer.project)) throw new Error("invalid answer");
      onSaved(answer);
      setDraft(machine ? String(answer.machine.value) : answer.project?.value === null ? "" : String(answer.project?.value));
      if (close) onEnter?.();
    } catch {
      undo?.();
      setDraft(value === null ? "" : String(value)); setError("save");
    } finally { saving.current = false; onBusy?.(false); }
  };
  return <>
    <input type="number" inputMode="numeric" min={1} max={64} aria-label={t("workers.title")} className={`${NUMBER} ${machine ? "w-12 text-center font-normal" : "w-14"}`} value={draft} placeholder={String(placeholder ?? 3)}
      autoFocus={!machine}
      onChange={event => { setDraft(event.target.value); setError(null); }}
      onBlur={event => { void save(event.target.value, false, event.target.validity.badInput); }}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(event.currentTarget.value, true, event.currentTarget.validity.badInput); } }}
      data-worker-limit-input={machine ? "machine" : "project"}
    />
    {error ? <span role="status" className="w-full text-label text-warning">{t(error === "bounds" ? "workers.bounds" : "workers.saveFailed")}</span> : null}
  </>;
}

export function WorkerLimitChip({ project, workers, phone = false }: { project: string; workers: WorkerReading | null | undefined; phone?: boolean }) {
  const { t } = useLocale();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [preferAbove, setPreferAbove] = useState(false);
  const [saved, setSaved] = useState<{ project: string; workers: WorkerReading; observed: WorkerReading | null | undefined } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const reading = saved?.project === project && saved.observed === workers ? saved.workers : workers;
  const close = useCallback(() => setOpenFor(previous => previous === project ? null : previous), [project]);
  if (!reading) return null;
  const source = t(reading.source === "project" ? "workers.ownAria" : "workers.machineAria");
  const label = t("workers.aria", { running: reading.running, limit: reading.limit, source });
  const onSaved = (answer: WorkerLimitAnswer) => {
    if (!answer.project) return;
    const next = { running: answer.running.here ?? 0, runningMachine: answer.running.machine, limit: answer.project.effective, source: answer.project.source as WorkerReading["source"], machine: answer.machine.value };
    confirmWorkerReading(project, next);
    setSaved({ project, observed: workers, workers: next });
  };
  const onPredict = (value: number | null) => {
    const before = saved;
    setSaved({ project, observed: workers, workers: { ...reading, limit: value ?? reading.machine, source: value === null ? "machine" : "project" } });
    return () => setSaved(before);
  };
  return <>
    <button ref={anchorRef} type="button" data-worker-limit-chip={project} aria-label={label} title={label} aria-expanded={openFor === project}
      className={`${phone ? "flex h-11 w-full items-center px-3 text-body" : "inline-flex h-6 shrink-0 items-center px-1 text-caption"} gap-1 rounded-control tabular-nums ${reading.running > reading.limit ? "text-warning" : "text-secondary"} hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      onClick={event => {
        setPreferAbove(Boolean(event.currentTarget.closest("[data-kanban-seat].side")));
        setOpenFor(previous => previous === project ? null : project);
      }}>
      {t(phone ? "workers.phoneFace" : "workers.face", { running: reading.running, limit: reading.limit })}
      {reading.source === "project" ? <span data-worker-limit-own aria-hidden className="mb-2 h-1 w-1 shrink-0 rounded-full bg-accent" /> : null}
    </button>
    {openFor === project ? <WorkerLimitPopover project={project} workers={reading} anchorRef={anchorRef} onClose={close} onPredict={onPredict} onSaved={onSaved} preferAbove={preferAbove} /> : null}
  </>;
}

function WorkerLimitPopover({ project, workers, anchorRef, onClose, onPredict, onSaved, preferAbove }: {
  project: string; workers: WorkerReading; anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void; onPredict: (next: number | null) => () => void; onSaved: (answer: WorkerLimitAnswer) => void; preferAbove: boolean;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [resetting, setResetting] = useState(false);
  const [saving, setSaving] = useState(false);
  const resetInFlight = useRef(false);
  const [failed, setFailed] = useState(false);
  const { style, onScreen } = useAnchoredBox(anchorRef, rootRef, 256, preferAbove);
  useModalLayer({ containerRef: rootRef, onClose, lockScroll: false });
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (!rootRef.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [anchorRef, onClose]);
  useEffect(() => { if (!onScreen) onClose(); }, [onScreen, onClose]);
  const reset = async () => {
    if (resetInFlight.current || saving) return;
    resetInFlight.current = true; setResetting(true); setFailed(false);
    const undo = onPredict(null);
    try {
      const response = await fetch("/api/operator/worker-limit", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, value: null }) });
      if (!response.ok) throw new Error("reset refused");
      onSaved(await response.json() as WorkerLimitAnswer);
    } catch { undo(); setFailed(true); } finally { resetInFlight.current = false; setResetting(false); }
  };
  if (typeof document === "undefined" || !onScreen) return null;
  return createPortal(<div ref={rootRef} style={style} role="dialog" aria-modal="false" aria-label={t("workers.title")} tabIndex={-1} data-worker-limit-popover={project}
    className={`fixed ${Z.popover} w-64 max-w-[calc(100vw-16px)] rounded-surface border border-border bg-card p-3 shadow-2 outline-none`}>
    <p className="mb-2 text-ui font-semibold text-primary">{t("workers.title")}</p>
    <div className="flex flex-wrap items-center gap-2" data-worker-limit-field>
      <LimitField project={project} value={workers.source === "project" ? workers.limit : null} placeholder={workers.machine} disabled={resetting} onBusy={setSaving} onPredict={onPredict} onSaved={onSaved} onEnter={onClose} />
      <span className="text-label text-secondary">{t(workers.source === "project" ? "workers.own" : "workers.inherited")}</span>
    </div>
    <p className="mt-2 text-label text-muted">{t("workers.running", { here: workers.running, machine: workers.runningMachine })}</p>
    {workers.source === "project" ? <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { void reset(); }} className="mt-2 text-left text-label text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/40">{t("workers.reset", { value: workers.machine })}</button> : null}
    {failed ? <p role="status" className="mt-2 text-label text-warning">{t("workers.saveFailed")}</p> : null}
    <p className="mt-2 text-label text-muted">{t("workers.pointer")}</p>
  </div>, document.body);
}

export function WorkerLimitSettingsRow({ project, phone = false }: { project: string | null; phone?: boolean }) {
  const { t } = useLocale();
  const [read, setRead] = useState<{ project: string | null; answer: WorkerLimitAnswer } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/operator/worker-limit${project ? `?project=${encodeURIComponent(project)}` : ""}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("read refused");
        const answer = await response.json() as WorkerLimitAnswer;
        if (!controller.signal.aborted) { setRead({ project, answer }); setFailedFor(undefined); }
      }).catch(() => { if (!controller.signal.aborted) setFailedFor(project); });
    return () => controller.abort();
  }, [project]);
  const answer = read?.project === project ? read.answer : null;
  const own = answer?.project?.value ?? null;
  const state = !answer ? "…"
    : answer.running.here === null ? t("workers.machineRunning", { machine: answer.running.machine })
    : own !== null ? t("workers.hereOwnRunning", { here: answer.running.here, value: own, machine: answer.running.machine })
    : t("workers.hereRunning", { here: answer.running.here, machine: answer.running.machine });
  /* The geometry of the sibling Settings rows: the sheet's 44 px row (18 px icon, 12 px gap, body title)
     on the phone, the panel's still row (16 px icon, 8 px gap, 12 px title) on desktop; the state line is
     the muted medium word the Memory row uses, and the field is two digits wide. */
  return <div data-header-menu-workers className={phone
    ? "flex min-h-11 w-full flex-wrap items-center gap-3 px-4 py-1.5 text-body font-semibold text-primary"
    : "flex min-h-[30px] w-full flex-wrap items-center gap-2 rounded-[8px] px-2 py-1 text-[12px] font-semibold text-primary"}>
    <span className={`flex shrink-0 items-center justify-center text-secondary ${phone ? "h-[18px] w-[18px]" : ""}`}>
      <Layers className={phone ? "h-[18px] w-[18px]" : "h-4 w-4"} aria-hidden data-worker-limit-icon />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span data-worker-limit-title className="truncate leading-4">{t("workers.settingsTitle")}</span>
      <span data-worker-limit-state className={`font-medium text-muted ${phone ? "text-label" : "text-[11px] leading-[14px]"}`}>{state}</span>
    </span>
    {answer ? <LimitField project={project} value={answer.machine.value} machine onPredict={next => {
      const before = read;
      if (next !== null) setRead(current => current?.project === project ? { project, answer: { ...current.answer, machine: { ...current.answer.machine, value: next } } } : current);
      return () => setRead(before);
    }} onSaved={next => {
      if (project && next.project) confirmWorkerReading(project, { running: next.running.here ?? 0, runningMachine: next.running.machine, limit: next.project.effective, source: next.project.source as WorkerReading["source"], machine: next.machine.value });
      setRead(current => current?.project === project ? { project, answer: next } : current);
    }} /> : null}
    {failedFor !== undefined && failedFor === project ? <span role="status" className="w-full text-label font-normal text-warning">{t("workers.readFailed")}</span> : null}
  </div>;
}
