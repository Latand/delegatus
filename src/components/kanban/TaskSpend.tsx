"use client";

import { useEffect, useRef, useState } from "react";

import { intlLocale } from "@/components/activity/format";
import { compact } from "@/components/activity/tokenParts";
import { EngineMark } from "@/components/EngineMark";
import { TooltipBubble } from "@/components/TooltipBubble";
import type { TaskSpendAccount, TaskSpendProvider, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { useTaskSpend } from "./taskSpendSummaries";

/*
 * How much of each provider's limit a task spent (docs/design/task-limit-spend.md
 * §7.2, variant 2 as approved). The card's state line ends with each provider's
 * engine mark and a scale of four cells, with no digits; the numbers and each
 * account's week sit behind it, in the state dot's kind of popover. Every
 * figure is an estimate, about ±30 %: an approximate one reads «≈», a lower
 * bound «≥», and a provider whose accounts have no limit readings says so in
 * words and shows its tokens only. Claude first, then Codex, everywhere.
 */

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

type Kind = "num" | "tiny" | "floor" | "norate";

function providerKind(provider: TaskSpendProvider): Kind {
  if (provider.bound === "norate") return "norate";
  if (provider.bound === "floor") return "floor";
  return provider.weeklyPp < 1 ? "tiny" : "num";
}

/** Filled cells of the scale: none below 1 %, one to 4 %, two to 14 %, three to 29 %, four from 30 %. Pass the figure the popover prints. */
export function spendCells(pp: number): number {
  if (pp < 1) return 0;
  const shown = Math.round(pp);
  return shown <= 4 ? 1 : shown <= 14 ? 2 : shown <= 29 ? 3 : 4;
}

/** A lower bound fills by its floored figure, as it prints, so the scale never claims more than «≥». */
const providerCells = (provider: TaskSpendProvider) => spendCells(provider.bound === "floor" ? Math.floor(provider.weeklyPp) : provider.weeklyPp);

const decimal = (value: number, locale: Locale) => new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(value);

/** A lower bound never rounds up. */
function floorText(pp: number, locale: Locale): string {
  return pp >= 1 ? `${Math.floor(pp)}%` : `${decimal(Math.floor(pp * 10) / 10, locale)}%`;
}

/** The provider's headline figure: «≈3%», «<1%», «≥12%». */
function headline(provider: TaskSpendProvider, locale: Locale): string {
  const kind = providerKind(provider);
  if (kind === "floor") return `≥${floorText(provider.weeklyPp, locale)}`;
  if (kind === "tiny") return "<1%";
  return `≈${Math.round(provider.weeklyPp)}%`;
}

/** An account's figure, its sign apart so the digits start at one x on every line. */
function accountFigure(pp: number, floor: boolean, locale: Locale): { sign: string; num: string } {
  if (floor) return { sign: "≥", num: floorText(pp, locale) };
  if (pp >= 1) return { sign: "", num: `${Math.round(pp)}%` };
  if (pp >= 0.1) return { sign: "", num: `${decimal(Math.round(pp * 10) / 10, locale)}%` };
  return { sign: "<", num: `${decimal(0.1, locale)}%` };
}

const wholeOrUnder = (pp: number) => (pp >= 1 ? `${Math.round(pp)}%` : "<1%");

function planName(plan: string | null): string | null {
  const trimmed = plan?.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : null;
}

function accountName(account: TaskSpendAccount): string {
  return [account.label, planName(account.plan)].filter(Boolean).join(" · ");
}

/** What a screen reader hears for the marks: one clause per provider. */
export function taskSpendAria(t: TFunction, summary: TaskSpendSummary, locale: Locale): string {
  const parts = summary.providers.map((provider) => {
    const engine = ENGINE_NAME[provider.engine];
    const kind = providerKind(provider);
    if (kind === "norate") return t("taskSpend.aria.norate", { engine });
    if (kind === "tiny") return t("taskSpend.aria.tiny", { engine });
    if (kind === "floor") return t("taskSpend.aria.floor", { engine, value: floorText(provider.weeklyPp, locale) });
    return t("taskSpend.aria.approx", { engine, value: `${Math.round(provider.weeklyPp)}%` });
  });
  return t("taskSpend.aria", { parts: parts.join(", ") });
}

function Scale({ cells }: { cells: number }) {
  return (
    <svg className="scale" viewBox="0 0 15 8" aria-hidden data-cells={cells}>
      {[0, 4, 8, 12].map((x, index) => <rect key={x} x={x} width={3} height={8} rx={0.75} className={index < cells ? "on" : undefined} />)}
    </svg>
  );
}

function Marks({ summary }: { summary: TaskSpendSummary }) {
  const { t } = useLocale();
  return (
    <>
      {summary.providers.map((provider) => {
        const kind = providerKind(provider);
        return (
          <span key={provider.engine} className="spend-p" data-engine={provider.engine} data-kind={kind}>
            <EngineMark engine={provider.engine} size={12} />
            {kind === "norate" ? <span className="spend-n">{t("taskSpend.unknown")}</span> : (
              <>
                {kind === "floor" ? <span className="scale-floor" aria-hidden>≥</span> : null}
                <Scale cells={providerCells(provider)} />
              </>
            )}
          </span>
        );
      })}
    </>
  );
}

function Meter({ provider, account }: { provider: TaskSpendProvider; account: TaskSpendAccount }) {
  const { t, locale } = useLocale();
  const name = accountName(account);
  if (account.weeklyPp === null) {
    return (
      <span className="meter" data-spend-account={account.key}>
        <span className="meter-label" title={name}>{name}</span>
        <span className="meter-value">{t("taskSpend.accountNoRate", { tokens: compact(account.tokens, locale) })}</span>
      </span>
    );
  }
  const figure = accountFigure(account.weeklyPp, provider.bound === "floor", locale);
  const used = account.week ? Math.max(0, Math.min(100, account.week.usedPercent)) : null;
  /* The task's part of this week, drawn at the end of what the week has used. */
  const part = used !== null && account.week?.taskPp ? Math.min(used, Math.max(0, account.week.taskPp)) : 0;
  return (
    <span className="meter" data-spend-account={account.key}>
      <span className="meter-label" title={name}>{name}</span>
      <span className="meter-value">
        {t("taskSpend.task")} <b className="meter-task"><span className="meter-sign">{figure.sign}</span><span className="meter-num">{figure.num}</span></b>
        {used !== null ? <> · {t("taskSpend.week", { value: `${Math.round(used)}%` })}</> : null}
      </span>
      {used !== null ? (
        <span className="meter-bar" aria-hidden>
          <span className="week" style={{ width: `${used}%` }} />
          {part > 0 ? <span className="task" data-engine={provider.engine} style={{ left: `${used - part}%`, width: `${part}%` }} /> : null}
        </span>
      ) : null}
    </span>
  );
}

/** The popover's lines, also the phone task screen's «Limits» section. */
function SpendLines({ summary }: { summary: TaskSpendSummary }) {
  const { t, locale } = useLocale();
  const rated = summary.providers.some((provider) => provider.bound !== "norate");
  /* Who has no limit readings: each account to the owner, the provider to anyone else. */
  const unread = summary.providers.filter((provider) => provider.bound === "norate").flatMap((provider) =>
    provider.accounts ? provider.accounts.map((account) => `${ENGINE_NAME[provider.engine]} ${account.label}`) : [ENGINE_NAME[provider.engine]]);
  const blocks = summary.providers.map((provider) => {
    const engine = ENGINE_NAME[provider.engine];
    if (provider.bound === "norate") {
      const accounts = provider.accounts;
      const tokens = compact(provider.tokens, locale);
      const sub = accounts?.length === 1
        ? t("taskSpend.norateAccount", { account: accountName(accounts[0]!), tokens })
        : t("taskSpend.norateTokens", { tokens });
      return (
        <span key={provider.engine} className="pop-row" data-spend-provider={provider.engine} data-kind="norate">
          <EngineMark engine={provider.engine} size={12} />
          <span className="pop-main"><b>{engine}</b> — {t("taskSpend.norateHead")}<span className="pop-sub">{sub}</span></span>
        </span>
      );
    }
    const sessions = (provider.accounts ?? []).filter((account) => account.sessionPp !== null && account.sessionPp > 0);
    return (
      <span key={provider.engine} className="pop-block" data-spend-provider={provider.engine} data-kind={providerKind(provider)}>
        <span className="pop-row">
          <EngineMark engine={provider.engine} size={12} />
          <span className="pop-main"><b>{engine} {headline(provider, locale)}</b> {t("taskSpend.ofWeek")}</span>
        </span>
        {provider.accounts?.map((account) => <Meter key={account.key} provider={provider} account={account} />)}
        {provider.floor ? <span className="pop-sub meter-note pop-warn">{t(`taskSpend.floor.${provider.floor}`)}</span> : null}
        {sessions.map((account) => (
          <span key={account.key} className="pop-sub meter-note" data-spend-session={account.key}>
            {t("taskSpend.session", { value: wholeOrUnder(account.sessionPp!), account: account.label })}
          </span>
        ))}
      </span>
    );
  });
  const note = [rated ? t("taskSpend.estimate") : null, unread.length ? t("taskSpend.noReadings", { accounts: unread.join(", ") }) : null].filter(Boolean).join(". ");
  return (
    <>
      {blocks}
      {note ? <span className="pop-note">{note}</span> : null}
    </>
  );
}

/**
 * The marks at the end of a card's state line. On the desktop card they open
 * the popover by hover, focus or tap, as the state dot does; on the phone's
 * card face, which is one button, they are passive and the task screen lists
 * the numbers. A task with no counted work draws nothing.
 */
export function TaskSpendMarks({ taskId, interactive }: { taskId: string; interactive: boolean }) {
  const { t, locale } = useLocale();
  const summary = useTaskSpend(taskId);
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  if (!summary?.providers.length) return null;
  const label = taskSpendAria(t, summary, locale);
  if (!interactive) return <span className="spend" data-spend={taskId} aria-hidden><Marks summary={summary} /></span>;
  return (
    <span
      ref={ref}
      className="spend"
      data-spend={taskId}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={open}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }
      }}
    >
      <Marks summary={summary} />
      {open ? (
        <TooltipBubble anchorRef={ref} side="top" align="right" className="card-state-pop spend-pop">
          <span data-spend-pop={taskId}>
            <span className="pop-title">{t("taskSpend.title")}</span>
            <SpendLines summary={summary} />
          </span>
        </TooltipBubble>
      ) : null}
    </span>
  );
}

/** The phone card face reads its spend into the face's one label. */
export function useTaskSpendLabel(taskId: string | null): string | null {
  const { t, locale } = useLocale();
  const summary = useTaskSpend(taskId);
  return summary?.providers.length ? taskSpendAria(t, summary, locale) : null;
}

/** The phone task screen's «Limits» section: the popover's lines, always open. */
export function PhoneTaskSpend({ taskId, headingClass }: { taskId: string; headingClass: string }) {
  const { t } = useLocale();
  const summary = useTaskSpend(taskId);
  if (!summary?.providers.length) return null;
  return (
    <section data-phone-task-spend={taskId} className="flex shrink-0 flex-col gap-2">
      <h2 className={`${headingClass} m-0`}>{t("taskSpend.section")}</h2>
      <div className="phone-spend"><SpendLines summary={summary} /></div>
    </section>
  );
}
