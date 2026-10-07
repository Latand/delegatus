"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { roleNameById } from "@/components/builderCopy";
import { Z } from "@/components/layers";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStageReportEntry } from "@/lib/pipelines/types";
import type { RoleMemoryProjectView, RuleView, ScopeKind, ScopeView, StageLessonView } from "@/lib/memory/roleTypes";

/* Role memory on the operator's surfaces (docs/design/role-memory.md §3.1).
   The operator chose the rules window and the rule line (2026-10-07) and then
   asked, over the built frames, for three visibly separate kinds of rule —
   role, project, machine — that a new agent receives together; each rule a
   small row that a tap removes, with an undo; no switch, memory is always on;
   and «щоб не було дуже багато тексту». The window opens from one row on the
   board's ⋯ and from the line under a stage report, through one host. */

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
  const lesson = lessons?.find((item) => item.pipelineId === pipeline.id && item.stageId === entry.stageId && item.attempt === entry.attempt);
  if (!lesson) return null;
  const attempt = pipeline.runs.find((run) => run.stageId === entry.stageId)?.attempts.find((candidate) => candidate.n === entry.attempt);
  if (!lesson.rules.length) {
    if (!attempt?.completedAt) return null;
    return <p className="stage-lesson" data-stage-lesson="none" title={lesson.none ?? undefined}>{t("roleMemory.line.none")}</p>;
  }
  const targets = [...new Set(lesson.rules.map((rule) => targetName(t, rule)))].join(", ");
  return (
    <button type="button" className="stage-lesson" data-stage-lesson={lesson.rules.length} onClick={(event) => { event.stopPropagation(); openRulesWindow(pipeline.project, lesson.rules[0]!.id); }}>
      <span className="head"><SparkGlyph />{t("roleMemory.line.left", { count: lesson.rules.length, targets })}</span>
      <span className="rule">“{lesson.rules[0]!.rule}”</span>
    </button>
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

const OPEN_EVENT = "delegatus:open-learned-rules";

/** Opens the rules window through its one host, so it outlives the menu or card it was opened from. */
export function openRulesWindow(project: string, focusRule?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { project, focusRule } }));
}

/** Mounted once beside the Viewer's other hosts. */
export function LearnedRulesWindowHost() {
  const [request, setRequest] = useState<{ project: string; focusRule?: string } | null>(null);
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<{ project: string; focusRule?: string }>).detail);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
  const close = useCallback(() => setRequest(null), []);
  return request ? <RulesWindow project={request.project} focusRule={request.focusRule} onClose={close} /> : null;
}

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
  /** Removes a rule from the injected list or puts one back; the answer is the project's new reading. */
  const act = useCallback(async (action: "delete" | "restore", ruleId: string) => {
    if (!project) return false;
    const current = ++revision.current;
    try {
      const response = await fetch("/api/role-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, action, ruleId }) });
      if (!response.ok) throw Error();
      const value = projectRulesOf(await response.json());
      if (current === revision.current) { setView(value); setFailed(null); }
      return true;
    } catch { if (current === revision.current) setFailed("save"); return false; }
  }, [project]);
  return { view, failed, act };
}

const number = (value: number, locale: string) => value.toLocaleString(locale === "uk" ? "uk-UA" : "en-US");

/* Each kind of rule has its own colour, used for its heading, its bar and its rows' marker. */
const KIND_TONE: Record<ScopeKind, { bar: string; dot: string; soft: string; text: string }> = {
  role: { bar: "border-t-accent", dot: "bg-accent", soft: "bg-accent-soft", text: "text-accent" },
  project: { bar: "border-t-info", dot: "bg-info", soft: "bg-info-soft", text: "text-info" },
  machine: { bar: "border-t-warning", dot: "bg-warning", soft: "bg-warning-soft", text: "text-warning" },
};

function RuleRow({ rule, kind, focused, scopeRole, onDelete }: { rule: RuleView; kind: ScopeKind; focused: boolean; scopeRole: string | null; onDelete: (rule: RuleView) => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(focused);
  /* Who left it is news only where it differs from the scope's own role. */
  const author = rule.roleId && rule.roleId !== scopeRole ? roleNameById(t, rule.roleId) : null;
  const meta = [author, rule.fixRound ? t("roleMemory.fixRound") : null].filter(Boolean).join(" · ");
  return (
    <li data-learned-rule={rule.id} data-focused={focused ? "" : undefined} data-open={open ? "" : undefined}
      className={`group flex items-start gap-2 rounded-[8px] px-2 py-1.5 ${focused ? KIND_TONE[kind].soft : "hover:bg-sunken"}`}>
      <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${KIND_TONE[kind].dot}`} />
      <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} title={open ? undefined : `${t("roleMemory.why")} ${rule.why}`}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className={`block text-[12.5px] leading-[17px] text-primary ${open ? "" : "line-clamp-2"}`}>{rule.rule}</span>
        {open ? (
          <span className="mt-0.5 block text-[11.5px] leading-4 text-secondary">
            <b className="font-semibold">{t("roleMemory.why")}</b> {rule.why}
            {meta ? <span className="text-muted"> · {meta}</span> : null}
          </span>
        ) : null}
        {rule.fresh || rule.hints.length ? (
          <span className="mt-0.5 flex flex-wrap gap-1 text-[10.5px] font-semibold leading-4">
            {rule.fresh ? <span className="rounded-full bg-success-soft px-1.5 text-success">{t("roleMemory.new")}</span> : null}
            {rule.hints.length ? <span data-learned-rule-hint="" className="rounded-full bg-warning-soft px-1.5 text-warning">{t("roleMemory.checkText")}</span> : null}
          </span>
        ) : null}
      </button>
      <button type="button" data-learned-rule-delete={rule.id} aria-label={t("roleMemory.delete")} title={t("roleMemory.delete")} onClick={() => onDelete(rule)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[15px] leading-none text-muted hover:bg-well hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9">×</button>
    </li>
  );
}

function LeftRow({ rule, onRestore }: { rule: RuleView; onRestore: (rule: RuleView) => void }) {
  const { t } = useLocale();
  const reason = rule.reason === "duplicate" ? "roleMemory.left.duplicate" : rule.reason === "deleted" ? "roleMemory.left.deleted" : "roleMemory.left.budget";
  return (
    <li data-left-rule={rule.id} className="flex items-start gap-2 px-2 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] leading-4 text-muted line-through line-clamp-2">{rule.rule}</span>
        <span className="block text-[10.5px] leading-4 text-muted">{t(reason)}</span>
      </span>
      <button type="button" data-left-rule-restore={rule.id} onClick={() => onRestore(rule)}
        className="h-6 shrink-0 rounded-[6px] px-1.5 text-[11px] font-semibold text-accent hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t("roleMemory.restore")}</button>
    </li>
  );
}

/** One kind of rule: its heading in its colour, its size against 10 000, its rows, and what left it behind one toggle. */
function RuleSection({ kind, title, subtitle, scope, picker, focusRule, onDelete, onRestore }: {
  kind: ScopeKind; title: string; subtitle: string; scope: ScopeView | null; picker?: ReactNode; focusRule?: string;
  onDelete: (rule: RuleView) => void; onRestore: (rule: RuleView) => void;
}) {
  const { t, locale } = useLocale();
  const [history, setHistory] = useState(false);
  const chars = scope?.chars ?? 0;
  const bound = scope?.bound ?? 10_000;
  return (
    <section data-rules-section={kind} data-rules-scope-page={scope?.scope ?? ""} className={`flex min-h-0 min-w-0 flex-col rounded-[10px] border border-border border-t-[3px] bg-card ${KIND_TONE[kind].bar}`}>
      <header className="flex flex-col gap-1 px-3 pb-1.5 pt-2">
        <div className="flex items-baseline gap-2">
          <h3 className={`m-0 text-[13px] font-semibold ${KIND_TONE[kind].text}`}>{title}</h3>
          <span data-rules-count="" className="text-[11.5px] tabular-nums text-muted">{scope?.active.length ?? 0}</span>
          <span className="ml-auto text-[10.5px] tabular-nums text-muted" data-rules-size="">{t("roleMemory.size", { chars: number(chars, locale), bound: number(bound, locale) })}</span>
        </div>
        <span className="text-[11px] leading-4 text-muted">{subtitle}</span>
        {picker}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {scope?.active.length ? (
          <ol className="m-0 flex list-none flex-col p-0">
            {scope.active.slice().reverse().map((rule) => <RuleRow key={rule.id} rule={rule} kind={kind} focused={rule.id === focusRule} scopeRole={scope.roleId} onDelete={onDelete} />)}
          </ol>
        ) : <p className="m-0 px-2 py-1.5 text-[11.5px] text-muted">{t("roleMemory.empty")}</p>}
        {scope?.left.length ? (
          <div className="border-t border-border pt-0.5">
            <button type="button" data-rules-history={kind} aria-expanded={history} onClick={() => setHistory((was) => !was)}
              className="flex h-7 w-full items-center gap-1 rounded-[6px] px-2 text-left text-[11px] font-semibold text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <span className="flex-1">{t("roleMemory.history")} · {scope.left.length}</span><span aria-hidden>{history ? "▴" : "▾"}</span>
            </button>
            {history ? <ul className="m-0 list-none p-0">{scope.left.map((rule) => <LeftRow key={rule.id} rule={rule} onRestore={onRestore} />)}</ul> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The rules window: the role, project and machine rules a new agent of the chosen role starts with, side by side on the desktop and stacked on the phone. */
export function RulesWindow({ project, focusRule, onClose }: { project: string; focusRule?: string; onClose: () => void }) {
  const { t } = useLocale();
  const { view, failed, act } = useProjectRules(project);
  const [chosenRole, setChosenRole] = useState<string | null>(null);
  const [undo, setUndo] = useState<RuleView | null>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8_000);
    return () => clearTimeout(timer);
  }, [undo]);
  const scopes = view?.scopes ?? [];
  const roleScopes = scopes.filter((scope) => scope.kind === "role");
  const focusRole = focusRule ? scopes.find((scope) => scope.active.some((rule) => rule.id === focusRule))?.roleId : null;
  const roles = [...new Set([...roleScopes.map((scope) => scope.roleId!), ...(roleScopes.length ? [] : ["builder"])])];
  const role = chosenRole ?? (focusRole && scopes.some((scope) => scope.roleId === focusRole) ? focusRole : roles.includes("builder") ? "builder" : roles[0]!);
  const roleScope = roleScopes.find((scope) => scope.roleId === role) ?? null;
  const projectScope = scopes.find((scope) => scope.kind === "project") ?? null;
  const machineScope = scopes.find((scope) => scope.kind === "machine") ?? null;
  const roleName = roleNameById(t, role);
  const remove = async (rule: RuleView) => { if (await act("delete", rule.id)) setUndo(rule); };
  const restore = async (rule: RuleView) => { if (await act("restore", rule.id)) setUndo(null); };
  if (typeof document === "undefined") return null;
  const picker = roles.length > 1 ? (
    <div role="tablist" aria-label={t("roleMemory.roleSection")} className="flex gap-1 overflow-x-auto pt-0.5">
      {roles.map((id) => {
        const count = roleScopes.find((scope) => scope.roleId === id)?.active.length ?? 0;
        const selected = id === role;
        return (
          <button key={id} type="button" role="tab" aria-selected={selected} data-rules-role={id} onClick={() => setChosenRole(id)}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11.5px] [@media(pointer:coarse)]:h-9 ${selected ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-secondary hover:bg-sunken"}`}>
            {roleNameById(t, id)}<span className="tabular-nums text-muted">{count}</span>
          </button>
        );
      })}
    </div>
  ) : null;
  const counts = { role: roleScope?.active.length ?? 0, project: projectScope?.active.length ?? 0, machine: machineScope?.active.length ?? 0 };
  return createPortal(
    <div className={`fixed inset-0 ${Z.overlay} flex items-stretch justify-center bg-black/40 md:items-center md:p-6`} onClick={onClose}>
      <section data-rules-window="" role="dialog" aria-modal="true" aria-labelledby="rules-window-title"
        className="relative flex h-full w-full flex-col overflow-hidden bg-canvas text-primary shadow-xl md:h-[min(640px,90dvh)] md:max-w-[1120px] md:rounded-xl md:border md:border-border"
        onClick={(event) => event.stopPropagation()}>
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-4 py-2">
          <SparkGlyph />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id="rules-window-title" className="m-0 truncate text-[15px] font-semibold">{t("roleMemory.window.title", { project: view?.project ?? project })}</h2>
            <p data-rules-starts="" className="m-0 text-[11.5px] leading-4 text-muted">
              {t("roleMemory.startsWith", { role: roleName })}{" "}
              <span className="text-accent">{t("roleMemory.n.role", { count: counts.role })}</span>{" · "}
              <span className="text-info">{t("roleMemory.n.project", { count: counts.project })}</span>{" · "}
              <span className="text-warning">{t("roleMemory.n.machine", { count: counts.machine })}</span>
            </p>
          </div>
          <button type="button" data-rules-window-close="" autoFocus aria-label={t("roleMemory.window.close")} onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-[20px] text-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">×</button>
        </header>
        {failed === "read" && !view ? <p role="alert" className="m-4 text-[13px] text-danger">{t("roleMemory.loadFailed")}</p> : null}
        {failed === "save" ? <p role="alert" className="m-0 border-b border-border px-4 py-1.5 text-[12px] text-danger">{t("roleMemory.saveFailed")}</p> : null}
        {view && !view.enabled ? <p data-rules-window-off="" className="m-0 border-b border-border bg-warning-soft px-4 py-1.5 text-[12px] text-primary">{t("roleMemory.off")}</p> : null}
        {view ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto p-3 md:grid-cols-3 md:content-stretch md:overflow-hidden">
            <RuleSection kind="role" title={t("roleMemory.roleSection")} subtitle={t("roleMemory.roleSubtitle", { role: roleName })} scope={roleScope} picker={picker} focusRule={focusRule} onDelete={remove} onRestore={restore} />
            <RuleSection kind="project" title={t("roleMemory.projectSection")} subtitle={t("roleMemory.projectSubtitle")} scope={projectScope} focusRule={focusRule} onDelete={remove} onRestore={restore} />
            <RuleSection kind="machine" title={t("roleMemory.machineSection")} subtitle={t("roleMemory.machineSubtitle")} scope={machineScope} focusRule={focusRule} onDelete={remove} onRestore={restore} />
          </div>
        ) : null}
        {undo ? (
          <div role="status" data-rules-undo="" className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-primary px-4 py-1.5 text-[12px] text-canvas shadow-xl">
            <span>{t("roleMemory.deleted")}</span>
            <button type="button" data-rules-undo-button="" onClick={() => void restore(undo)} className="min-h-7 font-semibold underline underline-offset-2 focus-visible:outline-none">{t("roleMemory.undo")}</button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

/* ---- the way in ---- */

/** One row that opens the window: on the board's ⋯ and among the phone's project rules. No switch: memory is always on. */
export function LearnedRulesRow({ project, size, onOpened }: { project: string | null; size: "menu" | "sheet"; onOpened?: () => void }) {
  const { t } = useLocale();
  const { view } = useProjectRules(project);
  if (!project) return null;
  const sheet = size === "sheet";
  const count = (kind: ScopeKind) => view?.scopes.filter((scope) => scope.kind === kind).reduce((sum, scope) => sum + scope.active.length, 0) ?? 0;
  return (
    <button type="button" data-learned-rules-open="" onClick={() => { openRulesWindow(project); onOpened?.(); }}
      className={sheet
        ? "flex min-h-11 w-full items-center gap-2 px-4 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        : "flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}>
      <SparkGlyph />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{t("roleMemory.row")}</span>
        <span data-learned-rules-count="" className={`truncate text-muted ${sheet ? "text-label" : "text-[11px] leading-[14px]"}`}>
          <span className="text-accent">{t("roleMemory.n.role", { count: count("role") })}</span>{" · "}
          <span className="text-info">{t("roleMemory.n.project", { count: count("project") })}</span>{" · "}
          <span className="text-warning">{t("roleMemory.n.machine", { count: count("machine") })}</span>
        </span>
      </span>
      <span aria-hidden className="text-muted">›</span>
    </button>
  );
}
