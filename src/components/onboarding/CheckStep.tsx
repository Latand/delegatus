"use client";

import { Check, ChevronDown, Circle, Loader2, Minus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestAccountPanel } from "@/lib/accounts/openPanel";
import { ENGINE_MODELS } from "@/lib/agent/models";
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

type Action = "engines" | "accounts" | "agent" | "copy";

const ACTION: Record<HealthFailureCode, Action> = {
  CLI_MISSING: "engines",
  ENGINE_NOT_CONNECTED: "engines",
  ACCOUNT_EXHAUSTED: "accounts",
  SPAWN_TIMEOUT: "agent",
  DELIVERY_FAILED: "copy",
  MCP_UNREACHABLE: "copy",
  REPORT_TIMEOUT: "agent",
  TICK_OFF: "copy",
  WAKE_NOT_OWED: "copy",
  WAKE_UNDELIVERED: "copy",
  SEAT_MISFILED: "copy",
};

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

async function readJson(response: Response): Promise<(Answer & { error?: string }) | null> {
  try {
    return (await response.json()) as Answer & { error?: string };
  } catch {
    return null;
  }
}

function useHealthCheck() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const runId = answer?.run?.id ?? null;
  const settled = !answer?.run || (answer.run.state !== "running" && answer.run.cleanup.done);

  const read = useCallback(async (id: string | null) => {
    try {
      const response = await fetch(`/api/onboarding/health${id ? `?run=${encodeURIComponent(id)}` : ""}`);
      const body = await readJson(response);
      if (response.ok && body) setAnswer(body);
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
      else setError(body?.error ?? `HTTP ${response.status}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

function RowGlyph({ state }: { state: HealthRow["state"] }) {
  const className = "h-4 w-4 shrink-0";
  if (state === "running") return <Loader2 className={`${className} animate-spin text-accent`} aria-hidden />;
  if (state === "passed") return <Check className={`${className} text-success`} aria-hidden />;
  if (state === "failed") return <X className={`${className} text-danger`} aria-hidden />;
  if (state === "skipped") return <Minus className={`${className} text-muted`} aria-hidden />;
  return <Circle className={`${className} text-muted`} aria-hidden />;
}

function elapsedSeconds(row: HealthRow, now: number): number | null {
  if (!row.startedAt) return null;
  const end = row.finishedAt ? Date.parse(row.finishedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(row.startedAt)) / 1000));
}

function FailureBlock({ run, row, onGoEngines, onLeave }: { run: HealthRun; row: HealthRow; onGoEngines: () => void; onLeave: () => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const found = row.failure as HealthFailure;
  const params = { ...found.params, time: found.params.time ? new Date(found.params.time).toLocaleString() : "—" };
  const action = ACTION[found.code];
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
      window.location.hash = `#f=${encodeURIComponent(found.agentPath)}`;
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
      <p className="text-body leading-[1.45] text-primary">{t(`onboarding.check.code.${found.code}.happened` as Parameters<TFunction>[0], params)}</p>
      <p className="mt-2 text-body font-semibold leading-[1.45] text-primary">
        <span className="sr-only">{t("onboarding.check.whatToDo")}: </span>
        {t(`onboarding.check.code.${found.code}.todo` as Parameters<TFunction>[0], params)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" data-health-action={action} onClick={act} className={button}>{label}</button>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          {open ? t("onboarding.check.hideDetails") : t("onboarding.check.showDetails")}
        </button>
      </div>
      {open ? <pre data-health-details="" className="mt-2 whitespace-pre-wrap break-words rounded-[8px] bg-sunken p-2 font-mono text-label text-secondary">{healthCopyText(run, row)}</pre> : null}
    </div>
  );
}

export function CheckStep({ noEngine, onGoEngines, onLeave, onSkip }: {
  /** No engine connected, as the Engines step reads it. */
  noEngine: boolean;
  onGoEngines: () => void;
  /** Close the guide, for an action that opens something beneath it. */
  onLeave: () => void;
  /** "Skip the check": the step is marked skipped and the guide finishes. */
  onSkip: () => void;
}) {
  const { t } = useLocale();
  const { answer, loaded, error, start, stop } = useHealthCheck();
  const [now, setNow] = useState(() => Date.now());
  const run = answer?.run ?? null;
  const running = run?.state === "running";
  const cleaning = Boolean(run && run.state !== "running" && !run.cleanup.done);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!running) return;
    tick.current = setInterval(() => setNow(Date.now()), 1_000);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [running]);

  const runtime = run?.runtime ?? answer?.runtime ?? null;
  const lead = runtime
    ? t("onboarding.check.lead", { model: modelLabel(runtime), effort: runtime.effort })
    : null;
  const primary = "inline-flex h-8 items-center justify-center rounded-[8px] bg-accent px-4 text-ui font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 max-sm:h-11 max-sm:flex-1";
  const secondary = "inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-3.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1";

  if (loaded && !runtime && !run && noEngine) {
    return (
      <div data-health-check="no-engine">
        <p className="text-body leading-[1.45] text-secondary">{t("onboarding.check.noEngine")}</p>
        <button type="button" onClick={onGoEngines} className={`${secondary} mt-4`}>{t("onboarding.check.goEnginesStep")}</button>
      </div>
    );
  }

  const failedRow = run?.rows.find((row) => row.state === "failed") ?? null;
  return (
    <div data-health-check={run?.state ?? "idle"}>
      {lead ? <p data-health-lead="" className="text-body leading-[1.45] text-secondary">{lead}</p> : null}
      <ol className="mt-4 flex flex-col">
        {(run?.rows ?? (["spawn", "delivery", "report", "wake", "filing"] as const).map((id) => ({ id, state: "waiting" as const, startedAt: null, finishedAt: null, failure: null, note: null }))).map((row) => {
          const seconds = elapsedSeconds(row, now);
          return (
            <li key={row.id} data-health-row={row.id} data-health-state={row.state} className="border-b border-border py-2.5 last:border-b-0">
              <div className="flex min-h-7 items-center gap-3">
                <RowGlyph state={row.state} />
                <span className="min-w-0 flex-1 text-body leading-[1.45] text-primary">
                  {t(ROW_KEY[row.id])}
                  <span className="sr-only">: {t(`onboarding.check.state.${row.state}` as Parameters<TFunction>[0])}</span>
                </span>
                {row.state === "skipped" && row.note === "no-seat"
                  ? <span className="text-label text-muted">{t("onboarding.check.noSeat")}</span>
                  : <span className="shrink-0 text-label font-semibold text-muted">{t(`onboarding.check.state.${row.state}` as Parameters<TFunction>[0])}</span>}
                {seconds !== null ? <span className="w-10 shrink-0 text-right text-label tabular-nums text-muted">{t("onboarding.check.seconds", { seconds })}</span> : <span className="w-10 shrink-0" />}
              </div>
              {row.state === "failed" && row.failure && run ? <FailureBlock run={run} row={row} onGoEngines={onGoEngines} onLeave={onLeave} /> : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-col gap-3">
        {run?.state === "passed" ? <p data-health-summary="passed" className="text-body font-semibold text-success">{t("onboarding.check.allPassed")}</p> : null}
        {failedRow ? <p data-health-summary="failed" className="text-body leading-[1.45] text-secondary">{t("onboarding.check.failedFooter", { row: t(ROW_KEY[failedRow.id]) })}</p> : null}
        {run?.state === "stopped" && run.cleanup.done ? <p data-health-summary="stopped" className="text-body leading-[1.45] text-secondary">{t("onboarding.check.stopped")}</p> : null}
        {cleaning ? <p className="text-body leading-[1.45] text-muted">{t("onboarding.check.cleaning")}</p> : null}
        {run?.cleanup.done && run.cleanup.problems.length ? <p data-health-cleanup-problem="" className="text-label leading-[1.45] text-warning">{t("onboarding.check.cleanupProblem", { problems: run.cleanup.problems.join("; ") })}</p> : null}
        {error ? <p className="text-label leading-[1.45] text-danger">{t("onboarding.check.startFailed", { reason: error })}</p> : null}
        <div className="flex flex-wrap gap-2">
          {running
            ? <button type="button" data-health-stop="" onClick={() => void stop()} className={secondary}>{t("onboarding.check.stop")}</button>
            : <button type="button" data-health-start="" disabled={cleaning || !loaded} onClick={() => void start()} className={primary}>{run ? t("onboarding.check.again") : t("onboarding.check.start")}</button>}
          {!run ? <button type="button" data-health-skip="" onClick={onSkip} className="inline-flex h-8 items-center justify-center rounded-[8px] px-3 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1">{t("onboarding.check.skip")}</button> : null}
        </div>
      </div>
    </div>
  );
}
