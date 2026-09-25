"use client";

import { useState, type Ref } from "react";

import { AgentLaunchControls, launchEngineLabel, type AgentLaunchDraft } from "@/components/draft/AgentLaunchControls";
import { EngineMark } from "@/components/EngineMark";
import { ENGINE_MODELS, modelDisplayName } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

/** "Claude · Opus 5.5 · high effort · account Main": what the draft will run
    on, in the order the pickers set it. The effort and the account are left
    out while the launch takes the CLI's own (no effort chosen, no catalog). */
export function runsOnValue(draft: AgentLaunchDraft, t: ReturnType<typeof useLocale>["t"]): string {
  const account = draft.accounts.find((entry) => entry.id === draft.launchAccountId) ?? null;
  return [
    launchEngineLabel(draft.engine),
    /* The picker's own label for the alias it launches ("opus" is Opus 5.5). */
    ENGINE_MODELS[draft.engine].find((option) => option.id === draft.model)?.label ?? modelDisplayName(draft.engine, draft.model),
    draft.effort ? t("orchPanel.runsOnEffort", { effort: draft.effort }) : null,
    account ? t("orchPanel.runsOnAccount", { label: account.label }) : null,
  ].filter(Boolean).join(" · ");
}

/**
 * The create draft's one "Runs on" row (#2166 §3.7): the runtime the
 * orchestrator starts on, said in one line, with Change opening the shared
 * launch controls in place. The pickers used to stand open and stacked above
 * the button, which is what made the draft read like a form before it read
 * like an offer.
 *
 * `phone` is the sheet's card: label, value and a 44 px Change on their own
 * lines, the controls stacked at touch size. The desktop is one row with the
 * working directory at its right end.
 */
export function RunsOnRow({
  draft,
  disabled,
  cwd,
  phone = false,
  revealRef,
}: {
  draft: AgentLaunchDraft;
  disabled?: boolean;
  /** The desktop row ends with it; the phone says it under the rules. */
  cwd?: string;
  phone?: boolean;
  /** The setup guide's hand-off scrolls this block into view. */
  revealRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const change = (
    <button
      type="button"
      data-orchestrator-runs-on-change
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
      className={`shrink-0 rounded-control text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${phone ? "inline-flex min-h-11 items-center self-start" : ""}`}
    >
      {t(open ? "orchPanel.runsOnDone" : "orchPanel.runsOnChange")}
    </button>
  );
  const value = (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ui text-primary" data-orchestrator-runs-on-value>
      <EngineMark engine={draft.engine} size={12} />
      <span className={phone ? "min-w-0" : "min-w-0 truncate"}>{runsOnValue(draft, t)}</span>
    </span>
  );
  return (
    <div
      ref={revealRef}
      className={`flex shrink-0 flex-col rounded-control border border-border px-3 py-2 ${phone ? "gap-1 bg-card" : "gap-2 bg-canvas"}`}
      data-orchestrator-launch-choices
      data-orchestrator-runs-on
    >
      {phone ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-label font-semibold text-muted">{t("orchPanel.runsOn")}</span>
          {value}
          {change}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="shrink-0 text-label font-semibold text-muted">{t("orchPanel.runsOn")}</span>
          {value}
          {change}
          {cwd ? (
            <span className="ml-auto min-w-0 truncate font-mono text-caption text-muted" title={cwd} data-orchestrator-cwd>
              {t("orchPanel.cwd", { cwd })}
            </span>
          ) : null}
        </div>
      )}
      {open ? (
        <div className={`border-t border-border pt-2 ${phone ? "[&_button]:min-h-11 [&_select]:min-h-11" : ""}`}>
          <AgentLaunchControls draft={draft} disabled={disabled} stacked={phone} />
        </div>
      ) : null}
    </div>
  );
}
