"use client";

import { useCallback, useId, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n";
import { Select } from "./ui/Select";

type Runtime = "local" | "codex-cloud";
type View = { value: Runtime | null; failed: boolean };
type Setting = { confirmed: Runtime | null; pending: Runtime[]; running: boolean; loading: boolean; failed: boolean; view: View; listeners: Set<() => void> };
const valid = (value: unknown): value is Runtime => value === "local" || value === "codex-cloud";
// Keep accepted writes ordered across menu mounts; retain only mounted or pending settings.
const settings = new Map<string, Setting>();
const initialViews: Record<Runtime | "load", View> = { load: { value: null, failed: false }, local: { value: "local", failed: false }, "codex-cloud": { value: "codex-cloud", failed: false } };
const viewOf = (setting: Setting): View => ({ value: setting.pending.at(-1) ?? setting.confirmed, failed: setting.failed });
function notify(setting: Setting) {
  const view = viewOf(setting);
  if (view.value === setting.view.value && view.failed === setting.view.failed) return;
  setting.view = view;
  for (const listener of setting.listeners) listener();
}
function release(project: string, setting: Setting) {
  if (!setting.listeners.size && !setting.pending.length && settings.get(project) === setting) settings.delete(project);
}

function load(project: string, setting: Setting) {
  if (setting.loading || setting.pending.length) return;
  setting.loading = true; setting.failed = false; notify(setting);
  void (async () => {
    try {
      const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("read failed");
      const body = await response.json();
      if (!valid(body.pipelineStageRuntime)) throw new Error("invalid runtime");
      if (settings.get(project) === setting) setting.confirmed = body.pipelineStageRuntime;
    } catch { if (settings.get(project) === setting) setting.failed = true; }
    finally {
      setting.loading = false;
      if (settings.get(project) === setting) { notify(setting); release(project, setting); }
    }
  })();
}

function save(project: string, setting: Setting, next: Runtime) {
  if (settings.get(project) !== setting || setting.confirmed === null) return;
  setting.pending.push(next); setting.failed = false; notify(setting);
  if (setting.running) return;
  setting.running = true;
  void (async () => {
    while (setting.pending.length) {
      const runtime = setting.pending[0]!;
      try {
        const response = await fetch("/api/projects/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, pipelineStageRuntime: runtime }) });
        if (!response.ok) throw new Error("write failed");
        const body = await response.json();
        if (!valid(body.pipelineStageRuntime)) throw new Error("invalid runtime");
        setting.confirmed = body.pipelineStageRuntime;
      } catch { setting.failed = true; }
      setting.pending.shift(); notify(setting);
    }
    setting.running = false; release(project, setting);
  })();
}

type Props = {
  project: string; variant: "menu" | "sheet"; initial?: Runtime;
};

export function PipelineStageRuntimeRow(props: Props) {
  return <StageRuntimeSetting key={`${props.project}:${props.initial ?? "load"}`} {...props} />;
}

function StageRuntimeSetting({ project, variant, initial }: Props) {
  const { t } = useLocale();
  const id = useId();
  const subscribe = useCallback((listener: () => void) => {
    const setting = settings.get(project) ?? { confirmed: initial ?? null, pending: [], running: false, loading: false, failed: false, view: initialViews[initial ?? "load"], listeners: new Set<() => void>() };
    settings.set(project, setting); setting.listeners.add(listener);
    if (setting.confirmed === null) load(project, setting);
    return () => { setting.listeners.delete(listener); release(project, setting); };
  }, [project, initial]);
  const getSnapshot = useCallback(() => settings.get(project)?.view ?? initialViews[initial ?? "load"], [project, initial]);
  const getServerSnapshot = useCallback(() => initialViews[initial ?? "load"], [initial]);
  const { value, failed } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const choose = (runtime: Runtime) => {
    const setting = settings.get(project);
    if (setting) save(project, setting, runtime);
  };
  return <div data-project-stage-runtime="" className={`flex flex-col gap-0.5 py-1 ${variant === "sheet" ? "px-4" : "px-2"}`}>
    <label className={`flex items-center gap-2 font-semibold text-primary ${variant === "sheet" ? "min-h-11 text-body" : "min-h-8 text-[12px]"}`}>
      <span className="min-w-0 flex-1">{t("projectSettings.stageRuntime")}</span>
      <Select value={value ?? "local"} disabled={value === null} aria-label={t("projectSettings.stageRuntime")} aria-describedby={id} className={variant === "sheet" ? "min-h-11" : ""} onChange={event => { if (valid(event.target.value)) choose(event.target.value); }}>
        <option value="local">{t("projectSettings.stageRuntime.local")}</option>
        <option value="codex-cloud">Codex Cloud</option>
      </Select>
    </label>
    <span id={id} role={failed ? "alert" : "status"} className={`text-[11px] leading-snug ${failed ? "text-danger" : "text-muted"}`}>
      {failed ? t("projectSettings.stageRuntime.failed") : t("projectSettings.stageRuntime.hint")}
      {failed && value === null ? <button type="button" className="ml-1 inline-flex min-h-11 min-w-11 items-center justify-center underline" onClick={() => { const setting = settings.get(project); if (setting) load(project, setting); }}>{t("projectSettings.stageRuntime.retry")}</button> : null}
    </span>
  </div>;
}
