"use client";

import { useEffect, useId, useRef, useState } from "react";

import { intlLocale } from "@/components/activity/format";
import { compact, money } from "@/components/activity/tokenParts";
import { EngineMark } from "@/components/EngineMark";
import { TooltipBubble } from "@/components/TooltipBubble";
import type { SpendBudget, TaskSpendAccount, TaskSpendProvider, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { useTaskSpend } from "./taskSpendSummaries";

const ENGINE_NAME = { claude: "Claude", codex: "Codex" } as const;

type Kind = "num" | "tiny" | "floor" | "tokens";

function providerKind(provider: TaskSpendProvider): Kind {
  if (provider.bound === "tokens") return "tokens";
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

function estimatePercent(pp: number, locale: Locale): string {
  if (pp < 0.1) return "<0.1%";
  return `${decimal(Math.round(pp * 10) / 10, locale)}%`;
}

function accountPlan(account: TaskSpendAccount): string | null {
  if (account.plan === "max" && account.planTier === "default_claude_max_20x") return "Max 20×";
  if (account.plan === "max" && account.planTier === "default_claude_max_5x") return "Max 5×";
  const plan = account.plan?.trim();
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

function accountBudget(account: TaskSpendAccount, locale: Locale, t: TFunction): string | null {
  if (!account.budget) return null;
  const number = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 });
  return t("taskSpend.budget", { low: number.format(account.budget.low), high: number.format(account.budget.high), grade: t(`taskSpend.grade.${account.budget.grade}`) });
}

function budgetText(budget: SpendBudget, locale: Locale, t: TFunction): string {
  const number = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 });
  return t("taskSpend.budget", { low: number.format(budget.low), high: number.format(budget.high), grade: t(`taskSpend.grade.${budget.grade}`) });
}

/** What a screen reader hears for the marks: one clause per provider. */
export function taskSpendAria(t: TFunction, summary: TaskSpendSummary, locale: Locale): string {
  const parts = summary.providers.map(provider => t("taskSpend.aria.tokens", {
    engine: ENGINE_NAME[provider.engine], tokens: compact(provider.tokens, locale),
  }));
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
  const { locale } = useLocale();
  return (
    <>
      {summary.providers.map((provider) => {
        const kind = providerKind(provider);
        return (
          <span key={provider.engine} className="spend-p" data-engine={provider.engine} data-kind={kind}>
            <EngineMark engine={provider.engine} size={12} />
            {kind === "tokens" ? <span className="spend-n">{compact(provider.tokens, locale)}</span> : (
              <>
                <Scale cells={providerCells(provider)} />
              </>
            )}
          </span>
        );
      })}
    </>
  );
}

function usd(value: number, locale: Locale): string {
  return value > 0 && value < 0.01 ? `<$${decimalCents(0.01, locale)}` : money(value, locale);
}

const decimalCents = (value: number, locale: Locale) =>
  new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);

function accountRange(account: TaskSpendAccount, locale: Locale): string | null {
  if (!account.range) return null;
  return `${decimalCents(account.range.low, locale)}–${decimalCents(account.range.high, locale)}%`;
}

/** The card popover and the phone task screen share the same estimates. */
function SpendLines({ summary, accountDetails = false }: { summary: TaskSpendSummary; accountDetails?: boolean }) {
  const { t, locale } = useLocale();
  const tokens = summary.providers.reduce((total, p) => total + p.tokens, 0);
  return (
    <>
      {summary.providers.map((provider) => {
        const engine = ENGINE_NAME[provider.engine];
        const kind = providerKind(provider);
        const api = provider.apiUsd === null ? t("taskSpend.noApi")
          : t(provider.apiPricedTokens < provider.tokens ? "taskSpend.partialApi" : "taskSpend.api", { value: usd(provider.apiUsd, locale) });
        return (
          <span key={engine} className="pop-block" data-spend-provider={provider.engine} data-kind={kind}>
            <span className="pop-row">
              <EngineMark engine={provider.engine} size={12} />
              <span className="pop-main">
                <b>{engine}</b>
                {" "}{t("taskSpend.tokens", { tokens: compact(provider.tokens, locale) })}
                {api ? <> · <span className="spend-unit">{api}</span></> : null}
                {provider.engine === "codex" ? <> · <span className="spend-unit">{t("taskSpend.cacheWriteAssumption")}</span></> : null}
              </span>
            </span>
            {provider.floor || (provider.basis && !accountDetails) ? <span className={`pop-sub meter-note${provider.floor ? " pop-warn" : ""}`}>
              {provider.basis && !accountDetails ? t(`taskSpend.basis.${provider.basis}`) : null}
              {provider.basis && !accountDetails && provider.floor ? " · " : null}
              {provider.floor ? t("taskSpend.floor.before-counting") : null}
            </span> : null}
            {[...new Set(provider.issues)].map(issue => <span key={issue} className="pop-sub meter-note">{t(`taskSpend.issue.${issue}`)}</span>)}
            {accountDetails ? provider.accounts?.map(account => {
              const label = account.key === "unknown" ? t("taskSpend.unattributed") : account.label;
              const plan = accountPlan(account);
              const share = account.weeklyPp === null ? null : `≈${estimatePercent(account.weeklyPp, locale)}`;
              const range = accountRange(account,locale);
              return <span key={account.key} className="pop-sub meter-note" data-spend-account={account.key}>
                {label}{plan ? ` · ${plan}` : ""} · {share
                  ? t("taskSpend.accountShare", { value: share })
                  : t("taskSpend.tokens", { tokens: compact(account.tokens, locale) })}
                {range ? ` (${range})` : ""}
                {account.basis ? ` · ${t(`taskSpend.basis.${account.basis}`)}` : ""}
                {accountBudget(account,locale,t) ? ` · ${accountBudget(account,locale,t)}` : ""}
                {account.apiUsd === null ? "" : ` · ${t(account.apiPricedTokens < account.tokens ? "taskSpend.partialApi" : "taskSpend.api", { value: usd(account.apiUsd,locale) })}`}
                {account.week ? ` · ${t("taskSpend.week", { value: `${Math.round(account.week.usedPercent)}%` })}` : ""}
                {account.sessionPp !== null && account.sessionPp > 0 ? ` · ${t("taskSpend.sessionEstimate", { value: `≈${estimatePercent(account.sessionPp, locale)}` })}` : ""}
              </span>;
            }) : null}
            {provider.unpricedTokens > 0 ? <span className="pop-sub meter-note">
              {t("taskSpend.unpriced", { tokens: compact(provider.unpricedTokens, locale) })}
              {provider.unpricedModels.length > 0 ? <> ({provider.unpricedModels.join(", ")})</> : null}
            </span> : null}
          </span>
        );
      })}
      <span className="pop-note">{t("taskSpend.tokens", { tokens: compact(tokens, locale) })}</span>
    </>
  );
}

/**
 * The marks at the end of a card's state line. On the desktop card they open
 * the popover by mouse hover, keyboard focus or tap, as the state dot does; on the phone's
 * card face, which is one button, they are passive and the task screen lists
 * the numbers. A task with no counted work draws nothing.
 */
export function TaskSpendMarks({ taskId, interactive }: { taskId: string; interactive: boolean }) {
  const { t, locale } = useLocale();
  const summary = useTaskSpend(taskId);
  const ref = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const bubbleId = useId();
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
      aria-describedby={open ? bubbleId : undefined}
      /* A mouse opens it by hovering; a tap focuses and clicks it, so only the click toggles it. */
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false); }}
      onPointerDown={() => { pressed.current = true; }}
      onFocus={() => { if (!pressed.current) setOpen(true); }}
      onBlur={() => { pressed.current = false; setOpen(false); }}
      onClick={(event) => { event.stopPropagation(); pressed.current = false; setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setOpen((value) => !value); }
      }}
    >
      <Marks summary={summary} />
      {open ? (
        <TooltipBubble id={bubbleId} anchorRef={ref} side="top" align="right" className="card-state-pop spend-pop"
          place={bubble => {
            const card = ref.current?.closest<HTMLElement>("[data-kanban-card]");
            if (!card) return null;
            const bounds = card.getBoundingClientRect();
            const right = Math.max(0, window.innerWidth - bounds.right - 16);
            const left = Math.max(0, bounds.left - 16);
            const onRight = right >= left;
            const room = onRight ? right : left;
            if (room < 220) return null;
            const width = Math.min(320, room);
            bubble.style.maxWidth = `${width}px`;
            const anchor = ref.current!.getBoundingClientRect();
            const height = bubble.getBoundingClientRect().height;
            return {
              left: onRight ? bounds.right + 8 : bounds.left - width - 8,
              top: Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)),
              maxWidth: width,
            };
          }}>
          <span data-spend-pop={taskId}>
            <span className="pop-title">{t("taskSpend.title")}</span>
            <SpendLines summary={summary} accountDetails />
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
      <div className="phone-spend"><SpendLines summary={summary} accountDetails /></div>
    </section>
  );
}
