"use client";

import { useEffect, useRef, useState } from "react";

import { browserZone, clockText } from "@/components/activity/format";
import { OutputPreview } from "@/components/feed/cards/OutputPreview";
import { ChevronRight } from "@/components/icons";
import { StageGlyph } from "@/components/kanban/StageGlyph";
import { TooltipBubble } from "@/components/TooltipBubble";
import { humanizeDuration } from "@/components/turnDuration";
import { useNowSeconds } from "@/hooks/useNowSeconds";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

type Setup = NonNullable<PipelineStageAttempt["setup"]>;

/* A failure's tail is read without a click; wrapped in a narrow stage pane,
   eight long lines would push the conversation below out of view. */
const SETUP_TAIL_CHARS = 480;

/*
 * The project setup that ran before a Builder attempt: one line, a dot in the
 * outcome's tone and the outcome in words. A failure opens on its command and
 * the end of its output; a pass stays one closed line. When the setup started
 * and how long it took is the dot's popover, so the line says it once.
 */
export function StageSetupResult({ setup, worktreeDir, className = "" }: {
  setup: PipelineStageAttempt["setup"];
  worktreeDir: string | null;
  /** The host's spacing: the dot's popover opens above the line, into it. */
  className?: string;
}) {
  const { t } = useLocale();
  if (!setup) return null;
  const failed = setup.state === "failed";
  const words = failed && setup.code !== null ? t("projectSetup.failedExit", { code: setup.code }) : t(`projectSetup.${setup.state}`);
  const dir = relativeDir(setup.cwd, worktreeDir);
  const stderr = setup.stderr.trim() ? setup.stderr : "";
  const stdout = setup.stdout.trim() ? setup.stdout : "";
  const both = Boolean(stderr && stdout);
  return (
    /* `reader-host` keeps the board's button reset off the output's own controls, as in a conversation. */
    <div data-stage-setup={setup.state} className={`reader-host flex min-w-0 shrink-0 items-start gap-2 text-label leading-4 ${className}`}>
      <SetupDot setup={setup} />
      <details className="group min-w-0 flex-1" open={failed || undefined}>
        <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <span className={`min-w-0 break-words font-semibold ${failed ? "text-danger" : "text-secondary"}`}>{words}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        </summary>
        <div className="min-w-0 pb-1">
          <code className="block break-words [overflow-wrap:anywhere] font-mono text-[12px] text-primary" data-stage-setup-command>
            $ {setup.command.map(shellWord).join(" ")}
          </code>
          {dir ? <p className="mt-0.5 break-words [overflow-wrap:anywhere] text-muted">{t("projectSetup.inDir", { dir })}</p> : null}
          {stderr ? <OutputPreview output={stderr} truncated={false} tone="err" heading={both ? t("tools.stderr") : undefined}
            copyLabel={t("tools.copyStderr")} previewLines={8} previewChars={SETUP_TAIL_CHARS} from="end" /> : null}
          {stdout ? <OutputPreview output={stdout} truncated={false} heading={both ? t("tools.stdout") : undefined}
            previewLines={8} previewChars={SETUP_TAIL_CHARS} from="end" /> : null}
          {!stderr && !stdout && setup.state !== "running" ? <p className="mt-1 text-muted">{t("projectSetup.noOutput")}</p> : null}
        </div>
      </details>
    </div>
  );
}

/* While setup runs, its popover counts on a one-second clock; a finished
   setup's words never change, so it takes no clock. */
function SetupDot({ setup }: { setup: Setup }) {
  return setup.completedAt ? <SetupDotWords setup={setup} endMs={Date.parse(setup.completedAt)} /> : <LiveSetupDot setup={setup} />;
}

function LiveSetupDot({ setup }: { setup: Setup }) {
  return <SetupDotWords setup={setup} endMs={useNowSeconds(1000) * 1000} />;
}

/* The dot opens its one-line popover by hover, focus or tap, as a card's state
   dot does (CardStateDot). */
function SetupDotWords({ setup, endMs }: { setup: Setup; endMs: number }) {
  const { t, locale } = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const pressed = useRef(false);
  const [open, setOpen] = useState(false);
  const started = Date.parse(setup.startedAt);
  const time = Number.isFinite(started) ? clockText(started, locale, browserZone()) : "";
  const duration = humanizeDuration(Math.max(0, (endMs - started) / 1000), locale);
  const words = t(setup.completedAt ? "projectSetup.took" : "projectSetup.soFar", { time, duration });
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <span className="flex min-h-6 shrink-0 items-center pointer-coarse:min-h-11">
      <span
        ref={ref}
        className="relative flex rounded-full after:absolute after:-inset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-stage-setup-dot=""
        role="button"
        tabIndex={0}
        aria-label={`${t("projectSetup.title")}: ${words}`}
        aria-expanded={open}
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
        <StageGlyph state={setup.state} model={null} fallback="tone" />
        {open ? (
          <TooltipBubble anchorRef={ref} side="top" align="left" className="card-state-pop">
            <span data-stage-setup-pop="">{words}</span>
          </TooltipBubble>
        ) : null}
      </span>
    </span>
  );
}

/** One argument as a shell reads it: quoted only when it has to be. */
export function shellWord(arg: string): string {
  if (arg && !/[\s'"\\$`!*?#&;|<>(){}[\]~]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The working directory against the lane's checkout; null when it is the checkout itself. */
export function relativeDir(cwd: string, root: string | null): string | null {
  const trim = (value: string) => value.replace(/[\\/]+$/, "");
  const dir = trim(cwd), base = root ? trim(root) : "";
  if (base && dir === base) return null;
  if (base && (dir.startsWith(base + "/") || dir.startsWith(base + "\\"))) return dir.slice(base.length + 1);
  return dir || null;
}

/** The lane's most recent project setup, across its stages' attempts. */
export function latestSetup(pipeline: Pipeline): PipelineStageAttempt["setup"] {
  let latest: PipelineStageAttempt["setup"];
  for (const run of pipeline.runs) for (const attempt of run.attempts)
    if (attempt.setup && (!latest || Date.parse(attempt.setup.startedAt) >= Date.parse(latest.startedAt))) latest = attempt.setup;
  return latest;
}
