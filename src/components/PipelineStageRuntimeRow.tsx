"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { Select } from "./ui/Select";

type Runtime = "local" | "codex-cloud";
type Session = { live: boolean; confirmed: Runtime; pending: Runtime[]; running: boolean };
const valid = (value: unknown): value is Runtime => value === "local" || value === "codex-cloud";

type Props = {
  project: string; variant: "menu" | "sheet"; initial?: Runtime;
};

export function PipelineStageRuntimeRow(props: Props) {
  return <StageRuntimeSetting key={`${props.project}:${props.initial ?? "load"}`} {...props} />;
}

function StageRuntimeSetting({ project, variant, initial }: Props) {
  const { t } = useLocale();
  const id = useId();
  const [value, setValue] = useState<Runtime | null>(initial ?? null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const session = useRef<Session | null>(null);
  useEffect(() => {
    const current: Session = { live: true, confirmed: initial ?? "local", pending: [], running: false };
    session.current = current;
    if (!initial) void (async () => {
      try {
        const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("read failed");
        const body = await response.json();
        if (!valid(body.pipelineStageRuntime)) throw new Error("invalid runtime");
        if (current.live) { current.confirmed = body.pipelineStageRuntime; setValue(current.confirmed); setFailed(false); }
      } catch { if (current.live) setFailed(true); }
    })();
    return () => { current.live = false; };
  }, [project, initial, reload]);

  const choose = (next: Runtime) => {
    const current = session.current;
    if (!current?.live || value === null) return;
    current.pending.push(next); setValue(next); setFailed(false);
    if (current.running) return;
    current.running = true;
    void (async () => {
      while (current.pending.length) {
        const runtime = current.pending[0]!;
        try {
          const response = await fetch("/api/projects/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, pipelineStageRuntime: runtime }) });
          if (!response.ok) throw new Error("write failed");
          const body = await response.json();
          if (!valid(body.pipelineStageRuntime)) throw new Error("invalid runtime");
          current.confirmed = body.pipelineStageRuntime;
        } catch { if (current.live) setFailed(true); }
        current.pending.shift();
        if (current.live) setValue(current.pending.at(-1) ?? current.confirmed);
      }
      current.running = false;
    })();
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
      {failed && value === null ? <button type="button" className="ml-1 inline-flex min-h-11 min-w-11 items-center justify-center underline" onClick={() => { setFailed(false); setReload(n => n + 1); }}>{t("projectSettings.stageRuntime.retry")}</button> : null}
    </span>
  </div>;
}
