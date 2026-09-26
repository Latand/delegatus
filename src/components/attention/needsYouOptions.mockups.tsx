"use client";

import { ChevronDown, ChevronRight, Filter, Inbox } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { MobileSheet, MobileSheetSection } from "@/components/mobile/MobileSheet";
import { BAR_CONTROL, BAR_OUTLINED, BAR_PRESSED } from "@/components/ProjectBar";
import { ReportLog } from "@/components/orchestrator/reportLog/ReportLog";
import type { ReportLogPage } from "@/lib/bridge/reportLog";
import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { AttentionLaneRow, AttentionQueueRow } from "./AttentionIsland";
import { attentionEntryProject, buildNeedsYouQueue } from "./attentionQueue";
import { ConversationRow, PipelineRow } from "./MobileAttentionSheet";
import type { MobileAttentionEntry } from "./attentionQueue";

/*
 * The three directions of docs/design/needs-you-options.md, drawn over the
 * real Viewer the fixture mounts. Everything the operator reads here is a
 * product component (`AttentionQueueRow`, `AttentionLaneRow`,
 * `PermissionActions` through them, the phone sheet's rows, `MobileSheet`,
 * `ReportLog`) or the bar's own control classes; what is new is only where
 * they sit and the few words each option adds, which the options doc names.
 * A mockup: none of this is wired to the Viewer's cycle or filter.
 */

export interface MockupData {
  files: FileEntry[];
  pipelines: Pipeline[];
  now: number;
  names: Record<string, string>;
  current: string | null;
  seatBeside: boolean;
  reportPage: ReportLogPage;
}

type Option = "today" | "a" | "b" | "c";

const params = new URLSearchParams(location.search);
const OPTION = (params.get("option") ?? "today") as Option;
const OPEN = params.has("open");
/* B's fallback when the seat is beside the board: the panel as today's popover. */
const OVERLAY = params.get("panel") === "overlay";
const PHONE = window.innerWidth < 768;
const PANEL_WIDTH = OPTION === "c" ? 360 : 320;
/* B's fold: the current project and one other open, the third folded, so a frame shows both. */
const FOLDED = new Set(["tg-bot"]);

interface Section { project: string; entries: MobileAttentionEntry[] }

function sections(queue: readonly MobileAttentionEntry[], current: string | null): Section[] {
  const byProject = new Map<string, MobileAttentionEntry[]>();
  if (current) byProject.set(current, []);
  for (const entry of queue) {
    const project = attentionEntryProject(entry);
    byProject.set(project, [...(byProject.get(project) ?? []), entry]);
  }
  return [...byProject].filter(([, entries]) => entries.length).map(([project, entries]) => ({ project, entries }));
}

/** The CSS each frame needs on the Viewer underneath. */
function frameStyle(docked: boolean): string {
  const rules = [
    /* A transient arrival toast would cover the corner every option redraws. */
    "[data-attention-toast], [data-mobile2-arrival]{display:none!important}",
    /* C's phone lands on `#reports` directly, which the first render reads before it knows it is a phone. */
    "[data-unknown-fragment-notice]{display:none!important}",
  ];
  if (OPTION !== "today" && !PHONE) rules.push("[data-attention-island]{display:none!important}");
  /* B and C dock beside the board: the columns and the seat give up the panel's width. */
  if (docked) rules.push(`.kb-body{margin-right:${PANEL_WIDTH}px}`);
  /* Section rows drop the project chip their section header already names. */
  rules.push("[data-nyo-grouped] [data-attention-row] > span:first-child > span[title], [data-nyo-grouped] [data-attention-lane] > span:first-child > span[title]{display:none}");
  /* A list that stays open has room for an ask's whole sentence: two lines, not one. */
  rules.push("[data-nyo-panel] [data-attention-decision]{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}");
  if (PHONE && (OPTION === "b" || OPTION === "c")) rules.push('[data-mobile2-open="attention"] > span{visibility:hidden}');
  return rules.join("\n");
}

function useQueue(data: MockupData): MobileAttentionEntry[] {
  return buildNeedsYouQueue(data.files, data.pipelines, data.now, []);
}

/* ── shared rows ──────────────────────────────────────────────────────── */

function DesktopRow({ entry, names, dismiss = false, focused = false }: { entry: MobileAttentionEntry; names: Record<string, string>; dismiss?: boolean; focused?: boolean }) {
  const { t } = useLocale();
  const row = entry.kind === "conversation"
    ? <AttentionQueueRow item={entry.item} onOpen={() => {}} />
    : <AttentionLaneRow row={entry.row} projectName={names[entry.row.pipeline.project]} onOpen={() => {}} />;
  if (!dismiss && !focused) return row;
  return (
    <div className={`flex min-w-0 items-start gap-1 rounded-[8px] ${focused ? "ring-2 ring-inset ring-accent/40" : ""}`} data-nyo-focused={focused ? "" : undefined}>
      <div className="min-w-0 flex-1">{row}</div>
      {dismiss ? (
        <button
          type="button"
          className="mr-1 mt-1.5 shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={t("needs.dismissHint")}
        >
          {t("needs.dismiss")}
        </button>
      ) : null}
    </div>
  );
}

function SectionHeader({ name, count, folded, foldable = false, first = false }: { name: string; count: number; folded?: boolean; foldable?: boolean; first?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 pb-0.5 ${first ? "pt-1.5" : "mt-1 border-t border-border pt-2"} text-label font-semibold text-secondary`} data-nyo-section={name}>
      {foldable ? (folded ? <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />) : null}
      <span>{name}</span>
      <span className="text-caption font-semibold tabular-nums text-muted">{count}</span>
    </div>
  );
}

/* The bar's icon size (`ProjectBar`'s BAR_ICON). */
const BAR_ICON = "h-[15px] w-[15px] shrink-0";
const WarnDot = () => <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-warning" aria-hidden />;
const ICON_CONTROL = `${BAR_CONTROL} ${BAR_OUTLINED} w-8 px-0`;

/* ── Option A: here first ─────────────────────────────────────────────── */

function OptionADesktop({ data }: { data: MockupData }) {
  const { t } = useLocale();
  const queue = useQueue(data);
  const here = data.current ? queue.filter((entry) => attentionEntryProject(entry) === data.current) : queue;
  const elsewhere = queue.length - here.length;
  const groups = sections(queue, data.current);
  return (
    <div className={`pointer-events-none fixed right-4 ${data.current ? "top-2" : "top-[46px]"} z-50 flex flex-col items-end text-[15px] leading-normal`} data-nyo-island="a">
      <div className="pointer-events-auto relative flex items-center gap-2">
        <button type="button" className={`${BAR_CONTROL} ${OPEN ? BAR_PRESSED : BAR_OUTLINED}`} aria-expanded={OPEN}>
          {here.length ? <WarnDot /> : null}
          <span>{t("attention.badge", { count: here.length })}</span>
          {elsewhere ? <span className="font-normal text-muted">+{elsewhere} в інших</span> : null}
        </button>
        <button type="button" className={ICON_CONTROL} title={data.current ? "Наступний у цьому проєкті (N, Shift-N назад)" : "Наступний (N, Shift-N назад)"} aria-label="Наступний у цьому проєкті">
          <ChevronRight className={BAR_ICON} aria-hidden />
        </button>
        <button type="button" className={ICON_CONTROL} title={t("attention.filterOn")} aria-label={t("attention.filterOn")} aria-pressed={false}>
          <Filter className={BAR_ICON} aria-hidden />
        </button>
        {OPEN ? (
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 max-h-[70vh] w-[360px] overflow-y-auto rounded-[10px] border border-border bg-card p-1.5 shadow-1" data-nyo-grouped="">
            <div className="px-2.5 pb-1 pt-1.5 text-label font-semibold text-secondary">{t("attention.popoverTitle")}</div>
            {groups.map((group, index) => (
              <div key={group.project}>
                <SectionHeader name={data.names[group.project] ?? group.project} count={group.entries.length} first={index === 0} />
                {group.entries.map((entry) => <DesktopRow key={entry.id} entry={entry} names={data.names} />)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Option B: a panel grouped by project, no Next ────────────────────── */

function PanelBody({ data, groups }: { data: MockupData; groups: Section[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1.5" data-nyo-grouped="">
      {groups.map((group, index) => {
        const folded = group.project !== data.current && FOLDED.has(group.project);
        return (
          <div key={group.project}>
            <SectionHeader name={data.names[group.project] ?? group.project} count={group.entries.length} folded={folded} foldable first={index === 0} />
            {folded ? null : group.entries.map((entry, rowIndex) => (
              <DesktopRow key={entry.id} entry={entry} names={data.names} dismiss focused={index === 0 && rowIndex === 0} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function OptionBDesktop({ data }: { data: MockupData }) {
  const queue = useQueue(data);
  const groups = sections(queue, data.current);
  const title = `Чекають на вас · ${queue.length}`;
  return (
    <>
      <div className="pointer-events-none fixed right-4 top-2 z-50 flex flex-col items-end text-[15px] leading-normal" data-nyo-island="b">
        <div className="pointer-events-auto relative flex items-center gap-2">
          <button type="button" className={`${BAR_CONTROL} ${OPEN ? BAR_PRESSED : BAR_OUTLINED}`} aria-expanded={OPEN}>
            {queue.length ? <WarnDot /> : null}
            <span>Чекають</span>
            <span className="tabular-nums">{queue.length}</span>
          </button>
          {OPEN && OVERLAY ? (
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 flex max-h-[75vh] w-[340px] flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-1">
              <h2 className="flex h-9 shrink-0 items-center border-b border-border px-3 text-ui font-semibold text-secondary">{title}</h2>
              <PanelBody data={data} groups={groups} />
            </div>
          ) : null}
        </div>
      </div>
      {OPEN && !OVERLAY ? (
        <aside className="fixed bottom-0 right-0 top-12 z-40 flex flex-col border-l border-border bg-card" style={{ width: PANEL_WIDTH }} aria-label={title} data-nyo-panel="b">
          <h2 className="flex h-9 shrink-0 items-center border-b border-border px-3 text-ui font-semibold text-secondary">{title}</h2>
          <PanelBody data={data} groups={groups} />
        </aside>
      ) : null}
    </>
  );
}

/* ── Option C: one inbox, needs-you pinned above the reports log ──────── */

const UNSEEN_REPORTS = 2;

function PinnedSection({ data, phone = false }: { data: MockupData; phone?: boolean }) {
  const queue = useQueue(data).filter((entry) => attentionEntryProject(entry) === data.current);
  if (phone) {
    return (
      <div className="flex flex-col border-b border-border bg-card" data-nyo-pinned="">
        <MobileSheetSection count={queue.length}>Чекають</MobileSheetSection>
        {queue.map((entry) => entry.kind === "conversation"
          ? <ConversationRow key={entry.id} item={entry.item} now={data.now} current={false} onOpen={() => {}} />
          : <PipelineRow key={entry.id} row={entry.row} current={false} onOpen={() => {}} />)}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col border-b border-border" data-nyo-pinned="" data-nyo-grouped="">
      <h2 className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3 text-ui font-semibold text-secondary">
        <WarnDot />Чекають<span className="text-caption tabular-nums text-muted">{queue.length}</span>
      </h2>
      <div className="p-1.5">
        {queue.map((entry) => <DesktopRow key={entry.id} entry={entry} names={data.names} dismiss />)}
      </div>
    </div>
  );
}

function OptionCDesktop({ data }: { data: MockupData }) {
  const here = useQueue(data).filter((entry) => attentionEntryProject(entry) === data.current);
  const count = here.length + UNSEEN_REPORTS;
  return (
    <>
      <div className="pointer-events-none fixed right-4 top-2 z-50 flex flex-col items-end text-[15px] leading-normal" data-nyo-island="c">
        <button type="button" className={`pointer-events-auto ${BAR_CONTROL} ${OPEN ? BAR_PRESSED : BAR_OUTLINED}`} aria-expanded={OPEN}>
          <Inbox className={BAR_ICON} aria-hidden />
          <span>Вхідні</span>
          <span className="tabular-nums">{count}</span>
        </button>
      </div>
      {OPEN ? (
        <aside className="fixed bottom-0 right-0 top-12 z-40 flex flex-col border-l border-border bg-card" style={{ width: PANEL_WIDTH }} aria-label="Вхідні" data-nyo-panel="c">
          <PinnedSection data={data} />
          <ReportLog project={data.current ?? ""} variant="column" initial={data.reportPage} />
        </aside>
      ) : null}
    </>
  );
}

/* ── the phone ────────────────────────────────────────────────────────── */

/** The bar's own ⚠ pill, drawn over the real one with the option's count. */
function PhoneBadge({ count }: { count: number }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const find = () => {
      const pill = document.querySelector<HTMLElement>('[data-mobile2-open="attention"] > span');
      if (pill) setRect(pill.getBoundingClientRect());
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!rect) return null;
  return (
    <span
      className="pointer-events-none fixed z-[70] inline-flex h-7 items-center gap-1 rounded-full border border-warning/45 bg-warning-soft px-2.5 text-ui font-bold tabular-nums text-warning"
      style={{ top: rect.top, right: window.innerWidth - rect.right }}
      data-nyo-phone-badge={count}
    >
      <svg viewBox="0 0 24 24" className="h-[13px] w-[13px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
      </svg>
      {count}
    </span>
  );
}

function OptionBPhone({ data }: { data: MockupData }) {
  const queue = useQueue(data);
  const groups = sections(queue, data.current);
  return (
    <>
      <PhoneBadge count={queue.length} />
      {OPEN ? (
        <MobileSheet name="attention" title={`Потребують вас · ${queue.length}`} onClose={() => {}}>
          <div className="flex flex-col" data-nyo-phone-sections="">
            {groups.map((group) => {
              const folded = group.project !== data.current && FOLDED.has(group.project);
              return (
                <div key={group.project} className="flex flex-col">
                  <MobileSheetSection count={group.entries.length}>
                    {folded ? <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden />}
                    {data.names[group.project] ?? group.project}
                  </MobileSheetSection>
                  {folded ? null : group.entries.map((entry) => entry.kind === "conversation"
                    ? <ConversationRow key={entry.id} item={entry.item} now={data.now} current={false} onOpen={() => {}} />
                    : <PipelineRow key={entry.id} row={entry.row} current={false} onOpen={() => {}} />)}
                </div>
              );
            })}
          </div>
        </MobileSheet>
      ) : null}
    </>
  );
}

/** C's phone: the real reports screen (`#reports`), retitled «Вхідні», with the pinned section above its log. */
function OptionCPhone({ data }: { data: MockupData }) {
  const here = useQueue(data).filter((entry) => attentionEntryProject(entry) === data.current);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!OPEN) return;
    let frame = 0;
    const find = () => {
      const log = document.querySelector<HTMLElement>('[data-report-log][data-report-log-variant="screen"]');
      const title = document.querySelector<HTMLElement>("[data-mobile2-title-text]");
      if (!log || !title) { frame = requestAnimationFrame(find); return; }
      title.textContent = "Вхідні";
      const host = document.createElement("div");
      host.setAttribute("data-nyo-pinned-host", "");
      log.insertBefore(host, log.firstChild);
      setSlot(host);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      {OPEN ? null : <PhoneBadge count={here.length + UNSEEN_REPORTS} />}
      {slot ? createPortal(<PinnedSection data={data} phone />, slot) : null}
    </>
  );
}

/** A's phone is today's phone, and today is today: the open frame is the real
    sheet or popover, opened by the product's own control. */
function OpenTheRealOne({ selector }: { selector: string }) {
  useEffect(() => {
    if (!OPEN) return;
    let frame = 0;
    const open = () => {
      const badge = document.querySelector<HTMLElement>(selector);
      if (badge) badge.click();
      else frame = requestAnimationFrame(open);
    };
    open();
    return () => cancelAnimationFrame(frame);
  }, [selector]);
  return null;
}

/** The bar's right reserve, sized to the control an option puts there
    (today's is a fixed 236 px sized for the amber pill). */
function useBarReserve(): string {
  const [reserve, setReserve] = useState<number | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const island = document.querySelector<HTMLElement>("[data-nyo-island] > div, [data-nyo-island] > button");
      if (island) setReserve(Math.ceil(island.getBoundingClientRect().width) + 16 + 16);
      else frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, []);
  return reserve === null ? "" : `.kb .bar[data-bar]{padding-right:${reserve}px!important}`;
}

function Mockup({ data }: { data: MockupData }) {
  const reserve = useBarReserve();
  const docked = !PHONE && OPEN && !OVERLAY && (OPTION === "b" || OPTION === "c");
  let body: ReactNode = null;
  if (PHONE) {
    if (OPTION === "b") body = <OptionBPhone data={data} />;
    else if (OPTION === "c") body = <OptionCPhone data={data} />;
    else body = <OpenTheRealOne selector='[data-mobile2-open="attention"]' />;
  } else if (OPTION === "today") body = <OpenTheRealOne selector="[data-attention-count]" />;
  else if (OPTION === "a") body = <OptionADesktop data={data} />;
  else if (OPTION === "b") body = <OptionBDesktop data={data} />;
  else if (OPTION === "c") body = <OptionCDesktop data={data} />;
  return (
    <>
      <style>{`${frameStyle(docked)}\n${PHONE || OPTION === "today" ? "" : reserve}`}</style>
      {body}
    </>
  );
}

export function mountNeedsYouMockup(data: MockupData): void {
  if (PHONE && OPTION === "c" && OPEN) location.hash = "#reports";
  const host = document.createElement("div");
  host.setAttribute("data-needs-you-mockup-ready", "");
  document.body.appendChild(host);
  createRoot(host).render(<Mockup data={data} />);
}
