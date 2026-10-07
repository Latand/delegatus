"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { roleNameById } from "@/components/builderCopy";
import { Z } from "@/components/layers";
import { ProjectSettingRow } from "@/components/ProjectSettingRow";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStageReportEntry } from "@/lib/pipelines/types";
import type { RoleMemoryProjectView, RuleView, ScopeView, StageLessonView } from "@/lib/roleMemory/types";

/* Role memory on the operator's surfaces (docs/design/role-memory.md §3.1, the
   operator's choice of 2026-10-07: variants 2 and 3): the switch and one row
   among the project's switches on the board's ⋯ (the header's Memory page
   has no room left under its 360 px), a rules window with the scopes on the left, the rules as
   coloured blocks in the middle and what left them on the right, and one line
   under a stage report on the card. Short on purpose: «Треба, щоб не було
   дуже багато тексту. І зайвої інформації.» */

/* ---- the card's line, read once per project and shared by every card ---- */

type LessonsEntry = { at: number; lessons: StageLessonView[] | null; pending: Promise<void> | null; listeners: Set<() => void> };
const lessonsByProject = new Map<string, LessonsEntry>();
const LESSONS_FRESH_MS = 20_000;

function lessonsEntry(project: string): LessonsEntry {
  let entry = lessonsByProject.get(project);
  if (!entry) { entry = { at: 0, lessons: null, pending: null, listeners: new Set() }; lessonsByProject.set(project, entry); }
  return entry;
}

function refreshLessons(project: string, force = false): void {
  const entry = lessonsEntry(project);
  if (entry.pending || (!force && Date.now() - entry.at < LESSONS_FRESH_MS)) return;
  entry.pending = fetch(`/api/role-memory/lessons?project=${encodeURIComponent(project)}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw Error();
      const body = await response.json() as { lessons?: StageLessonView[] };
      entry.lessons = Array.isArray(body.lessons) ? body.lessons : [];
    })
    .catch(() => { /* A card keeps its last reading; the line is a projection and never blocks the card. */ })
    .finally(() => { entry.at = Date.now(); entry.pending = null; for (const listener of entry.listeners) listener(); });
}

function useStageLessons(project: string): StageLessonView[] | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const entry = lessonsEntry(project);
    const listener = () => setTick((n) => n + 1);
    entry.listeners.add(listener);
    refreshLessons(project);
    const timer = setInterval(() => refreshLessons(project), LESSONS_FRESH_MS);
    return () => { entry.listeners.delete(listener); clearInterval(timer); };
  }, [project]);
  return lessonsByProject.get(project)?.lessons ?? null;
}

function targetName(t: TFunction, rule: StageLessonView["rules"][number]): string {
  if (rule.scope === "project") return t("roleMemory.target.project");
  if (rule.scope === "machine") return t("roleMemory.target.machine");
  return roleNameById(t, rule.roleId ?? "");
}

/** One line under a stage report: what the stage left, or that it left none once its turn ended. Clean stages draw nothing. */
export function StageLessonLine({ pipeline, entry }: { pipeline: Pipeline; entry: Pick<PipelineStageReportEntry, "stageId" | "attempt"> }) {
  const { t } = useLocale();
  const lessons = useStageLessons(pipeline.project);
  const [open, setOpen] = useState(false);
  const lesson = lessons?.find((item) => item.pipelineId === pipeline.id && item.stageId === entry.stageId && item.attempt === entry.attempt);
  if (!lesson) return null;
  const attempt = pipeline.runs.find((run) => run.stageId === entry.stageId)?.attempts.find((candidate) => candidate.n === entry.attempt);
  if (!lesson.rules.length) {
    if (!attempt?.completedAt) return null;
    return <p className="stage-lesson" data-stage-lesson="none" title={lesson.none ?? undefined}>{t("roleMemory.line.none")}</p>;
  }
  const targets = [...new Set(lesson.rules.map((rule) => targetName(t, rule)))].join(", ");
  return (
    <>
      <button type="button" className="stage-lesson" data-stage-lesson={lesson.rules.length} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>
        <span className="head"><SparkGlyph />{t("roleMemory.line.left", { count: lesson.rules.length, targets })}</span>
        <span className="rule">“{lesson.rules[0]!.rule}”</span>
      </button>
      {open ? <RulesWindow project={pipeline.project} focusRule={lesson.rules[0]!.id} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SparkGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M3.4 12.6l1.8-1.8M10.8 5.2l1.8-1.8" />
    </svg>
  );
}

/* ---- the rules window ---- */

/** Only a whole answer is drawn; anything else reads as a failed read. */
function projectRulesOf(value: unknown): RoleMemoryProjectView {
  const view = value as RoleMemoryProjectView | null;
  if (!view || typeof view.enabled !== "boolean" || !Array.isArray(view.scopes)
    || !view.scopes.every((scope) => Array.isArray(scope?.active) && Array.isArray(scope?.left))) throw Error("role memory answer");
  return view;
}

function useProjectRules(project: string | null) {
  const [view, setView] = useState<RoleMemoryProjectView | null>(null);
  const [failed, setFailed] = useState<"read" | "save" | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!project) return;
    const abort = new AbortController();
    const read = async () => {
      const current = ++revision.current;
      try {
        const response = await fetch(`/api/role-memory?project=${encodeURIComponent(project)}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw Error();
        const value = projectRulesOf(await response.json());
        if (current === revision.current && !abort.signal.aborted) { setView(value); setFailed(null); }
      } catch { if (current === revision.current && !abort.signal.aborted) setFailed("read"); }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => { revision.current++; abort.abort(); clearInterval(timer); };
  }, [project]);
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!project) return;
    const current = ++revision.current;
    setBusy(true); setFailed(null);
    try {
      const response = await fetch("/api/role-memory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled }) });
      if (!response.ok) throw Error();
      const value = projectRulesOf(await response.json());
      if (current === revision.current) setView(value);
    } catch { if (current === revision.current) setFailed("save"); }
    finally { setBusy(false); }
  }, [project]);
  return { view, failed, busy, setEnabled };
}

function scopeName(t: TFunction, scope: ScopeView): string {
  if (scope.kind === "project") return t("roleMemory.scope.project");
  if (scope.kind === "machine") return t("roleMemory.scope.machine");
  return roleNameById(t, scope.roleId ?? "");
}

function scopeTitle(t: TFunction, scope: ScopeView): string {
  if (scope.kind === "role") return t("roleMemory.scopeTitle.role", { role: roleNameById(t, scope.roleId ?? "") });
  return t(`roleMemory.scopeTitle.${scope.kind}`);
}

const number = (value: number, locale: string) => value.toLocaleString(locale === "uk" ? "uk-UA" : "en-US");

function RuleBlock({ rule, t, focused, scopeRole }: { rule: RuleView; t: TFunction; focused: boolean; scopeRole: string | null }) {
  /* Who left it is news only where it differs from the scope's own role. */
  const author = rule.roleId && rule.roleId !== scopeRole ? roleNameById(t, rule.roleId) : null;
  const meta = [author, rule.fixRound ? t("roleMemory.fixRound") : null].filter(Boolean).join(" · ");
  return (
    <li data-learned-rule={rule.id} data-focused={focused ? "" : undefined}
      className={`rounded-[10px] border-l-[3px] border-accent px-3 py-2 ${focused ? "bg-accent-soft ring-1 ring-accent/40" : "bg-accent/10"}`}>
      <p className="m-0 text-[13px] leading-snug text-primary">{rule.rule}</p>
      <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-secondary"><b className="font-semibold">{t("roleMemory.why")}</b> {rule.why}</p>
      {rule.fresh || rule.hints.length || meta ? (
        <p className="m-0 mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted">
          {rule.fresh ? <span className="rounded-full bg-success-soft px-1.5 font-semibold text-success">{t("roleMemory.new")}</span> : null}
          {rule.hints.length ? <span data-learned-rule-hint="" className="rounded-full bg-warning-soft px-1.5 font-semibold text-warning">{t("roleMemory.checkText")}</span> : null}
          {meta ? <span>{meta}</span> : null}
        </p>
      ) : null}
    </li>
  );
}

function LeftBlock({ rule, t }: { rule: RuleView; t: TFunction }) {
  return (
    <li data-left-rule={rule.id} className="border-b border-border py-2 last:border-b-0">
      <p className="m-0 text-[12px] leading-snug text-muted line-through">{rule.rule}</p>
      <p className="m-0 mt-0.5 text-[11px] leading-4 text-muted">{t(rule.reason === "duplicate" ? "roleMemory.left.duplicate" : "roleMemory.left.budget")}</p>
    </li>
  );
}

/** The rules window: a wide dialog on the desktop, a full-screen sheet on the phone. */
export function RulesWindow({ project, focusRule, onClose }: { project: string; focusRule?: string; onClose: () => void }) {
  const { t, locale } = useLocale();
  const { view, failed } = useProjectRules(project);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const scopes = view?.scopes ?? [];
  const focusScope = focusRule ? scopes.find((scope) => scope.active.some((rule) => rule.id === focusRule))?.scope : undefined;
  const current = scopes.find((scope) => scope.scope === (chosen ?? focusScope)) ?? scopes.find((scope) => scope.active.length) ?? scopes[0] ?? null;
  if (typeof document === "undefined") return null;
  const groups = [
    { key: "project", label: t("roleMemory.section.project"), items: scopes.filter((scope) => scope.kind !== "machine") },
    { key: "machine", label: t("roleMemory.section.machine"), items: scopes.filter((scope) => scope.kind === "machine") },
  ];
  return createPortal(
    <div className={`fixed inset-0 ${Z.overlay} flex items-stretch justify-center bg-black/40 md:items-center md:p-6`} onClick={onClose}>
      <section data-rules-window="" role="dialog" aria-modal="true" aria-labelledby="rules-window-title"
        className="flex h-full w-full flex-col overflow-hidden bg-canvas text-primary shadow-xl md:h-[min(720px,90dvh)] md:max-w-[1120px] md:rounded-xl md:border md:border-border"
        onClick={(event) => event.stopPropagation()}>
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-4">
          <SparkGlyph />
          <h2 id="rules-window-title" className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">{t("roleMemory.window.title", { project: view?.project ?? project })}</h2>
          <span className="hidden text-[11.5px] text-muted md:inline">{t("roleMemory.window.clean")}</span>
          <button type="button" data-rules-window-close="" autoFocus aria-label={t("roleMemory.window.close")} onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-[20px] text-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">×</button>
        </header>
        {failed === "read" && !view ? <p role="alert" className="m-4 text-[13px] text-danger">{t("roleMemory.loadFailed")}</p> : null}
        {view && !view.enabled ? <p data-rules-window-off="" className="m-0 border-b border-border bg-warning-soft px-4 py-2 text-[12px] text-primary">{t("roleMemory.off")}</p> : null}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label={t("roleMemory.row")} className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2 md:w-[220px] md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:px-2 md:py-3">
            {groups.map((group) => group.items.length ? (
              <div key={group.key} className="contents md:flex md:flex-col md:gap-0.5">
                <span className="hidden px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted md:block">{group.label}</span>
                {group.items.map((scope) => {
                  const selected = scope.scope === current?.scope;
                  return (
                    <button key={scope.scope} type="button" data-rules-scope={scope.scope} aria-current={selected ? "true" : undefined} onClick={() => setChosen(scope.scope)}
                      className={`flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-[12.5px] md:rounded-[8px] md:border-transparent md:px-2 ${selected ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-primary hover:bg-sunken"}`}>
                      <span className="min-w-0 flex-1 truncate text-left">{scopeName(t, scope)}</span>
                      {scope.active.length ? <span className="text-[11px] tabular-nums text-muted">{scope.active.length}</span> : null}
                      {scope.addedToday ? <span className="rounded-full bg-success-soft px-1.5 text-[10.5px] font-semibold text-success">+{scope.addedToday}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null)}
          </nav>
          {current ? (
            <>
              <div data-rules-scope-page={current.scope} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
                <h3 className="m-0 text-[14px] font-semibold">{scopeTitle(t, current)}</h3>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
                  <span data-rules-size="" className="tabular-nums">{t("roleMemory.size", { chars: number(current.chars, locale), bound: number(current.bound, locale) })}</span>
                  <span aria-hidden className="block h-1 w-28 overflow-hidden rounded-full bg-well"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (current.chars / current.bound) * 100)}%` }} /></span>
                </div>
                {current.active.length ? (
                  <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
                    {current.active.slice().reverse().map((rule) => <RuleBlock key={rule.id} rule={rule} t={t} focused={rule.id === focusRule} scopeRole={current.roleId} />)}
                  </ol>
                ) : <p className="mt-3 text-[12.5px] text-muted">{t("roleMemory.empty")}</p>}
              </div>
              <aside data-rules-left="" className="shrink-0 overflow-y-auto border-t border-border px-4 py-3 md:w-[300px] md:border-l md:border-t-0">
                <h3 className="m-0 text-[12px] font-semibold text-secondary">{t("roleMemory.history")} · {current.left.length}</h3>
                {current.left.length
                  ? <ul className="m-0 mt-1 list-none p-0">{current.left.map((rule) => <LeftBlock key={rule.id} rule={rule} t={t} />)}</ul>
                  : <p className="mt-1 text-[12px] text-muted">{t("roleMemory.historyEmpty")}</p>}
              </aside>
            </>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/* ---- the project's switch and the way into the window ---- */

/** The per-project switch and the row that opens the rules window: a page of the board's ⋯ beside the project's other switches, and the project rules on the phone. */
export function LearnedRulesSettings({ project, size }: { project: string | null; size: "menu" | "sheet" }) {
  const { t } = useLocale();
  const { view, failed, busy, setEnabled } = useProjectRules(project);
  const [open, setOpen] = useState(false);
  if (!project) return null;
  const sheet = size === "sheet";
  const rules = view?.scopes.reduce((sum, scope) => sum + scope.active.length, 0) ?? 0;
  return (
    <div data-learned-rules-settings="" className={`flex flex-col ${sheet ? "gap-1" : "gap-0.5"}`}>
      <ProjectSettingRow
        label={t("roleMemory.switch")}
        hint={failed === "save" ? t("memory.save.failed") : failed === "read" ? t("roleMemory.loadFailed") : t("roleMemory.switchHint")}
        enabled={Boolean(view?.enabled)}
        disabled={busy || !view}
        failed={failed !== null}
        variant={size}
        rowProps={{ "data-learned-rules-setting": "" }}
        switchProps={{ "data-learned-rules-switch": "", onClick: () => { if (view) void setEnabled(!view.enabled); } }}
      />
      <div className={`flex items-center gap-2 ${sheet ? "min-h-11 px-4" : "min-h-8 px-2"}`}>
        <SparkGlyph />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{t("roleMemory.row")}</span>
          <span data-learned-rules-count="" className={`truncate text-muted ${sheet ? "text-label" : "text-[11px] leading-[14px]"}`}>
            {t("roleMemory.count", { count: rules })}
          </span>
        </span>
        <button type="button" data-learned-rules-open="" disabled={!view} onClick={() => setOpen(true)}
          className={sheet
            ? "min-h-11 rounded-[8px] border border-border bg-card px-3.5 text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            : "h-7 rounded-[7px] border border-border bg-card px-2.5 text-[11.5px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}>
          {t("roleMemory.open")}
        </button>
      </div>
      {open ? <RulesWindow project={project} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
