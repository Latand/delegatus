"use client";

import { Check, ChevronDown, Circle, Loader2, Minus, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { effortTierLabel } from "@/components/builderCopy";
import { requestAccountPanel } from "@/lib/accounts/openPanel";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { navigateToFragment } from "@/lib/navigation/fragmentNavigation";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { HealthFailure, HealthFailureCode, HealthRow, HealthRowId, HealthRun, HealthRuntime } from "@/lib/onboarding/healthCheck";

/**
 * Step 5 of the setup guide, "Check" (#1876, design §2.5 and §5): runs the
 * server's health check and shows its five rows. A failed row turns red and
 * opens in place with what happened, what to do, one action and the machine
 * detail; the rows after it stay waiting. Nothing here is gated on the result:
 * "Open the board" in the footer works whether the check ran or not.
 */

type Answer = { runtime: HealthRuntime | null; run: HealthRun | null };

const ROW_KEY: Record<HealthRowId, Parameters<TFunction>[0]> = {
  spawn: "onboarding.check.row.spawn",
  delivery: "onboarding.check.row.delivery",
  report: "onboarding.check.row.report",
  wake: "onboarding.check.row.wake",
  filing: "onboarding.check.row.filing",
};

/* "none": the fix is a local setting, so there is nothing to report or open. */
type Action = "engines" | "accounts" | "agent" | "copy" | "none";

const ACTION: Record<HealthFailureCode, Action> = {
  CLI_MISSING: "engines",
  ENGINE_NOT_CONNECTED: "engines",
  ACCOUNT_EXHAUSTED: "accounts",
  SPAWN_TIMEOUT: "agent",
  DELIVERY_FAILED: "copy",
  MCP_UNREACHABLE: "copy",
  REPORT_TIMEOUT: "agent",
  TICK_OFF: "none",
  WAKE_NOT_OWED: "copy",
  WAKE_UNDELIVERED: "copy",
  SEAT_MISFILED: "copy",
  SEAT_UNREADABLE: "copy",
  RUN_BOUND: "copy",
};

/* Failures whose only remedy is a bug report (design §5.2): the footer does
   not tell the user to fix what the copy says they cannot. None of them can be
   the check's first row, so the first-row footer keeps precedence. */
const REPORT_ONLY: ReadonlySet<HealthFailureCode> = new Set(["DELIVERY_FAILED", "WAKE_NOT_OWED", "WAKE_UNDELIVERED", "SEAT_UNREADABLE"]);

export function modelLabel(runtime: HealthRuntime): string {
  return ENGINE_MODELS[runtime.engine].find((model) => model.id === runtime.model)?.label ?? runtime.model;
}

/** The text "Copy details" puts on the clipboard: safe for a public issue,
    because the server already redacted the detail. */
export function healthCopyText(run: HealthRun, row: HealthRow): string {
  const found = row.failure!;
  return [
    `Viewer health check: ${found.code}`,
    `row: ${row.id}`,
    `detail: ${found.detail}`,
    `runtime: ${run.runtime.engine} ${run.runtime.model} ${run.runtime.effort}`,
    `viewer: ${run.version}`,
  ].join("\n");
}

/** A sentence with `command` spans, painted as inline code without the marks. */
export function withInlineCode(text: string): ReactNode {
  return text.split("`").map((part, index) => index % 2
    ? <code key={index} className="rounded-[4px] bg-sunken px-1 py-px font-mono text-[0.92em] font-normal">{part}</code>
    : <Fragment key={index}>{part}</Fragment>);
}

/** The reset time in the interface language: date and hour:minute. */
export function resetTime(iso: string | undefined, locale: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(at);
}

type Refusal = { reason: string; code: string | null };

async function readJson(response: Response): Promise<(Answer & { error?: string; code?: string }) | null> {
  try {
    return (await response.json()) as Answer & { error?: string; code?: string };
  } catch {
    return null;
  }
}

function useHealthCheck() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<Refusal | null>(null);
  const [loaded, setLoaded] = useState(false);
  const runId = answer?.run?.id ?? null;
  const settled = !answer?.run || (answer.run.state !== "running" && answer.run.cleanup.done);

  const read = useCallback(async function read(id: string | null): Promise<void> {
    try {
      const response = await fetch(`/api/onboarding/health${id ? `?run=${encodeURIComponent(id)}` : ""}`);
      const body = await readJson(response);
      if (response.ok && body) setAnswer(body);
      /* A Viewer that restarted mid-check has forgotten the run, and answers
         404 for its id for ever. Read again without it: the step falls back to
         what the server does know, and the poll stops instead of spinning on a
         run nothing will ever finish. Only a named run resets — a request that
         simply failed is retried by the next poll. */
      else if (response.status === 404 && id) await read(null);
    } catch {
      /* A missed poll is retried by the next one. */
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void read(null); }, [read]);
  useEffect(() => {
    if (settled || !runId) return;
    const id = setInterval(() => { void read(runId); }, 1_000);
    return () => clearInterval(id);
  }, [read, runId, settled]);

  const start = async () => {
    setError(null);
    try {
      const response = await fetch("/api/onboarding/health", { method: "POST" });
      const body = await readJson(response);
      if (body?.run) setAnswer(body);
      else setError({ reason: body?.error ?? `HTTP ${response.status}`, code: body?.code ?? null });
    } catch (reason) {
      setError({ reason: reason instanceof Error ? reason.message : String(reason), code: null });
    }
  };
  const stop = async () => {
    if (!runId) return;
    try {
      const response = await fetch(`/api/onboarding/health?run=${encodeURIComponent(runId)}`, { method: "DELETE" });
      const body = await readJson(response);
      if (body?.run) setAnswer(body);
    } catch {
      /* The poll shows whatever the server did. */
    }
  };
  return { answer, loaded, error, start, stop };
}

/** What a row shows: after Stop, a row that never ran is not waiting any more. */
type Shown = HealthRow["state"] | "notRun";

function RowGlyph({ state }: { state: Shown }) {
  const className = "h-4 w-4 shrink-0";
  if (state === "running") return <Loader2 className={`${className} animate-spin text-accent`} aria-hidden />;
  if (state === "passed") return <Check className={`${className} text-success`} aria-hidden />;
  if (state === "failed") return <X className={`${className} text-danger`} aria-hidden />;
  if (state === "skipped" || state === "notRun") return <Minus className={`${className} text-muted`} aria-hidden />;
  return <Circle className={`${className} text-muted`} aria-hidden />;
}

function elapsedSeconds(row: HealthRow, now: number): number | null {
  if (!row.startedAt) return null;
  const end = row.finishedAt ? Date.parse(row.finishedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(row.startedAt)) / 1000));
}

function FailureBlock({ run, row, onGoEngines, onLeave, onDetailsOpen }: { run: HealthRun; row: HealthRow; onGoEngines: () => void; onLeave: () => void; onDetailsOpen: () => void }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /* The detail block opens above the controls and can push them below the
     dialog's fold: scrolling the controls into view brings the whole tail up,
     the opened detail included. */
  useEffect(() => { if (open) onDetailsOpen(); }, [open, onDetailsOpen]);
  const found = row.failure as HealthFailure;
  const params = { ...found.params, time: resetTime(found.params.time, locale) };
  const action = ACTION[found.code];
  /* A sentence that says "open the agent" only beside a button that does. */
  const todoKey = action === "agent" && !found.agentPath ? "todoNoAgent" : "todo";
  const button = "inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-full";
  const act = () => {
    if (action === "engines" || (action === "accounts" && !found.accountId)) { onGoEngines(); return; }
    if (action === "accounts") {
      onLeave();
      requestAccountPanel(run.runtime.engine, found.accountId!);
      return;
    }
    if (action === "agent" && found.agentPath) {
      onLeave();
      navigateToFragment(`#f=${encodeURIComponent(found.agentPath)}`);
      return;
    }
    void navigator.clipboard?.writeText(healthCopyText(run, row)).then(() => setCopied(true), () => setCopied(false));
  };
  /* "Open the agent" with no agent to open falls back to copying the details. */
  const label = action === "engines" ? t("onboarding.check.action.engines")
    : action === "accounts" ? (found.accountId ? t("onboarding.check.action.accounts") : t("onboarding.check.action.engines"))
      : action === "agent" && found.agentPath ? t("onboarding.check.action.agent")
        : copied ? t("onboarding.check.copied") : t("onboarding.check.action.copy");
  return (
    <div data-health-failure={found.code} className="mt-2 rounded-[8px] bg-danger-soft p-3">
      <p className="text-body leading-[1.45] text-primary">{withInlineCode(t(`onboarding.check.code.${found.code}.happened` as Parameters<TFunction>[0], params))}</p>
      <p className="mt-2 text-body font-semibold leading-[1.45] text-primary">
        <span className="sr-only">{t("onboarding.check.whatToDo")}: </span>
        {withInlineCode(t(`onboarding.check.code.${found.code}.${todoKey}` as Parameters<TFunction>[0], params))}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {action === "none" ? null : <button type="button" data-health-action={action} onClick={act} className={button}>{label}</button>}
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          {open ? t("onboarding.check.hideDetails") : t("onboarding.check.showDetails")}
        </button>
      </div>
      {open ? <pre data-health-details="" className="mt-2 whitespace-pre-wrap break-words rounded-[8px] bg-sunken p-2 font-mono text-label text-secondary">{healthCopyText(run, row)}</pre> : null}
    </div>
  );
}

/** Which closing line a failure gets: the first row has no rows before it, and
    a failure the user cannot fix is not asked to be fixed. */
function failedFooterKey(failedRow: HealthRow, run: HealthRun): Parameters<TFunction>[0] {
  /* The whole-run bound belongs to the run, not to the row it happened to
     stop, and it can stop any row — the first one included. */
  if (failedRow.failure?.code === "RUN_BOUND") return "onboarding.check.failedFooterBound";
  if (failedRow.id === run.rows[0]?.id) return "onboarding.check.failedFooterFirst";
  if (failedRow.failure && REPORT_ONLY.has(failedRow.failure.code)) return "onboarding.check.failedFooterReport";
  return "onboarding.check.failedFooter";
}

export function CheckStep({ noEngine, onGoEngines, onLeave, onSkip, onOwnsPrimary }: {
  /** No engine connected, as the Engines step reads it. */
  noEngine: boolean;
  onGoEngines: () => void;
  /** Close the guide, for an action that opens something beneath it. */
  onLeave: () => void;
  /** "Skip the check": the step is marked skipped and the guide finishes. */
  onSkip: () => void;
  /** Whether the footer's "Open the board" steps back to a bordered button:
      while the check is still to run, running, or failed, the accent belongs to
      this step (and to nothing at all while it runs). */
  onOwnsPrimary?: (owns: boolean) => void;
}) {
  const { t } = useLocale();
  const { answer, loaded, error, start, stop } = useHealthCheck();
  const [now, setNow] = useState(() => Date.now());
  const run = answer?.run ?? null;
  const running = run?.state === "running";
  const cleaning = Boolean(run && run.state !== "running" && !run.cleanup.done);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!running) return;
    tick.current = setInterval(() => setNow(Date.now()), 1_000);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [running]);

  const showControls = useCallback(() => { controls.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  const failedRow = run?.rows.find((row) => row.state === "failed") ?? null;
  const failedAt = failedRow ? `${run!.id}:${failedRow.id}` : null;
  /* A failure can open below the dialog's fold; the button that runs the check again stays in view. */
  useEffect(() => { if (failedAt) controls.current?.scrollIntoView?.({ block: "nearest" }); }, [failedAt]);

  const runtime = run?.runtime ?? answer?.runtime ?? null;
  const noEngineShown = loaded && !runtime && !run && noEngine;
  /* One accent per screen at most: Run the check / Run it again holds it until
     the check passes, and while the run is in progress nothing is filled — the
     brightest control on a two-minute wait would otherwise be the one that
     leaves the step. */
  const ownsPrimary = !noEngineShown && run?.state !== "passed";
  useEffect(() => { onOwnsPrimary?.(ownsPrimary); }, [ownsPrimary, onOwnsPrimary]);
  useEffect(() => () => onOwnsPrimary?.(false), [onOwnsPrimary]);
  const lead = runtime
    ? t("onboarding.check.lead", { model: modelLabel(runtime), effort: effortTierLabel(t, runtime.effort) })
    : null;
  const primary = "inline-flex h-8 items-center justify-center rounded-[8px] bg-brand px-4 text-ui font-semibold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:h-11 max-sm:flex-1";
  const secondary = "inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:h-11 max-sm:flex-1";

  if (noEngineShown) {
    return (
      <div data-health-check="no-engine">
        <p className="text-body leading-[1.45] text-secondary">{t("onboarding.check.noEngine")}</p>
        <button type="button" onClick={onGoEngines} className={`${secondary} mt-4`}>{t("onboarding.check.goEnginesStep")}</button>
      </div>
    );
  }

  return (
    <div data-health-check={run?.state ?? "idle"}>
      {lead ? <p data-health-lead="" className="text-body leading-[1.45] text-secondary">{lead}</p> : null}
      <ol className="mt-4 flex flex-col">
        {(run?.rows ?? (["spawn", "delivery", "report", "wake", "filing"] as const).map((id) => ({ id, state: "waiting" as const, startedAt: null, finishedAt: null, failure: null, note: null }))).map((row) => {
          const seconds = elapsedSeconds(row, now);
          const shown: Shown = run?.state === "stopped" && row.state === "waiting" ? "notRun" : row.state;
          return (
            <li key={row.id} data-health-row={row.id} data-health-state={shown} className="border-b border-border py-2.5 last:border-b-0">
              <div className="flex min-h-7 items-center gap-3 max-sm:flex-wrap">
                <RowGlyph state={shown} />
                <span className="min-w-0 flex-1 text-body leading-[1.45] text-primary">
                  {t(ROW_KEY[row.id])}
                  <span className="sr-only">: {t(`onboarding.check.state.${shown}` as Parameters<TFunction>[0])}</span>
                </span>
                {row.state === "skipped" && row.note === "no-seat"
                  /* A sentence where the other rows carry one word: on a phone it
                     drops to its own line under the label, so the longest label
                     stays at one line and the row at two. */
                  ? <span data-health-note="" className="text-label text-muted max-sm:order-1 max-sm:w-full max-sm:pl-7">{t("onboarding.check.noSeat")}</span>
                  : <span className={`shrink-0 text-label font-semibold ${shown === "failed" ? "text-danger" : "text-muted"}`}>{t(`onboarding.check.state.${shown}` as Parameters<TFunction>[0])}</span>}
                {/* The empty time column keeps the times aligned on a desktop;
                    on a phone it is 52 px the longest label needs. */}
                {seconds !== null ? <span className="w-10 shrink-0 text-right text-label tabular-nums text-muted">{t("onboarding.check.seconds", { seconds })}</span> : <span className="w-10 shrink-0 max-sm:hidden" />}
              </div>
              {row.state === "failed" && row.failure && run ? <FailureBlock run={run} row={row} onGoEngines={onGoEngines} onLeave={onLeave} onDetailsOpen={showControls} /> : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-col gap-3">
        {run?.state === "passed" ? <p data-health-summary="passed" className="text-body font-semibold text-success">{t("onboarding.check.allPassed")}</p> : null}
        {failedRow ? <p data-health-summary="failed" className="text-body leading-[1.45] text-secondary">{t(failedFooterKey(failedRow, run!), { row: t(ROW_KEY[failedRow.id]) })}</p> : null}
        {run?.state === "stopped" && run.cleanup.done ? <p data-health-summary="stopped" className="text-body leading-[1.45] text-secondary">{t("onboarding.check.stopped")}</p> : null}
        {cleaning ? <p data-health-cleaning="" className="text-body leading-[1.45] text-muted">{t("onboarding.check.cleaning")}</p> : null}
        {run?.cleanup.done && run.cleanup.problems.length ? <p data-health-cleanup-problem="" className="text-label leading-[1.45] text-warning">{t("onboarding.check.cleanupProblem", { problems: run.cleanup.problems.join("; ") })}</p> : null}
        {/* A refusal the step has its own sentence for is written in the
            interface language; anything else quotes what the server said. */}
        {error ? <p data-health-start-failed="" className="text-label leading-[1.45] text-danger">{error.code === "NO_ENGINE" ? t("onboarding.check.noEngine") : t("onboarding.check.startFailed", { reason: error.reason })}</p> : null}
        <div ref={controls} className="flex flex-wrap gap-2">
          {running
            ? <button type="button" data-health-stop="" onClick={() => void stop()} className={secondary}>{t("onboarding.check.stop")}</button>
            : <button type="button" data-health-start="" disabled={cleaning || !loaded} onClick={() => void start()} className={ownsPrimary ? primary : secondary}>{run ? t("onboarding.check.again") : t("onboarding.check.start")}</button>}
          {!run ? <button type="button" data-health-skip="" onClick={onSkip} className="inline-flex h-8 items-center justify-center rounded-[8px] px-3 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1">{t("onboarding.check.skip")}</button> : null}
        </div>
      </div>
    </div>
  );
}
