"use client";

import { useEffect, useState, type ReactNode } from "react";
import { modelDisplayName } from "@/lib/agent/models";
import { roleNameById } from "@/components/builderCopy";
import { useLocale } from "@/lib/i18n";
import { isCrossProjectRoleScope } from "@/lib/memory/roleScopes";
import type { RoleMemoryProjectView, ScopeView } from "@/lib/memory/roleTypes";
import type { ProfilePartView } from "@/lib/memory/profileTypes";
import { useMemoryProfile } from "./useMemoryProfile";

const BUTTON = "min-h-8 rounded-lg px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11";
const TONE = { role: "border-t-accent", swarm: "border-t-info", project: "border-t-info", machine: "border-t-warning" };

const SOLID = "bg-accent text-white disabled:opacity-60";
const OUTLINE = "border border-border text-accent hover:bg-sunken disabled:opacity-60";

/* Grey bars that stand where a running summary will land. */
function Placeholder({ lines }: { lines: number }) {
  return <div aria-hidden className="mt-3 grid gap-2">{Array.from({ length: lines }, (_, index) => <span key={index} className={`block h-2.5 rounded bg-sunken motion-safe:animate-pulse ${index === lines - 1 ? "w-2/3" : "w-full"}`} />)}</div>;
}

/** Today's summaries read "today 14:02", older ones the short date and the time. */
function stamp(createdAt: string, locale: string, today: string): string {
  const at = new Date(createdAt), tag = locale === "uk" ? "uk-UA" : "en-US", now = new Date();
  const time = at.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return at.toDateString() === now.toDateString() ? `${today} ${time}` : `${at.toLocaleDateString(tag, { day: "numeric", month: "short" })}, ${time}`;
}

export function MemoryProfile({ rules, renderRules, onDrill }: { rules: RoleMemoryProjectView; renderRules: (scope: ScopeView, ids?: string[], heading?: { title: string; subtitle: string }) => ReactNode; onDrill?: (open: boolean) => void }) {
  const { t, locale } = useLocale();
  const { view, error, running, summarize } = useMemoryProfile(rules.project, locale, rules);
  const [selection, setSelection] = useState<{ scopes: ScopeView[]; ids?: string[]; topic?: string } | null>(null);
  const label = (scope: ScopeView) => scope.kind === "role"
    ? `${roleNameById(t, scope.roleId ?? "")} · ${t(isCrossProjectRoleScope(scope.scope) ? "memoryProfile.everyProject" : "memoryProfile.thisProject")}`
    : scope.kind === "swarm" ? t("roleMemory.swarm", { role: roleNameById(t, scope.roleId ?? "") }) : t(scope.kind === "project" ? "roleMemory.projectSection" : "roleMemory.machineSection");
  const drilled = selection !== null;
  useEffect(() => {
    onDrill?.(drilled);
    return () => onDrill?.(false);
  }, [drilled, onDrill]);
  /* The level cards follow the All rules page: each role's own project first, then its every-project rules, then project and machine. */
  const ordered = (() => {
    const kinds = { role: 0, swarm: 1, project: 2, machine: 3 };
    const first = (scope: ScopeView) => rules.scopes.findIndex(candidate => candidate.kind === scope.kind && candidate.roleId === scope.roleId);
    const cross = (scope: ScopeView) => scope.kind === "role" && isCrossProjectRoleScope(scope.scope) ? 1 : 0;
    return rules.scopes.map((scope, index) => ({ scope, index })).sort((a, b) => kinds[a.scope.kind] - kinds[b.scope.kind] || first(a.scope) - first(b.scope) || cross(a.scope) - cross(b.scope) || a.index - b.index).map(item => item.scope);
  })();
  const openRules = (ids: string[], topic?: string) => {
    const scopes = rules.scopes.filter(scope => scope.active.some(rule => ids.includes(rule.id)));
    if (!scopes.length) return;
    setSelection({ scopes, ids, topic });
  };
  const topics = (part: ProfilePartView, overall = false) => overall ? (
    <div className="mt-4">
      <h4 className="m-0 text-[12px] font-semibold text-secondary">{t("memoryProfile.encountered")}</h4>
      <div className="mt-2 grid items-start gap-2 md:grid-cols-3">
        {part.answer.topics.map((topic, index) => <button key={index} type="button" disabled={!topic.ruleIds.length} onClick={() => openRules(topic.ruleIds, topic.title)} className="min-w-0 rounded-lg border border-border bg-canvas p-3 text-left hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <span className="block text-[12.5px] font-semibold [overflow-wrap:anywhere]">{topic.title}</span>
          <span className="mt-1 block text-[12px] leading-[18px] text-secondary [overflow-wrap:anywhere]">{topic.text}</span>
          <span className="mt-2 block text-[11px] text-accent">{t("memoryProfile.rules", { count: topic.ruleIds.length })} →</span>
        </button>)}
      </div>
    </div>
  ) : <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">{part.answer.topics.map((topic, index) => <button key={index} data-profile-pill="" title={topic.title} type="button" disabled={!topic.ruleIds.length} onClick={() => openRules(topic.ruleIds, topic.title)} className="relative flex max-w-[min(100%,240px)] rounded-full border border-border bg-canvas px-2.5 py-1 text-[11px] text-secondary hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-[11px] [@media(pointer:coarse)]:before:inset-x-0 [@media(pointer:coarse)]:before:content-['']"><span className="truncate">{topic.title}</span></button>)}</div>;
  if (selection) {
    return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div><button type="button" onClick={() => setSelection(null)} className={`${BUTTON} text-accent hover:bg-sunken`}>← {t("memoryProfile.back")}</button></div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto">{selection.scopes.map(scope => {
        const current = rules.scopes.find(candidate => candidate.scope === scope.scope) ?? { ...scope, active: [], left: [] };
        return <div key={scope.scope}>{renderRules(current, selection.ids, selection.topic ? { title: selection.topic, subtitle: label(scope) } : undefined)}</div>;
      })}</div>
    </div>;
  }
  const count = rules.scopes.reduce((n, scope) => n + scope.active.length, 0);
  const hasParts = !!view?.overall || !!view?.slices.some(slice => slice.summary);
  const code = count ? error ?? view?.run?.errors[0]?.code : null;
  const overall = count ? view?.overall : null;
  const pending = count > 0 && running && !overall;
  const quiet = !!overall && !code && !view?.stale && !running;
  return <div data-memory-profile="" className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={running}>
    <section data-profile-ready={overall ? "" : undefined} className="rounded-xl border border-border bg-card p-4">
      {count > 0 && rules.enabled || overall ? <div className="mb-2 flex items-center justify-between gap-3">
        {overall && view ? <p className="m-0 min-w-0 text-[11px] text-muted [overflow-wrap:anywhere]">{modelDisplayName("claude", overall.model)} · {stamp(overall.createdAt, locale, t("memoryProfile.today"))} · {t(locale === "uk" ? "memoryProfile.uk" : "memoryProfile.en")}</p> : <span />}
        {count > 0 && rules.enabled ? <button data-profile-summarize="" type="button" disabled={running} onClick={() => void summarize()} className={`${BUTTON} shrink-0 ${quiet ? OUTLINE : SOLID}`}>
          {t(running ? "memoryProfile.summarizing" : code ? "memoryProfile.retry" : hasParts ? "memoryProfile.refresh" : "memoryProfile.summarize")}
        </button> : null}
      </div> : null}
      <h3 className="m-0 text-[16px] font-semibold [overflow-wrap:anywhere]">{overall?.answer.headline ?? t(!count ? "memoryProfile.emptyTitle" : pending ? "memoryProfile.runningTitle" : "memoryProfile.noneTitle")}</h3>
      {pending ? <><p className="mb-0 mt-2 text-[13px] leading-5 text-secondary [overflow-wrap:anywhere]">{t("memoryProfile.runningText")}</p><Placeholder lines={3} /></> : <p className="mb-0 mt-2 text-[13px] leading-5 text-secondary [overflow-wrap:anywhere]">{overall?.answer.text ?? t(count ? "memoryProfile.noneText" : "memoryProfile.emptyText")}</p>}
      {running ? <p role="status" className="mb-0 mt-3 text-[12px] text-muted">{t("memoryProfile.loading")}</p> : null}
      {code ? <p role="alert" className="mb-0 mt-3 text-[12px] text-danger">{t(code === "account" ? "memoryProfile.errorAccount" : code === "size" ? "memoryProfile.errorSize" : "memoryProfile.error")}</p> : null}
      {count > 0 && view?.stale ? <p data-profile-stale="" className="mb-0 mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning">{t("memoryProfile.stale", view.changes)}</p> : null}
      {overall ? topics(overall, true) : null}
    </section>
    {count ? <>
      <h3 className="mb-2 mt-4 text-[12px] font-semibold text-secondary">{t("memoryProfile.byLevel")}</h3>
      <div className="grid items-start gap-3 md:grid-cols-2">
        {ordered.filter(scope => scope.active.length).map(scope => {
          const summary = view?.slices.find(slice => slice.scope === scope.scope)?.summary;
          return <section key={scope.scope} data-profile-slice={scope.kind} data-profile-ready={summary ? "" : undefined} className={`min-w-0 rounded-xl border border-border border-t-[3px] bg-card p-3 ${TONE[scope.kind]}`}>
            {summary ? <>
              <p className="m-0 text-[11px] font-semibold text-muted">{label(scope)}</p>
              <h4 className="mb-0 mt-2 text-[14px] font-semibold [overflow-wrap:anywhere]">{summary.answer.headline}</h4>
              <p className="mb-0 mt-1 text-[12.5px] leading-[19px] text-secondary [overflow-wrap:anywhere]">{summary.answer.text}</p>{topics(summary)}
            </> : <>
              <h4 className="m-0 text-[14px] font-semibold [overflow-wrap:anywhere]">{label(scope)}</h4>
              {running ? <Placeholder lines={2} /> : <p className="mb-0 mt-2 text-[12px] text-muted">{t("memoryProfile.sliceEmpty")}</p>}
            </>}
            <button type="button" onClick={() => setSelection({ scopes: [scope] })} className={`${BUTTON} mt-3 border border-border text-accent hover:bg-sunken`}>{t("memoryProfile.rules", { count: scope.active.length })} →</button>
          </section>;
        })}
      </div>
    </> : null}
  </div>;
}
