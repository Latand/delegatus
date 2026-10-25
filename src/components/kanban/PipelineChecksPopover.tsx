"use client";

import { useLayoutEffect, useRef } from "react";

import { useLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import { BOARD_CHECK_TERMS, checkChoiceGroups, checkValueLabel, publishingStage, usePipelineChecks } from "@/components/pipelines/PipelineCheckSettings";

import { KanbanPopover } from "./kanbanMenus";

/*
 * Where a lane's heavy checks run (docs/design/cloud-checks.md), opened from
 * the lane's ⋯ by its «Checks» row over the same anchor, the way a stage's
 * «Choose account» opens its picker. It reads the choices when it opens; a
 * read still out and a read that failed show no choice. A pick stays open and
 * draws the route's answer; a refused write keeps the last answer and says so.
 */
export function PipelineChecksPopover({ anchor, onClose, pipeline, stageName }: {
  anchor: HTMLElement;
  onClose: (refocus: boolean) => void;
  pipeline: Pipeline;
  /** The publishing stage as the board names it; null when the lane stands on none. */
  stageName: string | null;
}) {
  const { t } = useLocale();
  const checks = usePipelineChecks(pipeline.id, publishingStage(pipeline), true);
  const { read } = checks;
  const body = useRef<HTMLDivElement>(null);
  /* Nothing to focus while the read is out: the checked choice (or Retry)
     takes focus when the answer arrives, unless focus already moved inside. */
  useLayoutEffect(() => {
    if (read.kind === "loading") return;
    const box = body.current;
    if (!box || box.contains(document.activeElement)) return;
    box.querySelector<HTMLElement>('[data-pipeline-checks-choice][aria-checked="true"], [data-pipeline-checks-retry]')?.focus();
  }, [read.kind]);
  const label = t("pipelineStrip.checks");
  const value = read.kind === "ready" ? checkValueLabel(t, read.settings.effective) : read.kind === "loading" ? t("pipelineStrip.checksLoading") : null;
  return (
    <KanbanPopover anchor={anchor} label={label} onClose={onClose} className="acct-pop" reflow={`${read.kind} ${checks.saveFailed}`}>
      <div
        ref={body}
        data-pipeline-checks={pipeline.id}
        style={{ display: "contents" }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const items = [...(body.current?.querySelectorAll<HTMLElement>("[data-pipeline-checks-choice]") ?? [])];
          const index = items.indexOf(document.activeElement as HTMLElement);
          if (index < 0) return;
          event.preventDefault();
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }}
      >
        <div className="head"><span>{label}</span></div>
        <div className="acct-now">
          <div className="kv">
            <span className="k">{label}</span>
            {value !== null
              ? <span className="v" data-pipeline-checks-row={read.kind} aria-label={t("pipelineStrip.checksAria", { value })} aria-busy={read.kind === "loading" || undefined}>{value}</span>
              : <span className="v error" role="alert" data-pipeline-checks-row="failed" data-pipeline-checks-error="load">{t("pipelineStrip.checksLoadFailed")}</span>}
            {read.kind === "failed" ? (
              <button type="button" className="btn quiet" data-pipeline-checks-retry="" onClick={checks.reload}>{t("pipelineStrip.checksRetry")}</button>
            ) : null}
          </div>
        </div>
        {read.kind === "ready" ? checkChoiceGroups(t, BOARD_CHECK_TERMS, read.settings, stageName).map((group) => (
          <div key={group.scope} data-pipeline-checks-group={group.scope} style={{ display: "contents" }}>
            <div id={`checks-${pipeline.id}-${group.scope}`} className="acct-lbl" title={group.heading}>{group.heading}</div>
            <div className="acct-list" role="radiogroup" aria-labelledby={`checks-${pipeline.id}-${group.scope}`}>
              {group.choices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  role="radio"
                  className={`acct-row${choice.checked ? " current" : ""}`}
                  aria-checked={choice.checked}
                  aria-disabled={checks.saving || undefined}
                  data-pipeline-checks-choice={`${group.scope}:${choice.key}`}
                  onClick={() => { if (!choice.checked && !checks.saving) void checks.save(group.scope, choice.execution); }}
                >
                  <span className="nm">{choice.label}</span>
                </button>
              ))}
            </div>
          </div>
        )) : null}
        {checks.saveFailed ? <p role="alert" className="note error" data-pipeline-checks-error="save">{t("pipelineStrip.checksSaveFailed")}</p> : null}
      </div>
    </KanbanPopover>
  );
}
