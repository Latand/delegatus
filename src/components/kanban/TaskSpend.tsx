"use client";

import { useEffect, useId, useRef, useState } from "react";

import { intlLocale } from "@/components/activity/format";
import { compact, money } from "@/components/activity/tokenParts";
import { EngineMark } from "@/components/EngineMark";
import { TooltipBubble } from "@/components/TooltipBubble";
import type { SpendBudget, SpendRange, TaskSpendAccount, TaskSpendProvider, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";
import { useLocale, type Locale, type TFunction } from "@/lib/i18n";

import { COMPACT_SUFFIX, chooseSpendPlacement, clearOf, settleSpendPlacement, spendCandidates, windowTextBoxes, type Box, type SpendKind } from "./spendPopoverPlacement";
import { useTaskSpend } from "./taskSpendSummaries";

/** The bubble's compact arrangement (the providers side by side) is a data attribute the stylesheet reads; the placement sets it while it measures. */
function setCompact(bubble: HTMLElement, compact: boolean) {
  if (compact) bubble.dataset.spendCompact = "";
  else delete bubble.dataset.spendCompact;
}

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

const GRADE_ORDER: SpendBudget["grade"][] = ["measured", "measured-thin", "published", "inferred"];

/** One budget line per provider: the widest range its accounts' plans give, at the weakest grade among them. */
function budgetText(budgets: SpendBudget[], locale: Locale, t: TFunction): string | null {
  if (!budgets.length) return null;
  const number = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 });
  const grade = budgets.reduce((worst, b) => (GRADE_ORDER.indexOf(b.grade) > GRADE_ORDER.indexOf(worst) ? b.grade : worst), budgets[0].grade);
  return t("taskSpend.budget", {
    low: number.format(Math.min(...budgets.map(b => b.low))), high: number.format(Math.max(...budgets.map(b => b.high))), grade: t(`taskSpend.grade.${grade}`),
  });
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

/** The sign stands against its figure here, as it does in the share: «≈$196», «≈12.4%». */
function usd(value: number, locale: Locale): string {
  return value > 0 && value < 0.01 ? `<$${decimalCents(0.01, locale)}` : money(value, locale).replace("≈ ", "≈");
}

const decimalCents = (value: number, locale: Locale) =>
  new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);

/**
 * The share as the headline prints it, with its range at the same precision: «≈1.5% of week (1–2.6%)».
 * A lower bound prints as «≥12.4% of week», never a two-sided range.
 */
function shareText(pp: number, range: SpendRange | null, locale: Locale, t: TFunction, floor = false): string {
  const bound = (value: number) => decimal(Math.round(value * 10) / 10, locale);
  if (floor) return t("taskSpend.share", { value: `≥${decimal(Math.floor(pp * 10 + 1e-9) / 10, locale)}%` });
  const span = range ? ` (${bound(range.low)}–${bound(range.high)}%)` : "";
  return `${t("taskSpend.share", { value: pp < 0.1 ? "<0.1%" : `≈${estimatePercent(pp, locale)}` })}${span}`;
}

/** Model ids stay whole: a line breaks between ids, never inside one. */
function ModelIds({ models }: { models: readonly string[] }) {
  return <>{models.map((model, at) => <span key={model}>{at > 0 ? ", " : null}<span className="model-id">{model}</span></span>)}</>;
}

/** A message that names models around a `{models}` slot, with each id kept whole. */
function withModels(template: (models: string) => string, models: readonly string[]) {
  const [before = "", after = ""] = template("\u0000").split("\u0000");
  return <>{before}<ModelIds models={models} />{after}</>;
}

function SpendProvider({ provider }: { provider: TaskSpendProvider }) {
  const { t, locale } = useLocale();
  const engine = ENGINE_NAME[provider.engine];
  const kind = providerKind(provider);
  const partial = provider.apiUsd !== null && provider.unpricedTokens > 0;
  const api = provider.apiUsd === null
    ? (provider.unpricedModels.length ? withModels(models => t("taskSpend.noApiModels", { models }), provider.unpricedModels) : t("taskSpend.noApi"))
    : t(provider.apiPricedTokens < provider.tokens ? "taskSpend.partialApi" : "taskSpend.api", { value: usd(provider.apiUsd, locale) });
  const accounts = provider.accounts ?? [];
  const several = accounts.length > 1;
  const budget = provider.basis && provider.basis !== "measured" ? budgetText(provider.budgets, locale, t) : null;
  /* A guest has no account lines, so the provider's own share leads its basis line. */
  const guestShare = provider.accounts === null ? (kind === "tokens" ? null : shareText(provider.weeklyPp, provider.range, locale, t, kind === "floor")) : null;
  /* Tokens with no share say why: a missing plan or budget has its own line, otherwise the model has no price to weigh them by. */
  const noShare = kind === "tokens" && !provider.issues.some(issue => issue !== "historicalPriceCoverage")
    ? t(provider.unpricedModels.length || provider.apiUsd === null ? "taskSpend.noShare.unpriced" : "taskSpend.noShare.other") : null;
  const basis = provider.basis ? [guestShare, t(`taskSpend.basis.${provider.basis}`), budget].filter(Boolean).join(" · ") : null;
  return (
    <span className="pop-block" data-spend-provider={provider.engine} data-kind={kind}>
      <span className="pop-row">
        <EngineMark engine={provider.engine} size={12} />
        <span className="pop-main">
          <b>{engine}</b>
          {" "}{t("taskSpend.tokens", { tokens: compact(provider.tokens, locale) })} · <span className="spend-unit">{api}</span>
        </span>
      </span>
      {provider.floor ? <span className="pop-sub meter-note pop-warn">{t("taskSpend.floor.before-counting")}</span> : null}
      {accounts.map((account) => {
        const hasShare = account.weeklyPp !== null;
        /* One account with no share has nothing to add to its provider's line. */
        if (!several && !hasShare) return null;
        const label = account.key === "unknown" ? t("taskSpend.unattributed") : account.label;
        const plan = accountPlan(account);
        const parts = [
          label,
          plan,
          hasShare ? shareText(account.weeklyPp!, account.range, locale, t, kind === "floor") : t("taskSpend.tokens", { tokens: compact(account.tokens, locale) }),
          several && account.apiUsd !== null ? usd(account.apiUsd, locale) : null,
        ].filter(Boolean);
        return <span key={account.key} className="pop-sub meter-note" data-spend-account={account.key}>{parts.join(" · ")}</span>;
      })}
      {basis ? <span className="pop-sub meter-note pop-basis">{basis}</span> : null}
      {noShare ? <span className="pop-sub meter-note" data-spend-reason="">{noShare}</span> : null}
      {[...new Set(provider.issues)].map(issue => <span key={issue} className="pop-sub meter-note" data-spend-reason="">{t(`taskSpend.issue.${issue}`)}</span>)}
      {partial ? <span className="pop-sub meter-note">
        {t("taskSpend.unpriced", { tokens: compact(provider.unpricedTokens, locale) })}
        {provider.unpricedModels.length > 0 ? <> (<ModelIds models={provider.unpricedModels} />)</> : null}
      </span> : null}
    </span>
  );
}

/** The card popover and the phone task screen share the same estimates: each figure once per provider. */
function SpendLines({ summary, total = false }: { summary: TaskSpendSummary; total?: boolean }) {
  const { t, locale } = useLocale();
  const tokens = summary.providers.reduce((sum, p) => sum + p.tokens, 0);
  return (
    <>
      {summary.providers.map(provider => <SpendProvider key={provider.engine} provider={provider}/>)}
      {total && summary.providers.length > 1 ? <span className="pop-note">{t("taskSpend.tokens", { tokens: compact(tokens, locale) })}</span> : null}
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
  const kind = useRef<SpendKind | null>(null);
  const ownText = useRef<{ card: Box; boxes: Box[] } | null>(null);
  const bubbleId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) { kind.current = null; ownText.current = null; return; }
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
            const anchor = ref.current!.getBoundingClientRect();
            const board = card.closest<HTMLElement>("[data-kanban-board]")?.getBoundingClientRect();
            const seat = [...document.querySelectorAll<HTMLElement>("[data-kanban-seat]")].map(el => el.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
            const input = {
              viewport: { width: window.innerWidth, height: window.innerHeight }, card: card.getBoundingClientRect(), anchor,
              bounds: board, avoid: seat.filter(box => box.bottom <= anchor.top + 1 || box.top >= anchor.bottom - 1),
              /* Two providers can stand side by side; one has nothing to rearrange. */
              compactable: summary.providers.length > 1,
            };
            const sizeAt = (maxWidth: number, compact = false) => {
              setCompact(bubble, compact);
              bubble.style.maxWidth = `${maxWidth}px`;
              const box = bubble.getBoundingClientRect();
              return { width: box.width, height: box.height };
            };
            const candidates = spendCandidates(input, sizeAt);
            const outer = {
              left: Math.max(8, board?.left ?? 8), top: Math.max(8, board?.top ?? 8),
              right: Math.min(input.viewport.width - 8, board?.right ?? Infinity), bottom: Math.min(input.viewport.height - 8, board?.bottom ?? Infinity),
            };
            const frame = { card: input.card, area: clearOf(outer, anchor, input.avoid) };
            /* The covered text is measured once per opening; a scroll or resize keeps that choice. */
            if (!kind.current) {
              const text = windowTextBoxes(card, bubble);
              kind.current = chooseSpendPlacement(candidates, { ...text, anchor, keepOut: input.avoid }, frame)?.kind ?? "over";
              ownText.current = { card: input.card, boxes: [...text.own, ...text.ownTitle, ...text.ownState] };
            }
            const raw = candidates.find(c => c.kind === kind.current) ?? candidates[0];
            if (!raw) return null;
            /* The card's own text moves with the card: the lines it cut when the choice was made are cut again from the card's box now. */
            const measured = ownText.current;
            const shift = measured ? { x: input.card.left - measured.card.left, y: input.card.top - measured.card.top } : { x: 0, y: 0 };
            const lines = (measured?.boxes ?? []).map(b => ({ left: b.left + shift.x, right: b.right + shift.x, top: b.top + shift.y, bottom: b.bottom + shift.y }));
            const chosen = settleSpendPlacement(raw, lines, frame);
            setCompact(bubble, raw.kind.endsWith(COMPACT_SUFFIX));
            bubble.style.maxWidth = `${chosen.maxWidth}px`;
            const widened = chosen.width > raw.width + 0.5 ? chosen.width : undefined;
            const taller = chosen.height > raw.height + 0.5 ? chosen.height : undefined;
            if (widened) bubble.style.width = `${widened}px`;
            if (taller) bubble.style.minHeight = `${taller}px`;
            return { left: chosen.left, top: chosen.top, maxWidth: Math.max(chosen.maxWidth, chosen.width), width: widened, minHeight: taller };
          }}>
          <span data-spend-pop={taskId}>
            <span className="pop-title">
              {t("taskSpend.title")}
              {summary.providers.length > 1 ? <span className="pop-total"> · {t("taskSpend.tokens", { tokens: compact(summary.providers.reduce((sum, p) => sum + p.tokens, 0), locale) })}</span> : null}
            </span>
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
      <div className="phone-spend"><SpendLines summary={summary} total /></div>
    </section>
  );
}
