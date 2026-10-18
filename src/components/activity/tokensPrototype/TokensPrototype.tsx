"use client";

import { ArrowLeft, Info } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { useLocale, type MessageKey } from "@/lib/i18n";

import { Segmented } from "../ActivityDashboard";
import { ActivityProjectPicker, ActivityScopeChip } from "../ActivityProjectPicker";
import { MarkPatterns } from "../marks";
import { protoT, type ProtoKey } from "./copy";
import {
  clampRange, dimensionOrder, PROJECTS, presetRange, rowsIn, tokensAnswer, totalOf,
  type ListDimension, type Preset, type TokenDimension,
} from "./fixture";
import { compact, entityName, MemberChooser, RangeControl, type Ctx, type RangeChoice } from "./parts";
import { Variant1, Variant2, Variant3, Variant4, type VariantProps } from "./variants";

/*
 * The prototype route of docs/design/activity-token-usage.md §9: four
 * numbered variants of token usage on the Activity page, drawn from invented
 * fixture data (./fixture.ts) so no store, endpoint or live state is read.
 * `?variant=N` picks one; `range`, `from`, `to`, `project`, `by`, `open`
 * set the state a frame is captured in. Removed once the operator has chosen.
 */

export type Variant = 1 | 2 | 3 | 4;

export interface PrototypeParams {
  variant: Variant;
  range: RangeChoice;
  from: string | null;
  to: string | null;
  project: string | null;
  by: TokenDimension;
  open: boolean;
}

const DESKTOP_QUERY = "(min-width: 1024px)";
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

const BY_KEYS: Record<TokenDimension, ProtoKey> = {
  kind: "by.kind", model: "by.model", role: "by.role", project: "by.project", member: "by.member", account: "by.account", engine: "by.model",
};

export function TokensPrototype({ initial }: { initial: PrototypeParams }) {
  const { t, locale } = useLocale();
  const pt = useMemo(() => protoT(locale), [locale]);
  const ctx: Ctx = useMemo(() => ({ t, pt, locale }), [t, pt, locale]);
  const desktop = useDesktop();
  const variant = initial.variant;

  const [choice, setChoice] = useState<RangeChoice>(initial.range);
  const [range, setRange] = useState(() => (initial.range === "custom" && initial.from && initial.to ? clampRange(initial.from, initial.to) : presetRange(initial.range === "custom" ? "7d" : initial.range)));
  const [open, setOpen] = useState(initial.open);
  const [project, setProject] = useState<string | null>(initial.project);
  const [filters, setFilters] = useState<Partial<Record<ListDimension, string>>>({});
  const [by, setBy] = useState<TokenDimension>(initial.by);

  const onPreset = useCallback((preset: Preset) => {
    setChoice(preset);
    setRange(presetRange(preset));
  }, []);
  const onRange = useCallback((from: string, to: string) => {
    setChoice("custom");
    setRange(clampRange(from, to));
  }, []);
  const toggleFilter = useCallback((dimension: ListDimension, key: string) => {
    if (dimension === "project") {
      setProject((current) => (current === key ? null : key || null));
      return;
    }
    setFilters((current) => {
      const next = { ...current };
      if (next[dimension] === key) delete next[dimension];
      else next[dimension] = key;
      return next;
    });
  }, []);

  const list: ListDimension = by === "kind" ? "model" : by;
  const answer = useMemo(() => tokensAnswer({ from: range.from, to: range.to, preset: choice === "custom" ? null : choice, project, stack: by, list, filters }), [range, choice, project, by, list, filters]);

  /* The picker's rows: every project of the range with its tokens. */
  const projectEntries = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of rowsIn(range.from, range.to, { project: null, filters })) totals.set(row.project ?? "", (totals.get(row.project ?? "") ?? 0) + totalOf(row.counts));
    return PROJECTS.filter((entry) => entry.key !== null && (totals.get(entry.key) ?? 0) > 0)
      .sort((a, b) => (totals.get(b.key!) ?? 0) - (totals.get(a.key!) ?? 0))
      .map((entry) => ({ project: entry.key!, label: entry.name, value: compact(totals.get(entry.key!) ?? 0, locale) }));
  }, [range, filters, locale]);
  const memberTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of rowsIn(range.from, range.to, { project, filters: { ...filters, member: undefined } })) totals.set(row.member, (totals.get(row.member) ?? 0) + totalOf(row.counts));
    return totals;
  }, [range, project, filters]);

  const chips = [
    ...(project !== null ? [{ key: "project", name: entityName("project", project, ctx), clear: () => setProject(null) }] : []),
    ...(Object.entries(filters) as Array<[ListDimension, string]>).map(([dimension, key]) => ({
      key: dimension,
      name: `${pt(BY_KEYS[dimension])}: ${entityName(dimension, key, ctx)}`,
      clear: () => toggleFilter(dimension, key),
    })),
  ];

  const props: VariantProps = {
    answer, ctx, desktop, by, onBy: setBy, filters, project, onFilter: toggleFilter,
    otherCount: Math.max(0, dimensionOrder(list).length - 12),
  };
  const tokensView = variant !== 2;
  const rangeControl = (
    <RangeControl choice={choice} from={range.from} to={range.to} open={open} onOpen={setOpen} onPreset={onPreset} onRange={onRange} ctx={ctx} phone={!desktop} />
  );
  const members = <MemberChooser selected={filters.member ?? null} onSelect={(member) => setFilters((current) => { const next = { ...current }; if (member === null) delete next.member; else next.member = member; return next; })} totals={memberTotals} ctx={ctx} wide={!desktop} />;
  const chipRow = chips.map((chip) => <ActivityScopeChip key={chip.key} name={chip.name} onClear={chip.clear} t={t} />);
  const banner = (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2 text-[12px]" data-token-variant={variant}>
      <span className="font-semibold text-accent">{pt("banner", { n: variant })}</span>
      <span className="text-muted">— {pt(`variant.${variant}` as ProtoKey)}</span>
    </div>
  );

  if (desktop) {
    return (
      <div className="h-full overflow-y-auto bg-canvas" data-activity-page="" data-token-prototype={variant} data-token-layout="desktop">
        <MarkPatterns />
        <div className="mx-auto max-w-[1328px] px-6 pb-6 pt-4">
          {banner}
          <header className="flex flex-wrap items-center gap-x-2 gap-y-2" data-token-header="">
            <Link href="/" className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border border-border bg-card px-3 text-[12px] font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("activity.back")}
            </Link>
            <h1 className="ml-1 shrink-0 text-[17px] font-semibold tracking-[-0.01em] text-primary">{t("activity.title")}</h1>
            {tokensView ? (
              <div className="w-[136px] shrink-0">
                <Segmented label={pt("view.aria")} value="tokens" onChange={() => undefined} options={[{ value: "time", label: pt("view.time") }, { value: "tokens", label: pt("view.tokens") }]} />
              </div>
            ) : null}
            {chipRow}
            <div className="flex-1" />
            {/* The controls wrap as one group, right-aligned, when the row is too narrow. */}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {members}
              <ActivityProjectPicker entries={projectEntries} selected={project} unread={false} onSelect={setProject} locale={locale} t={t} />
              {rangeControl}
              <button type="button" aria-label={pt("how")} title={pt("how")} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-secondary hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Info className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </header>
          <div className="mt-[18px]">
            {variant === 1 ? <Variant1 {...props} /> : variant === 2 ? <Variant2 {...props} /> : variant === 3 ? <Variant3 {...props} onRange={onRange} /> : <Variant4 {...props} />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas" data-activity-page="" data-token-prototype={variant} data-token-layout="phone">
      <MarkPatterns />
      <div className="flex flex-col gap-3 px-3 py-3">
        {banner}
        <header className="flex items-center gap-3">
          <Link href="/" className="flex h-11 items-center gap-1.5 rounded-[8px] border border-border bg-card px-2.5 text-[12px] font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </Link>
          <h1 className="text-[15px] font-bold text-primary">{t("activity.title")}</h1>
        </header>
        <Segmented
          label={pt("view.aria")}
          value={tokensView ? "tokens" : "days"}
          onChange={() => undefined}
          options={[
            { value: "days", label: t("activity.view.days" as MessageKey) },
            { value: "projects", label: t("activity.view.projects" as MessageKey) },
            ...(tokensView ? [{ value: "tokens", label: pt("view.tokens") }] : []),
          ]}
        />
        {members}
        {chips.length ? <div className="flex flex-wrap gap-2">{chipRow}</div> : null}
        {rangeControl}
        {variant === 1 ? <Variant1 {...props} /> : variant === 2 ? <Variant2 {...props} /> : variant === 3 ? <Variant3 {...props} onRange={onRange} /> : <Variant4 {...props} />}
      </div>
    </div>
  );
}
