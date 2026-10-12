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

function LimitField({ project, value, machine = false, placeholder, wide = false, disabled = false, onBusy, onSaved, onEnter }: {
  project: string | null; value: number | null; machine?: boolean;
  placeholder?: number; wide?: boolean;
  disabled?: boolean; onBusy?: (busy: boolean) => void;
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
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const save = async (raw: string, close = false, invalid = false) => {
    if (saving.current) return;
    const next = invalid ? NaN : raw.trim() === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 64)) {
      setDraft(value === null ? "" : String(value)); setError("bounds"); return;
    }
    if (next === value) { if (close) onEnter?.(); return; }
    saving.current = true; setBusy(true); onBusy?.(true); setError(null);
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
      setDraft(value === null ? "" : String(value)); setError("save");
    } finally { saving.current = false; setBusy(false); onBusy?.(false); }
  };
  return <>
    <input type="number" inputMode="numeric" min={1} max={64} aria-label={t("workers.title")} className={`${NUMBER} ${wide ? "w-20" : machine ? "w-12" : "w-14"}`} value={draft} placeholder={String(placeholder ?? 3)} disabled={busy || disabled}
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
  return <>
    <button ref={anchorRef} type="button" data-worker-limit-chip={project} aria-label={label} title={label} aria-expanded={openFor === project}
      className={`${phone ? "flex h-11 w-full items-center px-3 text-body" : "inline-flex h-6 shrink-0 items-center px-1 text-caption"} gap-1 rounded-control tabular-nums ${reading.running > reading.limit ? "text-warning" : "text-secondary"} hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      onClick={() => setOpenFor(previous => previous === project ? null : project)}>
      {t(phone ? "workers.phoneFace" : "workers.face", { running: reading.running, limit: reading.limit })}
      {reading.source === "project" ? <span data-worker-limit-own aria-hidden className="mb-2 h-1 w-1 shrink-0 rounded-full bg-accent" /> : null}
    </button>
    {openFor === project ? <WorkerLimitPopover project={project} workers={reading} anchorRef={anchorRef} onClose={close} onSaved={onSaved} /> : null}
  </>;
}

function WorkerLimitPopover({ project, workers, anchorRef, onClose, onSaved }: {
  project: string; workers: WorkerReading; anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void; onSaved: (answer: WorkerLimitAnswer) => void;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [resetting, setResetting] = useState(false);
  const [saving, setSaving] = useState(false);
  const resetInFlight = useRef(false);
  const [failed, setFailed] = useState(false);
  const { style, onScreen } = useAnchoredBox(anchorRef, rootRef, 256);
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
    try {
      const response = await fetch("/api/operator/worker-limit", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, value: null }) });
      if (!response.ok) throw new Error("reset refused");
      onSaved(await response.json() as WorkerLimitAnswer);
    } catch { setFailed(true); } finally { resetInFlight.current = false; setResetting(false); }
  };
  if (typeof document === "undefined" || !onScreen) return null;
  return createPortal(<div ref={rootRef} style={style} role="dialog" aria-modal="false" aria-label={t("workers.title")} tabIndex={-1} data-worker-limit-popover={project}
    className={`fixed ${Z.popover} w-64 max-w-[calc(100vw-16px)] rounded-surface border border-border bg-card p-3 shadow-2 outline-none`}>
    <p className="mb-2 text-ui font-semibold text-primary">{t("workers.title")}</p>
    <div className="flex flex-wrap items-center gap-2" data-worker-limit-field>
      <LimitField project={project} value={workers.source === "project" ? workers.limit : null} placeholder={workers.machine} disabled={resetting} onBusy={setSaving} onSaved={onSaved} onEnter={onClose} />
      <span className="text-label text-secondary">{t(workers.source === "project" ? "workers.own" : "workers.inherited")}</span>
    </div>
    <p className="mt-2 text-label text-muted">{t("workers.running", { here: workers.running, machine: workers.runningMachine })}</p>
    {workers.source === "project" ? <button type="button" disabled={resetting || saving} onPointerDown={event => event.preventDefault()} onClick={() => { void reset(); }} className="mt-2 text-left text-label text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/40">{t("workers.reset", { value: workers.machine })}</button> : null}
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
  const state = answer?.project?.value !== null && answer?.project ? t("workers.hereOwn", { value: answer.project.value })
    : answer ? answer.running.here === null ? t("workers.machineRunning", { machine: answer.running.machine }) : t("workers.hereRunning", { here: answer.running.here, machine: answer.running.machine }) : "…";
  return <div data-header-menu-workers className={`flex flex-wrap items-center gap-2 ${phone ? "min-h-11 px-4 py-1.5" : "min-h-[30px] rounded-[8px] px-2 py-1"}`}>
    <Layers className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
    <span className="flex min-w-0 flex-1 flex-col gap-px"><span className={`${phone ? "text-body" : "text-[12px]"} font-semibold leading-4 text-primary`}>{t("workers.settingsTitle")}</span><span className="text-[10.5px] leading-3 text-muted">{state}</span></span>
    {answer ? <LimitField project={project} value={answer.machine.value} machine wide={phone} onSaved={next => {
      if (project && next.project) confirmWorkerReading(project, { running: next.running.here ?? 0, runningMachine: next.running.machine, limit: next.project.effective, source: next.project.source as WorkerReading["source"], machine: next.machine.value });
      setRead(current => current?.project === project ? { project, answer: next } : current);
    }} /> : null}
    {failedFor !== undefined && failedFor === project ? <span role="status" className="w-full text-label text-warning">{t("workers.readFailed")}</span> : null}
  </div>;
}
