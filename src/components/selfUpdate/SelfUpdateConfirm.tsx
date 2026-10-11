"use client";

import { Bot, Radar, RotateCw, Workflow } from "lucide-react";
import { useEffect } from "react";

import { BUTTON, TeamDialog } from "@/components/team/ui";
import { useLocale } from "@/lib/i18n";
import type { Snapshot } from "@/lib/selfUpdate/types";

import { groupWorkRows, useBlockerNames, wantBlockerNames, workNamesWanted, workRows, type WorkRow } from "./blockerNames";

/**
 * The question before an update restarts Delegatus (docs/design/self-update-confirm.md,
 * variant 1): what happens, then the work running now, grouped by project
 * and named by its card and its role, said once to resume after the restart.
 * Centred on the desktop and a bottom sheet on the phone, with the buttons
 * pinned to the bottom so a long list scrolls under them. The list is display
 * only: «Update now» runs the action as before, and the server reads its own
 * fresh admission.
 */

const ERROR_LINE = "m-0 rounded-[8px] bg-danger-soft px-2.5 py-2 text-ui text-danger [overflow-wrap:anywhere]";

function KindIcon({ kind }: { kind: WorkRow["kind"] }) {
  const Icon = kind === "stage" ? Workflow : kind === "seat" ? Radar : Bot;
  return <Icon className="mt-[3px] h-4 w-4 shrink-0 text-muted" aria-hidden />;
}

export function SelfUpdateConfirm({ snapshot: s, title, onConfirm, onCancel }: { snapshot: Snapshot; title: string; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useLocale();
  const names = useBlockerNames();
  const evidence = s.workEvidence;
  const work = s.resumeWork;
  /* Work not read yet is never "no work": pending and unreadable say so. */
  const known = evidence?.state !== "pending" && evidence?.state !== "unavailable" && Boolean(work) && !work?.unreadable;
  const listed = known ? work : null;
  useEffect(() => {
    wantBlockerNames(workNamesWanted(listed));
  }, [listed]);
  useEffect(() => () => wantBlockerNames(workNamesWanted(null)), []);
  const rows = workRows(listed, names, t);
  const groups = groupWorkRows(rows);
  /* The server caps each list at 20; what it counted beyond is said, not
     dropped, and a reading that sent counts with no list says the counts. */
  const more = listed ? Math.max(0, listed.stages - (listed.stageList?.length ?? 0)) + Math.max(0, listed.turns - (listed.turnList?.length ?? 0)) : 0;
  const total = rows.length + more;

  let body;
  if (evidence?.state === "pending") {
    body = (
      <p data-confirm-work="pending" className="m-0 flex items-start gap-2 rounded-[8px] bg-sunken px-2.5 py-2 text-ui text-secondary">
        <RotateCw className="mt-[3px] h-3.5 w-3.5 shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-hidden />
        <span>{t("selfUpdate.confirmApply.pending")}</span>
      </p>
    );
  } else if (!known) {
    const detail = evidence?.error ?? work?.unreadable ?? "";
    body = <p data-confirm-work="unavailable" role="alert" className={ERROR_LINE}>{t("selfUpdate.confirmApply.unavailable", { detail })}</p>;
  } else if (!total) {
    body = <p data-confirm-work="idle" className="m-0 text-ui text-secondary">{t("selfUpdate.confirmApply.idle")}</p>;
  } else {
    body = (
      <section data-confirm-work="ready" className="flex flex-col gap-1.5">
        {/* Every item resumes the same way, so it is said once for the list. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="m-0 flex items-center gap-1.5 text-label font-semibold text-secondary">
            {t("selfUpdate.confirmApply.runningNow")}<span data-confirm-count="" className="text-caption tabular-nums text-muted">{total}</span>
          </h3>
          <span className="inline-flex items-center gap-1 rounded-[6px] bg-success-soft px-1.5 py-0.5 text-caption font-semibold text-success">
            <RotateCw className="h-3 w-3" aria-hidden />{t("selfUpdate.confirmApply.resumes")}
          </span>
        </div>
        <div data-confirm-list="" className="rounded-[10px] border border-border bg-canvas">
          {groups.map((group) => (
            <div key={group.project ?? ""} data-confirm-group="" className="[&+&]:border-t [&+&]:border-border">
              <p data-confirm-project="" className={`m-0 px-3 pb-0.5 pt-2 text-label font-semibold ${group.project === null ? "italic text-muted" : "text-primary"}`}>
                {group.project ?? t("dash.projectUnnamed")}
              </p>
              <ul className="m-0 list-none p-0">
                {group.rows.map((row) => (
                  <li key={row.key} data-confirm-row={row.kind} className="flex items-start gap-2.5 px-3 py-2">
                    <KindIcon kind={row.kind} />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 line-clamp-2 text-ui font-semibold leading-snug text-primary [overflow-wrap:anywhere]">{row.title}</p>
                      {row.who ? <p className="m-0 truncate text-label text-secondary">{row.who}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {more ? (
            <p data-confirm-more="" className={`m-0 px-3 py-2 text-label text-muted ${rows.length ? "border-t border-border" : ""}`}>
              {rows.length ? t("selfUpdate.confirmApply.more", { count: more })
                : [t("selfUpdate.auto.block.turns", { count: listed!.turns }), t("selfUpdate.auto.block.stages", { count: listed!.stages })].join(" · ")}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <TeamDialog title={title} onClose={onCancel} closeLabel={t("common.cancel")} testId="self-update-confirm">
      <div className="flex flex-col gap-4">
        <p className="m-0 text-ui leading-relaxed text-secondary">{t("selfUpdate.confirmApply.consequence")}</p>
        {body}
        {/* The dialog's one scroller keeps the buttons on its bottom edge. */}
        <div data-confirm-buttons="" className="sticky bottom-[-16px] z-[1] -mx-4 -mb-4 flex justify-end gap-2 border-t border-border bg-card px-4 py-3 max-sm:flex-col-reverse max-sm:pb-[max(12px,env(safe-area-inset-bottom))]">
          <button type="button" data-action="cancel-apply" onClick={onCancel} className={BUTTON.secondary}>{t("common.cancel")}</button>
          <button type="button" data-action="confirm-apply" onClick={onConfirm} className={BUTTON.primary}>{t("selfUpdate.confirmApply.go")}</button>
        </div>
      </div>
    </TeamDialog>
  );
}
