"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { TASK_HOLD_KINDS, type TaskHold, type TaskHoldKind } from "@/lib/tasks/types";

export function TaskHoldEditor({ hold, onSave, onCancel }: { hold?: TaskHold; onSave: (hold: Partial<TaskHold> | null) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [kind, setKind] = useState<TaskHoldKind>(hold?.kind ?? "operator");
  const [note, setNote] = useState(hold?.note ?? "");
  const [ref, setRef] = useState(hold?.ref ?? "");
  const [until, setUntil] = useState(hold?.until ?? "");
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => { select.current?.focus(); }, []);
  return <form className="hold-editor" data-hold-editor="" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
  }} onSubmit={event => { event.preventDefault(); onSave({ kind, note, ...(ref ? { ref } : {}), ...(until ? { until } : {}) }); }}>
    <label>{t("kanban.hold.editKind")}<select ref={select} value={kind} onChange={event => setKind(event.target.value as TaskHoldKind)}>
      {TASK_HOLD_KINDS.map(value => <option key={value} value={value}>{t(`kanban.hold.kind.${value}`)}</option>)}
    </select></label>
    <label>{t("kanban.hold.editNote")}<input value={note} maxLength={200} onChange={event => setNote(event.target.value)} /></label>
    {["task", "pr", "issue", "external"].includes(kind) ? <label>{t("kanban.hold.editRef")}<input value={ref} maxLength={500} onChange={event => setRef(event.target.value)} /></label> : null}
    {["limit", "postponed"].includes(kind) ? <label>{t("kanban.hold.editUntil")}<input type="datetime-local" value={until ? localDateTime(until) : ""} onChange={event => setUntil(event.target.value ? new Date(event.target.value).toISOString() : "")} /></label> : null}
    <div className="hold-actions"><button type="submit">{t("kanban.hold.save")}</button><button type="button" onClick={onCancel}>{t("kanban.hold.cancel")}</button>{hold ? <button type="button" onClick={() => onSave(null)}>{t("kanban.hold.clear")}</button> : null}</div>
  </form>;
}
function localDateTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
