"use client";

import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { roleNameById } from "@/components/builderCopy";
import { Z } from "@/components/layers";
import { BAR_MENU_ROW } from "@/components/ProjectBar";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStageReportEntry } from "@/lib/pipelines/types";
import type { RoleMemoryProjectView, RuleView, ScopeKind, ScopeView, StageLessonView } from "@/lib/memory/roleTypes";
import { RoleAvatar, roleAvatarKey } from "@/components/brand/RoleAvatar";
import { MemoryProfile } from "./MemoryProfile";
import { RoleMark } from "./RoleMark";

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
      <span className="head"><SparkGlyph />{t(lesson.rewrote ? "roleMemory.line.rewrote" : "roleMemory.line.left", { count: lesson.rules.length, targets })}</span>
      <span className="rule">“{lesson.rules[0]!.rule}”</span>
    </button>
  );
}

function SparkGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
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
  return request ? <RulesWindow key={`${request.project}/${request.focusRule ?? ""}`} project={request.project} focusRule={request.focusRule} onClose={close} /> : null;
}

/** Only a whole answer is drawn; anything else reads as a failed read. */
function projectRulesOf(value: unknown): RoleMemoryProjectView {
  const view = value as RoleMemoryProjectView | null;
  if (!view || typeof view.enabled !== "boolean" || !Array.isArray(view.scopes)
    || !view.scopes.every((scope) => Array.isArray(scope?.active) && Array.isArray(scope?.left))) throw Error("role memory answer");
  return view;
}

/** The reading as `action` leaves it, as far as the client can tell. */
export function predictedRules(view: RoleMemoryProjectView, action: "delete" | "restore" | "revert" | "revert-pass", id: string, at = new Date().toISOString()): RoleMemoryProjectView {
  if (action === "revert-pass") return view;
  return { ...view, scopes: view.scopes.map((scope) => {
    if (action === "delete") {
      const rule = scope.active.find((candidate) => candidate.id === id);
      return rule ? { ...scope, active: scope.active.filter((candidate) => candidate !== rule), left: [{ ...rule, state: "archived" as const, reason: "deleted" as const, changedAt: at }, ...scope.left] } : scope;
    }
    if (action === "restore") {
      const rule = scope.left.find((candidate) => candidate.id === id);
      if (!rule) return scope;
      const { reason: _reason, ...kept } = rule;
      return { ...scope, left: scope.left.filter((candidate) => candidate !== rule), active: [...scope.active, { ...kept, state: "active" as const, changedAt: at }] };
    }
    const revise = (rule: RuleView): RuleView => {
      const version = rule.versions?.find((candidate) => candidate.id === id);
      return version ? { ...rule, rule: version.rule, why: version.why, hints: version.hints } : rule;
    };
    return { ...scope, active: scope.active.map(revise), left: scope.left.map(revise) };
  }) };
}

/* The last reading of each project, shared by every reader of it: the board's ⋯ row has it before the window is opened, and the window draws it at once and refreshes behind it. */
const rulesByProject = new Map<string, RoleMemoryProjectView>();

function useProjectRules(project: string | null) {
  /* The last reading the server gave, and the presses still on their way,
     drawn over it in the order they were made (audit B26). A refusal drops
     only its own press, so the screen falls back to the server's reading with
     every other press still drawn. */
  const [latest, setLatest] = useState<{ project: string; view: RoleMemoryProjectView } | null>(null);
  const stored = project ? (latest?.project === project ? latest.view : rulesByProject.get(project) ?? null) : null;
  const setStored = useCallback((value: RoleMemoryProjectView) => {
    if (!project) return;
    rulesByProject.set(project, value);
    setLatest({ project, view: value });
  }, [project]);
  const [presses, setPresses] = useState<ReadonlyArray<{ seq: number; action: "delete" | "restore" | "revert" | "revert-pass"; ruleId: string }>>([]);
  const [failed, setFailed] = useState<"read" | "save" | null>(null);
  const reads = useRef(0);
  const pressSeq = useRef(0);
  useEffect(() => {
    if (!project) return;
    const sequence = reads;
    const abort = new AbortController();
    const read = async () => {
      const current = ++sequence.current;
      try {
        const response = await fetch(`/api/role-memory?project=${encodeURIComponent(project)}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw Error();
        const value = projectRulesOf(await response.json());
        if (current === sequence.current && !abort.signal.aborted) { setStored(value); setFailed(null); }
      } catch { if (current === sequence.current && !abort.signal.aborted) setFailed("read"); }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => { sequence.current++; abort.abort(); clearInterval(timer); };
  }, [project, setStored]);
  const view = useMemo(() => (stored ? presses.reduce((held, press) => predictedRules(held, press.action, press.ruleId), stored) : stored), [stored, presses]);
  /** Removes a rule from the injected list or puts one back; the answer is the project's new reading.
      Delete, restore and a text's revert are drawn at once and a refusal takes
      back that press alone; undoing a curator's pass waits, since the server
      holds what the pass changed. */
  const act = useCallback(async (action: "delete" | "restore" | "revert" | "revert-pass", ruleId: string) => {
    if (!project) return false;
    const seq = ++pressSeq.current;
    setPresses((held) => [...held, { seq, action, ruleId }]);
    const settle = () => setPresses((held) => held.filter((press) => press.seq !== seq));
    try {
      const response = await fetch("/api/role-memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, action, ruleId }) });
      if (!response.ok) throw Error();
      const value = projectRulesOf(await response.json());
      /* The answer is newer than any read already out. */
      reads.current++;
      setStored(value); setFailed(null); settle();
      return true;
    } catch { settle(); setFailed("save"); return false; }
  }, [project, setStored]);
  return { view, failed, act };
}

const number = (value: number, locale: string) => value.toLocaleString(locale === "uk" ? "uk-UA" : "en-US");

/* Each kind of rule has its own colour, used for its heading, its bar and its rows' marker. */
const KIND_TONE: Record<ScopeKind, { bar: string; dot: string; soft: string; text: string }> = {
  role: { bar: "border-t-accent", dot: "bg-accent", soft: "bg-accent-soft", text: "text-accent" },
  swarm: { bar: "border-t-info", dot: "bg-info", soft: "bg-info-soft", text: "text-info" },
  project: { bar: "border-t-info", dot: "bg-info", soft: "bg-info-soft", text: "text-info" },
  machine: { bar: "border-t-warning", dot: "bg-warning", soft: "bg-warning-soft", text: "text-warning" },
};

function RuleRow({ rule, kind, focused, scopeRole, onDelete, onRevert }: { rule: RuleView; kind: ScopeKind; focused: boolean; scopeRole: string | null; onDelete: (rule: RuleView) => void; onRevert?: (id: string) => void }) {
  const { t } = useLocale();
  const [expansion, setExpansion] = useState({ focused, open: focused });
  const open = expansion.focused === focused ? expansion.open : focused || expansion.open;
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focused) row.current?.scrollIntoView({ block: "nearest" }); }, [focused]);
  /* Who left it is news only where it differs from the scope's own role. */
  const author = rule.roleId && rule.roleId !== scopeRole ? roleNameById(t, rule.roleId) : null;
  const revision = rule.revisedBy;
  const awaitingCurator = rule.awaitingCuration ?? (!rule.curatedAt || revision?.by === "agent" && revision.at > rule.curatedAt);
  const named = (id: string | null | undefined, text: string) => <><RoleMark role={id} size={12} />{text}</>;
  const meta = [rule.keptByOperatorAt ? t("roleMemory.kept") : awaitingCurator ? t("roleMemory.unreviewed") : null, revision ? named(revision.roleId, t(`roleMemory.revised.${revision.by}`, { role: roleNameById(t, revision.roleId ?? "") })) : author ? named(rule.roleId, author) : null, (revision?.fixRound ?? rule.fixRound) ? t("roleMemory.fixRound") : null, rule.mergedFrom?.length ? t("roleMemory.mergedFrom", { count: rule.mergedFrom.length }) : null, (rule.tasks ?? 0) >= 2 ? t("roleMemory.tasks", { count: rule.tasks! }) : null].filter(Boolean);
  return (
    <li ref={row} data-learned-rule={rule.id} data-focused={focused ? "" : undefined} data-open={open ? "" : undefined}
      className={`group flex items-start gap-2 rounded-[8px] px-2 py-1.5 ${focused ? KIND_TONE[kind].soft : "hover:bg-sunken"}`}>
      <span aria-hidden className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${KIND_TONE[kind].dot}`} />
      <div className="min-w-0 flex-1">
      <button type="button" aria-expanded={open} onClick={() => setExpansion({ focused, open: !open })} title={rule.note ?? (open ? undefined : `${t("roleMemory.why")} ${rule.why}`)}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className={`block text-[12.5px] leading-[17px] text-primary ${open ? "" : "line-clamp-2"}`}>{rule.rule}</span>
        {open ? (
          <span className="mt-0.5 block text-[11.5px] leading-4 text-secondary">
            {kind === "swarm" ? t("roleMemory.swarmPublic") : <><b className="font-semibold">{t("roleMemory.why")}</b> {rule.why}</>}
            {meta.length ? <span data-rule-provenance="" className="text-muted"> · {meta.map((part, index) => <span key={index}>{index ? " · " : ""}{part}</span>)}</span> : null}
          </span>
        ) : null}
        {rule.hints.length ? (
          <span className="mt-0.5 flex text-[10.5px] font-semibold leading-4">
            <span data-learned-rule-hint="" className="rounded-full bg-warning-soft px-1.5 text-warning">{t("roleMemory.checkText")}</span>
          </span>
        ) : null}
      </button>
      {open ? <EarlierTexts rule={rule} onRevert={onRevert} /> : null}
      </div>
      {kind !== "swarm" && <button type="button" data-learned-rule-delete={rule.id} aria-label={t("roleMemory.delete")} title={t("roleMemory.delete")} onClick={() => onDelete(rule)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[15px] leading-none text-muted hover:bg-well hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9">×</button>}
    </li>
  );
}

function EarlierTexts({ rule, onRevert }: { rule: RuleView; onRevert?: (id: string) => void }) {
  const { t, locale } = useLocale();
  if (!rule.versions?.length) return null;
  return <details data-rule-versions={rule.id} className="text-[11.5px] leading-4 text-secondary">
    <summary className="cursor-pointer py-1">{t("roleMemory.versions", { count: rule.versions.length })}</summary>
    <ul className="m-0 list-none p-0">{rule.versions.slice().reverse().map(version => <li key={version.id} className="border-t border-border py-1">
      <p className="m-0">{version.rule}</p><p className="m-0 text-muted">{version.why}</p>
      <p className="m-0 text-[10.5px] text-muted">{new Date(version.revisedBy?.at ?? version.createdAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-US")}{version.revisedBy ? <> · <RoleMark role={version.revisedBy.roleId} size={12} />{t(`roleMemory.revised.${version.revisedBy.by}`, { role: roleNameById(t, version.revisedBy.roleId ?? "") })}</> : null}</p>
      <button type="button" data-rule-revert={version.id} className="min-h-9 px-1 text-accent" onClick={() => onRevert?.(version.id)}>{t("roleMemory.restore")}</button>
    </li>)}</ul>
  </details>;
}

function LeftRow({ rule, onRestore, counterpart, onFocus, onRevert }: { rule: RuleView; onRestore: (rule: RuleView) => void; counterpart?: RuleView; onFocus?: (id: string) => void; onRevert?: (id: string) => void }) {
  const { t } = useLocale();
  const reason: `roleMemory.left.${NonNullable<RuleView["reason"]> | "merged"}` = rule.state === "merged" ? "roleMemory.left.merged" : `roleMemory.left.${rule.reason ?? "budget"}`;
  return (
    <li title={rule.note} data-left-rule={rule.id} className="flex items-start gap-2 px-2 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] leading-4 text-muted line-through line-clamp-2">{rule.rule}</span>
        <span className="block text-[10.5px] leading-4 text-muted">{t(reason)}{rule.where ? ` · ${rule.where}` : ""}</span>
        {counterpart ? <button type="button" data-rule-counterpart={counterpart.id} onClick={() => onFocus?.(counterpart.id)} className="text-left text-[11px] leading-4 text-accent">{counterpart.rule.slice(0, 70)}…</button> : null}
        <EarlierTexts rule={rule} onRevert={onRevert} />
      </span>
      <button type="button" data-left-rule-restore={rule.id} onClick={() => onRestore(rule)}
        className="h-6 shrink-0 rounded-[6px] px-1.5 text-[11px] font-semibold text-accent hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t("roleMemory.restore")}</button>
    </li>
  );
}

/** A rule just removed: the scope it left and where its row stood, so the undo takes that row's place. */
type Removed = { rule: RuleView; scope: string; at: number };

function UndoRow({ onUndo }: { onUndo: () => void }) {
  const { t } = useLocale();
  return (
    <li data-rules-undo="" aria-live="polite" className="flex min-h-8 items-center gap-3 rounded-[8px] bg-sunken px-2 py-1 text-[12px] text-secondary">
      <span className="min-w-0 flex-1 truncate">{t("roleMemory.deleted")}</span>
      <button type="button" data-rules-undo-button="" onClick={onUndo}
        className="h-7 shrink-0 rounded-[6px] px-1.5 text-[11.5px] font-semibold text-accent hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">{t("roleMemory.undo")}</button>
    </li>
  );
}

/* A scope's size is news only near its bound; below this share of it the heading stays free of the counter. */
const NEAR_BOUND = 0.8;

/** One kind of rule: its heading in its colour with its count when it has rules, its rows, what left it behind one toggle, and its size once it nears 10 000. A picker carries the counts itself; an empty kind says so once, in its body. */
export function RuleSection({ kind, title, subtitle, scope, additionalScope, swarm, picker, focusRule, removed, onDelete, onRestore, onRevert, allRules, onFocus }: {
  allRules?: RuleView[]; onFocus?: (id: string) => void;
  kind: ScopeKind; title: ReactNode; subtitle?: ReactNode; scope: ScopeView | null; additionalScope?: ScopeView | null; swarm?: ScopeView | null; picker?: ReactNode; focusRule?: string; removed?: Removed | null;
  onDelete: (rule: RuleView) => void; onRestore: (rule: RuleView) => void; onRevert?: (id: string) => void;
}) {
  const { t, locale } = useLocale();
  const [history, setHistory] = useState(false);
  const chars = scope?.chars ?? 0;
  const bound = scope?.bound ?? 10_000;
  const shown = scope?.active.slice().reverse() ?? [];
  const count = (scope?.active.length ?? 0) + (additionalScope?.active.length ?? 0) + (swarm?.active.length ?? 0);
  const undo = removed && scope && removed.scope === scope.scope ? removed : null;
  const rows: ReactNode[] = shown.map((rule) => <RuleRow key={rule.id} rule={rule} kind={kind} focused={rule.id === focusRule} scopeRole={scope!.roleId} onDelete={onDelete} onRevert={onRevert} />);
  if (undo) rows.splice(Math.min(undo.at, rows.length), 0, <UndoRow key="undo" onUndo={() => onRestore(undo.rule)} />);
  const additionalRows: ReactNode[] = additionalScope?.active.slice().reverse().map(rule => <RuleRow key={rule.id} rule={rule} kind={kind} focused={rule.id === focusRule} scopeRole={additionalScope.roleId} onDelete={onDelete} onRevert={onRevert} />) ?? [];
  if (removed && additionalScope?.scope === removed.scope) additionalRows.splice(Math.min(removed.at, additionalRows.length), 0, <UndoRow key="additional-undo" onUndo={() => onRestore(removed.rule)} />);
  return (
    <section data-rules-section={kind} data-rules-scope-page={scope?.scope ?? ""} className={`flex min-w-0 flex-col rounded-[10px] border border-border border-t-[3px] bg-card md:min-h-0 ${KIND_TONE[kind].bar}`}>
      <header className="flex flex-col gap-1 px-3 pb-1.5 pt-2">
        <div className="flex items-baseline gap-2">
          <h3 className={`m-0 min-w-0 text-[13px] font-semibold [overflow-wrap:anywhere] ${KIND_TONE[kind].text}`}>{title}</h3>
          {picker || !count ? null : <span data-rules-count="" className="text-[11.5px] tabular-nums text-muted">{count}</span>}
          {chars >= bound * NEAR_BOUND ? <span className="ml-auto text-[10.5px] tabular-nums text-warning" data-rules-size="">{t("roleMemory.size", { chars: number(chars, locale), bound: number(bound, locale) })}</span> : null}
        </div>
        {subtitle ? <span className="text-[11px] leading-4 text-muted">{subtitle}</span> : null}
        {picker}
      </header>
      <div className="px-1 pb-1 md:min-h-0 md:flex-1 md:overflow-y-auto">
        {kind === "role" && additionalScope !== undefined ? <p className="m-0 px-2 py-1 text-[11px] font-semibold text-muted">{t("roleMemory.thisProject")}</p> : null}
        {rows.length ? <ol className="m-0 flex list-none flex-col p-0">{rows}</ol> : <p className="m-0 px-2 py-1.5 text-[11.5px] text-muted">{t("roleMemory.empty")}</p>}
        {kind === "role" && additionalScope !== undefined ? <div data-rules-every-project="" className="border-t border-border">
          <p className="m-0 px-2 py-1 text-[11px] font-semibold text-muted">{t("roleMemory.everyProject")}</p>
          {additionalRows.length ? <ol className="m-0 list-none p-0">{additionalRows}</ol> : <p className="m-0 px-2 py-1.5 text-[11.5px] text-muted">{t("roleMemory.empty")}</p>}
          {additionalScope && additionalScope.chars >= additionalScope.bound * NEAR_BOUND ? <p data-rules-size="" className="m-0 px-2 text-[10.5px] text-warning">{t("roleMemory.size", { chars: number(additionalScope.chars, locale), bound: number(additionalScope.bound, locale) })}</p> : null}
        </div> : null}
        {swarm ? <div data-rules-swarm={swarm.scope} className="border-t border-border">
          <p className="m-0 px-2 py-1 text-[11px] font-semibold text-info"><RoleMark role={swarm.roleId} />{t("roleMemory.swarm", { role: roleNameById(t, swarm.roleId ?? "") })}</p>
          <p className="m-0 px-2 py-1 text-[11px] leading-4 text-muted">{t("roleMemory.swarmPublic")}</p>
          {swarm.active.length ? <ol className="m-0 list-none p-0">{swarm.active.map(rule => <RuleRow key={rule.id} rule={rule} kind="swarm" focused={rule.id === focusRule} scopeRole={swarm.roleId} onDelete={onDelete} />)}</ol> : <p className="m-0 px-2 py-1.5 text-[11.5px] text-muted">{t("roleMemory.empty")}</p>}
        </div> : null}
        {(scope?.left.length ?? 0) + (additionalScope?.left.length ?? 0) > 0 ? (
          <div className="border-t border-border pt-0.5">
            <button type="button" data-rules-history={kind} aria-expanded={history} onClick={() => setHistory((was) => !was)}
              className="flex h-7 w-full items-center gap-1 rounded-[6px] px-2 text-left text-[11px] font-semibold text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <span className="flex-1">{t("roleMemory.history")} · {(scope?.left.length ?? 0) + (additionalScope?.left.length ?? 0)}</span><span aria-hidden>{history ? "▴" : "▾"}</span>
            </button>
            {history ? <ul className="m-0 list-none p-0">{[...(scope?.left ?? []), ...(additionalScope?.left ?? [])].map((rule) => <LeftRow key={rule.id} rule={rule} onRestore={onRestore} counterpart={allRules?.find(r => r.id === (rule.against ?? rule.mergedInto))} onFocus={onFocus} onRevert={onRevert} />)}</ul> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Project memory profile and the source rules its agents start with. */
export function RulesWindow({ project, focusRule, onClose }: { project: string; focusRule?: string; onClose: () => void }) {
  const { t, locale } = useLocale();
  const failures: Record<string, string> = {
    "no-account": t("roleMemory.failure.noAccount"), "no-repository": t("roleMemory.failure.noRepository"),
    "launch-refused": t("roleMemory.failure.launchRefused"), "launch-failed": t("roleMemory.failure.launchFailed"),
    "turn-error": t("roleMemory.failure.turnError"), "timed-out": t("roleMemory.failure.timedOut"),
  };
  const { view, failed, act } = useProjectRules(project);
  const [focus, setFocus] = useState({ prop: focusRule, rule: focusRule });
  const localFocus = focus.prop === focusRule ? focus.rule : focusRule;
  const setLocalFocus = (id: string) => setFocus({ prop: focusRule, rule: id });
  const [page, setPage] = useState<"profile" | "rules">(focusRule ? "rules" : "profile");
  const [chosenRole, setChosenRole] = useState<string | null>(null);
  const [undo, setUndo] = useState<Removed | null>(null);
  const [drilled, setDrilled] = useState(false);
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
  const focusRole = localFocus ? scopes.find((scope) => scope.active.some((rule) => rule.id === localFocus))?.roleId : null;
  const roles = [...new Set([...scopes.filter(scope => scope.kind === "role" || scope.kind === "swarm").map((scope) => scope.roleId!), ...(roleScopes.length ? [] : ["builder"])])];
  const role = chosenRole ?? (focusRole && scopes.some((scope) => scope.roleId === focusRole) ? focusRole : roles.includes("builder") ? "builder" : roles[0]!);
  const roleScope = roleScopes.find((scope) => scope.roleId === role && !scope.scope.startsWith("role:*:")) ?? null;
  const everyRoleScope = roleScopes.find(scope => scope.roleId === role && scope.scope.startsWith("role:*:")) ?? null;
  const swarm = scopes.find(scope => scope.kind === "swarm" && scope.roleId === role) ?? null;
  const projectScope = scopes.find((scope) => scope.kind === "project") ?? null;
  const machineScope = scopes.find((scope) => scope.kind === "machine") ?? null;
  const roleName = roleNameById(t, role);
  const remove = async (rule: RuleView) => {
    const from = scopes.find((scope) => scope.active.some((candidate) => candidate.id === rule.id));
    if (!from) return;
    const removed = { rule, scope: from.scope, at: from.active.length - 1 - from.active.findIndex((candidate) => candidate.id === rule.id) };
    setUndo(removed);
    if (!await act("delete", rule.id)) setUndo((held) => (held === removed ? null : held));
  };
  const restore = async (rule: RuleView) => {
    const held = undo;
    setUndo(null);
    if (!await act("restore", rule.id)) setUndo(held);
  };
  if (typeof document === "undefined") return null;
  const picker = roles.length > 1 ? (
    <div role="tablist" aria-label={t("roleMemory.roleSection")} className="flex gap-1 overflow-x-auto pt-0.5">
      {roles.map((id) => {
        const count = scopes.filter(scope => (scope.kind === "role" || scope.kind === "swarm") && scope.roleId === id).reduce((sum, scope) => sum + scope.active.length, 0);
        const selected = id === role;
        return (
          <button key={id} type="button" role="tab" aria-selected={selected} data-rules-role={id} onClick={() => setChosenRole(id)}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11.5px] [@media(pointer:coarse)]:h-9 ${selected ? "border-accent bg-accent-soft font-semibold text-accent" : "border-border text-secondary hover:bg-sunken"}`}>
            <RoleAvatar role={roleAvatarKey(id)} size={16} />{roleNameById(t, id)}<span className="tabular-nums text-muted">{count}</span>
          </button>
        );
      })}
    </div>
  ) : null;
  /* On the desktop the window's top stays where the tallest window would start, on both pages, so a tab, a chip or a removal moves only its bottom edge. The rules page cap is the old 640 px plus the tab bar (49 px) that now sits above its columns. */
  return createPortal(
    <div className={`fixed inset-0 ${Z.overlay} flex items-stretch justify-center bg-black/40 md:items-start md:px-6 md:pb-6 md:pt-[max(1.5rem,calc((100dvh_-_min(820px,90dvh))/2))]`} onClick={onClose}>
      <section data-rules-window="" role="dialog" aria-modal="true" aria-labelledby="rules-window-title"
        className={`flex h-full w-full flex-col overflow-hidden bg-canvas text-primary shadow-xl md:h-auto md:max-w-[1120px] md:rounded-xl md:border md:border-border ${page === "profile" ? "md:max-h-[min(820px,90dvh)]" : "md:max-h-[min(689px,90dvh)]"}`}
        onClick={(event) => event.stopPropagation()}>
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <SparkGlyph />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id="rules-window-title" className="m-0 truncate text-[15px] font-semibold">{t(page === "profile" ? "memoryProfile.title" : "roleMemory.window.title", { project: view?.project ?? project })}</h2>
            <p data-rules-starts="" className="m-0 truncate text-[11.5px] leading-4 text-muted">{t(page === "profile" ? "memoryProfile.subtitle" : scopes.some(scope => scope.kind === "swarm") ? "roleMemory.startsWithSwarm" : "roleMemory.startsWith")}</p>
          </div>
          <button type="button" data-rules-window-close="" autoFocus aria-label={t("roleMemory.window.close")} onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-[20px] text-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">×</button>
        </header>
        {!view && failed !== "read" ? <p role="status" data-rules-window-loading="" className="m-4 text-[13px] text-muted">{t("roleMemory.reading")}</p> : null}
        {failed === "read" && !view ? <p role="alert" className="m-4 text-[13px] text-danger">{t("roleMemory.loadFailed")}</p> : null}
        {failed === "save" ? <p role="alert" className="m-0 border-b border-border px-4 py-1.5 text-[12px] text-danger">{t("roleMemory.saveFailed")}</p> : null}
        {view && !view.enabled ? <p data-rules-window-off="" className="m-0 border-b border-border bg-warning-soft px-4 py-1.5 text-[12px] text-primary">{t("roleMemory.off")}</p> : null}
        {view?.curation ? <details data-curation-history="" className="shrink-0 border-b border-border px-4 py-1.5 text-[11.5px] leading-4 text-secondary">
          <summary className="cursor-pointer"><RoleMark role="curator" />{t("roleMemory.curator")} · {t("roleMemory.lastRun", { at: view.curation.lastAt ? new Date(view.curation.lastAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-US") : t("roleMemory.never") })} · {view.enabled ? t("roleMemory.nextRun", { at: view.curation.nextAt ? new Date(view.curation.nextAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-US") : t("roleMemory.noActive") }) : t("roleMemory.off")}</summary>
          <ol className="m-0 max-h-32 list-none overflow-y-auto p-0">{view.curation.passes.map(pass => <li key={pass.id} data-curation-pass={pass.id} className="border-t border-border py-1">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="min-w-0"><RoleMark role="curator" />{t("roleMemory.curator")} · {new Date(pass.claimedAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-US")} · {t(`roleMemory.pass.${pass.state}`)}{pass.failure ? ` · ${failures[pass.failure] ?? pass.failure}` : ""} · {t("roleMemory.pass.counts", pass.counts)}</span>
              {pass.state === "succeeded" || pass.state === "failed" ? <button type="button" disabled={!!pass.revertedAt} data-curation-undo={pass.id} onClick={() => void act("revert-pass", pass.id)} className="min-h-9 pr-2 font-semibold text-accent disabled:text-muted">{t(pass.revertedAt ? "roleMemory.pass.undone" : "roleMemory.pass.undo")}</button> : null}
            </div>
            {pass.skipped?.length ? <p data-curation-skipped="" className="m-0 text-muted">{t("roleMemory.pass.skipped", { count: pass.skipped.length })}</p> : null}
          </li>)}</ol>
        </details> : null}
        {drilled && page === "profile" ? null : <nav className="flex shrink-0 gap-2 border-b border-border px-3 py-2" aria-label={t("memoryProfile.navigation")}>
          {(["profile", "rules"] as const).map(id => <button key={id} type="button" aria-pressed={page === id} onClick={() => setPage(id)} className={`min-h-8 rounded-full px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11 ${page === id ? "bg-accent-soft text-accent" : "text-secondary hover:bg-sunken"}`}>{t(id === "profile" ? "memoryProfile.profile" : "memoryProfile.allRules")}</button>)}
        </nav>}
        {view && page === "profile" ? <MemoryProfile key={`${view.project}/${locale}`} rules={view} onDrill={setDrilled} renderRules={(scope, ids, heading) => <RuleSection kind={scope.kind} title={ids ? heading?.title ?? t("memoryProfile.topicRules") : scope.kind === "swarm" ? <><RoleMark role={scope.roleId} />{t("roleMemory.swarm", { role: roleNameById(t, scope.roleId ?? "") })}</> : scope.kind === "role" ? <><RoleMark role={scope.roleId} />{roleNameById(t, scope.roleId ?? "")}</> : t(scope.kind === "project" ? "roleMemory.projectSection" : "roleMemory.machineSection")} subtitle={ids ? heading?.subtitle : undefined} scope={ids ? { ...scope, active: scope.active.filter(rule => ids.includes(rule.id)), left: [] } : scope} focusRule={localFocus} allRules={scopes.flatMap(s => s.active)} onFocus={id => { setLocalFocus(id); setChosenRole(null); setPage("rules"); }} removed={undo} onDelete={remove} onRestore={restore} onRevert={id => void act("revert", id)} />} /> : null}
        {view && page === "rules" ? (
          <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 content-start gap-3 overflow-y-auto p-3 md:auto-rows-auto md:grid-cols-3 md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
            <RuleSection kind="role" title={t("roleMemory.roleSection")} subtitle={picker ? t("roleMemory.roleSubtitle.chosen") : <><RoleMark role={role} />{t("roleMemory.roleSubtitle", { role: roleName })}</>} scope={roleScope} additionalScope={everyRoleScope} swarm={swarm} picker={picker} focusRule={localFocus} allRules={scopes.flatMap(s => s.active)} onFocus={id => { setLocalFocus(id); setChosenRole(null); }} removed={undo} onDelete={remove} onRestore={restore} onRevert={id => void act("revert", id)} />
            <RuleSection kind="project" title={t("roleMemory.projectSection")} subtitle={t("roleMemory.projectSubtitle")} scope={projectScope} focusRule={localFocus} allRules={scopes.flatMap(s => s.active)} onFocus={id => { setLocalFocus(id); setChosenRole(null); }} removed={undo} onDelete={remove} onRestore={restore} onRevert={id => void act("revert", id)} />
            <RuleSection kind="machine" title={t("roleMemory.machineSection")} subtitle={t("roleMemory.machineSubtitle")} scope={machineScope} focusRule={localFocus} allRules={scopes.flatMap(s => s.active)} onFocus={id => { setLocalFocus(id); setChosenRole(null); }} removed={undo} onDelete={remove} onRestore={restore} onRevert={id => void act("revert", id)} />
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

/* ---- the way in ---- */

/** One row that opens the window: on the board's ⋯, drawn like the rows beside it, and among the phone's project rules, drawn like the switches there. No switch: memory is always on. */
export function LearnedRulesRow({ project, size, onOpened }: { project: string | null; size: "menu" | "sheet"; onOpened?: () => void }) {
  const { t } = useLocale();
  const { view } = useProjectRules(project);
  if (!project) return null;
  /* Every rule of the project, whatever its kind or role: the window's chips and headings add up to it. */
  const total = view?.scopes.reduce((sum, scope) => sum + scope.active.length, 0) ?? 0;
  const count = t("roleMemory.total", { count: total });
  const open = () => { openRulesWindow(project); onOpened?.(); };
  if (size === "sheet") {
    return (
      <button type="button" data-learned-rules-open="" onClick={open}
        className="flex w-full flex-col gap-0.5 px-4 py-1 text-left active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className="flex min-h-11 w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{t("roleMemory.row")}</span>
          <ChevronRight className="h-[15px] w-[15px] shrink-0 text-muted" aria-hidden />
        </span>
        <span data-learned-rules-count="" className="text-[11px] leading-snug text-muted">{count}</span>
      </button>
    );
  }
  return (
    <button type="button" data-learned-rules-open="" onClick={open} className={BAR_MENU_ROW}>
      <SparkGlyph size={15} />
      <span className="min-w-0 flex-1 truncate">{t("roleMemory.row")}</span>
      <span data-learned-rules-count="" className="shrink-0 text-[11px] font-normal tabular-nums text-muted">{count}</span>
      <ChevronRight className="h-[15px] w-[15px] shrink-0 text-muted" aria-hidden />
    </button>
  );
}
