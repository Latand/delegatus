"use client";

import { useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/core";
import type { WorktreeBackfillReport } from "@/lib/projects/worktreeBackfill";

export function WorktreeRecovery({ project, phone = false }: { project: string; phone?: boolean }) {
  const { t } = useLocale();
  const [report, setReport] = useState<WorktreeBackfillReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (dryRun: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/board/maintenance/worktrees", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, ...(/^repo-[0-9a-f]{32}$/.test(project) ? { project } : {}) }),
      });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.folded) || !Array.isArray(result.leftAlone)) throw new Error("recovery unavailable");
      setReport(result);
      if (!dryRun) window.dispatchEvent(new CustomEvent("llv:files-changed"));
    } catch { setFailed(true); setReport(null); }
    finally { setBusy(false); }
  };
  const button = `rounded-control border border-border px-2 text-ui disabled:opacity-50 ${phone ? "min-h-11" : "min-h-8"}`;
  return (
    <div data-worktree-recovery className="flex min-w-0 flex-col gap-2 border-t border-border pt-2">
      <p className="text-ui font-medium">{t("worktreeRecovery.title")}</p>
      <p className="text-caption text-secondary">{t("worktreeRecovery.about")}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={button} onClick={() => void run(true)}>{t("worktreeRecovery.preview")}</button>
        {report?.dryRun && report.folded.length > 0 ? <button type="button" disabled={busy} className={button} onClick={() => void run(false)}>{t("worktreeRecovery.apply")}</button> : null}
      </div>
      {failed ? <p role="alert" className="text-caption text-danger">{t("worktreeRecovery.failed")}</p> : null}
      {report ? <div role="status" className="text-caption leading-4">
        <p>{t(report.dryRun ? "worktreeRecovery.planned" : "worktreeRecovery.done", { folded: report.folded.length, left: report.leftAlone.length })}</p>
        <details className="mt-1">
          <summary>{t("worktreeRecovery.details")}</summary>
          <ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto">
            {[...report.folded, ...report.leftAlone].map((item) => <li key={item.cwd} className="break-words">
              {item.cwd.split(/[\\/]/).filter(Boolean).pop()} · {t(`worktreeRecovery.reason.${item.reason}` as MessageKey)}
            </li>)}
          </ul>
        </details>
      </div> : null}
    </div>
  );
}
