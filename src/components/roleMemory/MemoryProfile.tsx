"use client";

import { useState, type ReactNode } from "react";
import { modelDisplayName } from "@/lib/agent/models";
import { roleNameById } from "@/components/builderCopy";
import { useLocale } from "@/lib/i18n";
import { isCrossProjectRoleScope } from "@/lib/memory/roleScopes";
import type { RoleMemoryProjectView, ScopeView } from "@/lib/memory/roleTypes";
import type { ProfilePartView } from "@/lib/memory/profileTypes";
import { useMemoryProfile } from "./useMemoryProfile";

const BUTTON = "min-h-8 rounded-lg px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11";
const TONE = { role: "border-t-accent", project: "border-t-info", machine: "border-t-warning" };

export function MemoryProfile({ rules, renderRules }: { rules: RoleMemoryProjectView; renderRules: (scope: ScopeView, ids?: string[]) => ReactNode }) {
  const { t, locale } = useLocale();
  const { view, error, running, summarize } = useMemoryProfile(rules.project, locale, rules);
  const [selection, setSelection] = useState<{ scopes: ScopeView[]; ids?: string[] } | null>(null);
  const label = (scope: ScopeView) => scope.kind === "role"
    ? `${roleNameById(t, scope.roleId ?? "")} · ${t(isCrossProjectRoleScope(scope.scope) ? "memoryProfile.everyProject" : "memoryProfile.thisProject")}`
    : t(scope.kind === "project" ? "roleMemory.projectSection" : "roleMemory.machineSection");
  const openRules = (ids: string[]) => {
    const scopes = rules.scopes.filter(scope => scope.active.some(rule => ids.includes(rule.id)));
    if (!scopes.length) return;
    setSelection({ scopes, ids });
  };
  const topics = (part: ProfilePartView, overall = false) => overall ? (
    <div className="mt-4">
      <h4 className="m-0 text-[12px] font-semibold text-secondary">{t("memoryProfile.encountered")}</h4>
      <div className="mt-2 grid items-start gap-2 md:grid-cols-3">
        {part.answer.topics.map((topic, index) => <button key={index} type="button" disabled={!topic.ruleIds.length} onClick={() => openRules(topic.ruleIds)} className="min-w-0 rounded-lg border border-border bg-canvas p-3 text-left hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <span className="block text-[12.5px] font-semibold">{topic.title}</span>
          <span className="mt-1 block text-[12px] leading-[18px] text-secondary">{topic.text}</span>
          <span className="mt-2 block text-[11px] text-accent">{t("memoryProfile.rules", { count: topic.ruleIds.length })} →</span>
        </button>)}
      </div>
    </div>
  ) : <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">{part.answer.topics.map((topic, index) => <button key={index} title={topic.title} type="button" disabled={!topic.ruleIds.length} onClick={() => openRules(topic.ruleIds)} className="max-w-[min(100%,240px)] truncate rounded-full border border-border bg-canvas px-2.5 py-1 text-[11px] text-secondary hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11">{topic.title}</button>)}</div>;
  if (selection) {
    return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div><button type="button" onClick={() => setSelection(null)} className={`${BUTTON} text-accent hover:bg-sunken`}>← {t("memoryProfile.back")}</button></div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto">{selection.scopes.map(scope => {
        const current = rules.scopes.find(candidate => candidate.scope === scope.scope) ?? { ...scope, active: [], left: [] };
        return <div key={scope.scope}>{renderRules(current, selection.ids)}</div>;
      })}</div>
    </div>;
  }
  const count = rules.scopes.reduce((n, scope) => n + scope.active.length, 0);
  const hasParts = !!view?.overall || !!view?.slices.some(slice => slice.summary);
  const code = count ? error ?? view?.run?.errors[0]?.code : null;
  const overall = count ? view?.overall : null;
  return <div data-memory-profile="" className="min-h-0 flex-1 overflow-y-auto p-3" aria-busy={running}>
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[16px] font-semibold">{overall?.answer.headline ?? t(count ? "memoryProfile.noneTitle" : "memoryProfile.emptyTitle")}</h3>
          <p className="mb-0 mt-2 text-[13px] leading-5 text-secondary">{overall?.answer.text ?? t(count ? "memoryProfile.noneText" : "memoryProfile.emptyText")}</p>
        </div>
        {count > 0 && rules.enabled ? <button data-profile-summarize="" type="button" disabled={running} onClick={() => void summarize()} className={`${BUTTON} shrink-0 bg-accent text-white disabled:opacity-60`}>
          {t(running ? "memoryProfile.summarizing" : code ? "memoryProfile.retry" : hasParts ? "memoryProfile.refresh" : "memoryProfile.summarize")}
        </button> : null}
      </div>
      {running ? <p role="status" className="mb-0 mt-3 text-[12px] text-muted">{t("memoryProfile.loading")}</p> : null}
      {code ? <p role="alert" className="mb-0 mt-3 text-[12px] text-danger">{t(code === "account" ? "memoryProfile.errorAccount" : code === "size" ? "memoryProfile.errorSize" : "memoryProfile.error")}</p> : null}
      {count > 0 && view?.stale ? <p data-profile-stale="" className="mb-0 mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning">{t("memoryProfile.stale", view.changes)}</p> : null}
      {overall && view ? <>
        <p className="mb-0 mt-3 text-[11px] text-muted">{modelDisplayName("claude", view.model)} · {new Date(overall.createdAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-US")} · {t(locale === "uk" ? "memoryProfile.uk" : "memoryProfile.en")}{view.run?.durationMs !== undefined ? ` · ${(view.run.durationMs / 1000).toFixed(1)} s` : ""}</p>
        {topics(overall, true)}
      </> : null}
    </section>
    {count ? <>
      <h3 className="mb-2 mt-4 text-[12px] font-semibold text-secondary">{t("memoryProfile.byLevel")}</h3>
      <div className="grid items-start gap-3 md:grid-cols-2">
        {rules.scopes.filter(scope => scope.active.length).map(scope => {
          const summary = view?.slices.find(slice => slice.scope === scope.scope)?.summary;
          return <section key={scope.scope} data-profile-slice={scope.kind} data-profile-ready={summary ? "" : undefined} className={`min-w-0 rounded-xl border border-border border-t-[3px] bg-card p-3 ${TONE[scope.kind]}`}>
            <p className="m-0 text-[11px] font-semibold text-muted">{label(scope)}</p>
            <h4 className="mb-0 mt-2 text-[14px] font-semibold">{summary?.answer.headline ?? label(scope)}</h4>
            {summary ? <><p className="mb-0 mt-1 text-[12.5px] leading-[19px] text-secondary">{summary.answer.text}</p>{topics(summary)}</> : <p className="mb-0 mt-2 text-[12px] text-muted">{t(running ? "memoryProfile.summarizing" : "memoryProfile.sliceEmpty")}</p>}
            <button type="button" onClick={() => setSelection({ scopes: [scope] })} className={`${BUTTON} mt-3 border border-border text-accent hover:bg-sunken`}>{t("memoryProfile.rules", { count: scope.active.length })} →</button>
          </section>;
        })}
      </div>
    </> : null}
  </div>;
}
