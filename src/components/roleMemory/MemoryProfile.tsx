"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { modelDisplayName } from "@/lib/agent/models";
import { roleNameById } from "@/components/builderCopy";
import { useLocale, type TFunction } from "@/lib/i18n";
import { isCrossProjectRoleScope } from "@/lib/memory/roleScopes";
import type { RoleMemoryProjectView, ScopeKind } from "@/lib/memory/roleTypes";
import type { MemoryProfileView, ProfilePartView } from "@/lib/memory/profileTypes";
import { RoleMark } from "./RoleMark";
import type { useMemoryProfile } from "./useMemoryProfile";

const BUTTON = "min-h-8 rounded-lg px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:min-h-11";
const SOLID = "bg-accent text-white disabled:opacity-60";
const OUTLINE = "border border-border text-accent hover:bg-sunken disabled:opacity-60";

/** The last 28 px of a scroller fade out over 28 px of padding, so the last row is whole at the end and a row cut by the edge reads as continuing. The same 28 px is the scroller's bottom scroll padding, so a row brought into view lands above the fade. */
export const SCROLL_FADE = "pb-7 scroll-pb-7 [-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)] [mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)]";

/** The profile hook's answer, as the window hands it to the left column. */
export type ProfileState = ReturnType<typeof useMemoryProfile>;

/** One row of the level list: a scope that holds rules, or the project or machine, which are always there. */
export type ProfileLevel = { scope: string; kind: ScopeKind; roleId: string | null; count: number; left: number; summary: ProfilePartView | null };

/** What the right pane shows: one level's rules, or the rules behind one topic (of the overall summary, by `index`, or of a level's summary, by `scope`). */
export type Selection =
  | { kind: "level"; scope: string }
  | { kind: "topic"; title: string; text?: string; ids: string[]; scope?: string; index?: number };

/** Grey bars that stand where a running summary will land. */
function Placeholder({ lines, className = "mt-3" }: { lines: number; className?: string }) {
  return <div aria-hidden className={`${className} grid gap-2`}>{Array.from({ length: lines }, (_, index) => <span key={index} className={`block h-2.5 rounded bg-sunken motion-safe:animate-pulse ${index === lines - 1 ? "w-2/3" : "w-full"}`} />)}</div>;
}

/** Today's summaries read "today 14:02", older ones the short date and the time. */
function stamp(createdAt: string, locale: string, today: string): string {
  const at = new Date(createdAt), tag = locale === "uk" ? "uk-UA" : "en-US", now = new Date();
  const time = at.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return at.toDateString() === now.toDateString() ? `${today} ${time}` : `${at.toLocaleDateString(tag, { day: "numeric", month: "short" })}, ${time}`;
}

/** The role's costume and name with its reach, or the name of the project or machine kind. */
export function levelLabel(t: TFunction, level: { scope: string; kind: ScopeKind; roleId: string | null }): ReactNode {
  if (level.kind === "role") return <><RoleMark role={level.roleId} />{roleNameById(t, level.roleId ?? "")} · {t(isCrossProjectRoleScope(level.scope) ? "memoryProfile.everyProject" : "memoryProfile.thisProject")}</>;
  if (level.kind === "swarm") return <><RoleMark role={level.roleId} />{t("roleMemory.swarm", { role: roleNameById(t, level.roleId ?? "") })}</>;
  return t(level.kind === "project" ? "roleMemory.projectSection" : "roleMemory.machineSection");
}

/**
 * The window's level list, in order. A role scope is listed while it holds an
 * active or a departed rule (its departed rules keep their way back), a swarm
 * scope while it holds an active rule, and the project and the machine always:
 * a new agent starts with them, and their row is where an empty one says so.
 * Before the rules arrive the saved profile's own slices stand in, with no
 * departed rules known.
 */
export function profileLevels(rules: RoleMemoryProjectView | null, profile: MemoryProfileView | null): ProfileLevel[] {
  const summaryOf = (scope: string) => profile?.slices.find(slice => slice.scope === scope)?.summary ?? null;
  const levels: ProfileLevel[] = rules
    ? rules.scopes
      .filter(scope => scope.kind === "project" || scope.kind === "machine" || scope.active.length > 0 || (scope.kind === "role" && scope.left.length > 0))
      .map(scope => ({ scope: scope.scope, kind: scope.kind, roleId: scope.roleId, count: scope.active.length, left: scope.left.length, summary: summaryOf(scope.scope) }))
    : (profile?.slices ?? [])
      .filter(slice => slice.count > 0 || slice.kind === "project" || slice.kind === "machine")
      .map(slice => ({ scope: slice.scope, kind: slice.kind, roleId: slice.roleId, count: slice.count, left: 0, summary: slice.summary }));
  /* Each role's own project first, then its every-project rules, then the swarm's, project and machine. */
  const kinds = { role: 0, swarm: 1, project: 2, machine: 3 };
  const first = (level: ProfileLevel) => levels.findIndex(candidate => candidate.kind === level.kind && candidate.roleId === level.roleId);
  const cross = (level: ProfileLevel) => level.kind === "role" && isCrossProjectRoleScope(level.scope) ? 1 : 0;
  return levels.map((level, index) => ({ level, index }))
    .sort((a, b) => kinds[a.level.kind] - kinds[b.level.kind] || first(a.level) - first(b.level) || cross(a.level) - cross(b.level) || a.index - b.index)
    .map(item => item.level);
}

/** A level's topics as small pills; one opens the rules behind it within the level. */
export function SliceTopics({ part, disabled, onPick }: { part: ProfilePartView; disabled: boolean; onPick: (topic: ProfilePartView["answer"]["topics"][number]) => void }) {
  if (!part.answer.topics.length) return null;
  return <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">{part.answer.topics.map((topic, index) => <button key={index} data-profile-pill="" title={topic.title} type="button" disabled={disabled || !topic.ruleIds.length} onClick={() => onPick(topic)} className="relative flex max-w-[min(100%,240px)] rounded-full border border-border bg-canvas px-2.5 py-1 text-[11px] text-secondary hover:bg-sunken disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-[11px] [@media(pointer:coarse)]:before:inset-x-0 [@media(pointer:coarse)]:before:content-['']"><span className="truncate">{topic.title}</span></button>)}</div>;
}

const ROW = "flex w-full min-w-0 gap-2 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 [@media(pointer:coarse)]:min-h-11";

/** The window's left column: the profile's summary, the levels and what the agents ran into. One scroller. */
export function MemoryProfile({ rules, profile, levels, selected, mobile, onSelect }: {
  rules: RoleMemoryProjectView | null;
  profile: ProfileState;
  levels: ProfileLevel[];
  /** The row to draw as chosen: none on a phone, where a row opens a screen instead. */
  selected: Selection | null;
  mobile: boolean;
  onSelect: (selection: Selection) => void;
}) {
  const { t, locale } = useLocale();
  const { view, error, loaded, running, summarize } = profile;
  /* The saved profile can be shown while its full rule records are still loading.
     Actions that need those records remain unavailable until they arrive. */
  const countKnown = rules !== null || view !== null;
  const count = rules ? rules.scopes.reduce((n, scope) => n + scope.active.length, 0) : view?.ruleCount ?? 0;
  const hasParts = !!view?.overall || !!view?.slices.some(slice => slice.summary);
  const code = countKnown && !count ? null : error ?? view?.run?.errors[0]?.code;
  const overall = count ? view?.overall : null;
  /* Until the first answer the summary says it is reading; "no summary yet" and the paid Summarize press would be a guess. */
  const reading = !loaded && (!countKnown || count > 0);
  const pending = count > 0 && running && !overall;
  const quiet = !!overall && !code && !view?.stale && !running;
  /* A chosen row comes into view above the fade; a click leaves a row under it where it was, since a click scrolls nothing. */
  const root = useRef<HTMLDivElement>(null);
  const chosen = !selected ? "" : selected.kind === "level" ? `level:${selected.scope}` : `topic:${selected.scope ?? ""}:${selected.index ?? ""}`;
  useEffect(() => { if (!mobile && chosen) root.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView({ block: "nearest" }); }, [chosen, mobile, levels.length]);
  const row = mobile ? ROW.replace("py-1.5", "py-3") : ROW;
  const chevron = mobile ? <ChevronRight className="h-4 w-4 shrink-0 self-center text-muted" aria-hidden /> : null;
  return <div ref={root} data-memory-profile="" aria-busy={running || reading} className={`flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pt-3 ${SCROLL_FADE} ${mobile ? "min-w-0 flex-1" : "w-[300px] shrink-0 border-r border-border md:w-[380px]"}`}>
    <section data-profile-ready={overall ? "" : undefined} className="min-w-0">
      <div className="flex items-start gap-3">
        <h3 role={reading ? "status" : undefined} className="m-0 min-w-0 flex-1 text-[15px] font-semibold [overflow-wrap:anywhere]">{overall?.answer.headline ?? t(reading ? "memoryProfile.reading" : !countKnown ? "memoryProfile.profile" : !count ? "memoryProfile.emptyTitle" : pending ? "memoryProfile.runningTitle" : "memoryProfile.noneTitle")}</h3>
        {count > 0 && rules?.enabled && !reading ? <button data-profile-summarize="" type="button" disabled={running} onClick={() => void summarize()} className={`${BUTTON} shrink-0 ${quiet ? OUTLINE : SOLID}`}>
          {t(running ? "memoryProfile.summarizing" : code ? "memoryProfile.retry" : hasParts ? "memoryProfile.refresh" : "memoryProfile.summarize")}
        </button> : null}
      </div>
      {reading ? <Placeholder lines={3} /> : pending ? <><p className="mb-0 mt-1.5 text-[13px] leading-5 text-secondary [overflow-wrap:anywhere]">{t("memoryProfile.runningText")}</p><Placeholder lines={3} /></> : countKnown ? <p className="mb-0 mt-1.5 text-[13px] leading-5 text-secondary [overflow-wrap:anywhere]">{overall?.answer.text ?? t(count ? "memoryProfile.noneText" : "memoryProfile.emptyText")}</p> : null}
      {overall && view ? <p className="mb-0 mt-1.5 text-[11px] text-muted [overflow-wrap:anywhere]">{modelDisplayName("claude", overall.model)} · {stamp(overall.createdAt, locale, t("memoryProfile.today"))} · {t(locale === "uk" ? "memoryProfile.uk" : "memoryProfile.en")}</p> : null}
      {running ? <p role="status" className="mb-0 mt-3 text-[12px] text-muted">{t("memoryProfile.loading")}</p> : null}
      {code ? <p role="alert" className="mb-0 mt-3 text-[12px] text-danger">{t(code === "account" ? "memoryProfile.errorAccount" : code === "size" ? "memoryProfile.errorSize" : "memoryProfile.error")}</p> : null}
      {count > 0 && view?.stale ? <p data-profile-stale="" className="mb-0 mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning">{t("memoryProfile.stale", view.changes)}</p> : null}
    </section>
    {levels.length ? <section>
      <h3 className="m-0 mb-1 text-[12px] font-semibold text-secondary">{t("memoryProfile.byLevel")}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {levels.map(level => {
          /* A level's own topic keeps its level chosen. */
          const current = !!selected && selected.scope === level.scope && (selected.kind === "level" || selected.index === undefined);
          /* A summary-less row on the phone reaches the 44 px target through its own padding, so every row there has that padding and the room between rows is one. */
          const plain = !level.summary && !running && !reading && mobile;
          return <li key={level.scope}>
            <button type="button" data-profile-level={level.scope} data-profile-ready={level.summary ? "" : undefined} disabled={!rules} aria-current={current ? "true" : undefined} onClick={() => onSelect({ kind: "level", scope: level.scope })} className={`${row} ${plain ? "items-center" : "items-start"} ${current ? "bg-accent-soft" : "enabled:hover:bg-sunken"}`}>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12.5px] font-semibold [overflow-wrap:anywhere] ${current ? "text-accent" : "text-primary"}`}>{levelLabel(t, level)}</span>
                {level.summary ? <span className="block text-[11.5px] leading-4 text-muted [overflow-wrap:anywhere]">{level.summary.answer.headline}</span> : running || reading ? <Placeholder lines={1} className="mt-1.5" /> : null}
              </span>
              <span className={`shrink-0 text-[11.5px] tabular-nums text-muted ${plain ? "" : "pt-0.5"}`}>{level.count}</span>
              {mobile ? <ChevronRight className={`${plain ? "" : "mt-px "}h-4 w-4 shrink-0 text-muted`} aria-hidden /> : null}
            </button>
          </li>;
        })}
      </ul>
    </section> : null}
    {overall?.answer.topics.length ? <section>
      <h3 className="m-0 mb-1 text-[12px] font-semibold text-secondary">{t("memoryProfile.encountered")}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {overall.answer.topics.map((topic, index) => {
          const current = selected?.kind === "topic" && selected.index === index;
          return <li key={index}>
            <button type="button" data-profile-topic={index} disabled={!rules || !topic.ruleIds.length} aria-current={current ? "true" : undefined} onClick={() => onSelect({ kind: "topic", title: topic.title, text: topic.text, ids: topic.ruleIds, index })} className={`${row} items-baseline ${current ? "bg-accent-soft" : "enabled:hover:bg-sunken"}`}>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12.5px] font-semibold [overflow-wrap:anywhere] ${current ? "text-accent" : "text-primary"}`}>{topic.title}</span>
                {topic.text ? <span className="block text-[11.5px] leading-4 text-muted [overflow-wrap:anywhere]">{topic.text}</span> : null}
              </span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-muted">{topic.ruleIds.length}</span>
              {chevron}
            </button>
          </li>;
        })}
      </ul>
    </section> : null}
  </div>;
}
